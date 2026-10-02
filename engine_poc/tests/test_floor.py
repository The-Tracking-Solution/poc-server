from django.contrib.auth import get_user_model
from django.test import TestCase
from unittest.mock import patch

from engine_main.models import Tenant
from engine_radio.models import RadioUser, UserProfile
from engine_poc.models import Channel, DeviceSession, FloorWaiter
from engine_poc.services.floor import cancel_floor_waiter, release_floor, request_floor


class FloorControlTests(TestCase):
    def setUp(self):
        self.tenant = Tenant.objects.create(slug="test", name="Test", preemption_hold_ms=3000)
        self.channel = Channel.objects.create(tenant=self.tenant, slug="ops", name="Ops")

    def session(self, slug, priority):
        dj = get_user_model().objects.create_user(username=slug)
        p = RadioUser.objects.create(
            tenant=self.tenant, slug=slug, secret_key_hash="!",
            internal_name=slug, external_name=slug,
        )
        p.django_users.add(dj)
        profile = UserProfile.objects.create(
            tenant=self.tenant, slug=f"{slug}profile", name=slug, ptt_priority=priority
        )
        p.user_profile = profile
        p.save(update_fields=["user_profile", "last_update_ms"])
        s = DeviceSession(tenant=self.tenant, radio_user=p, device_identifier=slug)
        s.issue_token()
        s.save()
        return s

    def test_idle_floor_is_granted(self):
        result = request_floor(
            channel=self.channel, session=self.session("usera", 10),
            emergency=False, client_request_id="a",
        )
        self.assertEqual(result.status, "granted")
        self.assertTrue(result.floor_token)

    def test_repeated_request_by_same_session_rotates_floor_token(self):
        session = self.session("usera", 10)
        first = request_floor(channel=self.channel, session=session, emergency=False, client_request_id="a")
        second = request_floor(channel=self.channel, session=session, emergency=False, client_request_id="b")
        self.assertEqual(second.status, "granted")
        self.assertTrue(second.floor_token)
        self.assertNotEqual(first.floor_token, second.floor_token)

    def test_lower_priority_waits_in_queue(self):
        high = self.session("high", 20)
        low = self.session("low", 10)
        request_floor(channel=self.channel, session=high, emergency=False, client_request_id="a")
        result = request_floor(channel=self.channel, session=low, emergency=False, client_request_id="b")
        self.assertEqual(result.status, "waiting")
        self.assertTrue(FloorWaiter.objects.filter(channel=self.channel, session=low).exists())

    def test_equal_priority_is_fifo_waiting(self):
        first = self.session("first", 10)
        second = self.session("second", 10)
        request_floor(channel=self.channel, session=first, emergency=False, client_request_id="a")
        result = request_floor(channel=self.channel, session=second, emergency=False, client_request_id="b")
        self.assertEqual(result.status, "waiting")

    def test_higher_normal_priority_requires_hold(self):
        low = self.session("low-first", 10)
        high = self.session("high-second", 20)
        with patch("engine_poc.services.floor.now_ms", return_value=1_000_000):
            request_floor(channel=self.channel, session=low, emergency=False, client_request_id="a")
            pending = request_floor(channel=self.channel, session=high, emergency=False, client_request_id="b")
        self.assertEqual(pending.status, "waiting")
        self.assertEqual(pending.required_hold_ms, 3000)
        self.assertGreater(pending.remaining_hold_ms, 0)

        with patch("engine_poc.services.floor.now_ms", return_value=1_003_050):
            granted = request_floor(channel=self.channel, session=high, emergency=False, client_request_id="c")
        self.assertEqual(granted.status, "granted")
        self.assertTrue(granted.floor_token)

    def test_equal_or_lower_priority_never_preempts_during_hold(self):
        owner = self.session("owner-higher", 40)
        equal = self.session("equal", 40)
        lower = self.session("lower", 30)
        with patch("engine_poc.services.floor.now_ms", return_value=2_000_000):
            request_floor(channel=self.channel, session=owner, emergency=False, client_request_id="a")
            equal_pending = request_floor(channel=self.channel, session=equal, emergency=False, client_request_id="b")
            lower_pending = request_floor(channel=self.channel, session=lower, emergency=False, client_request_id="c")
        self.assertEqual(equal_pending.status, "waiting")
        self.assertIsNone(equal_pending.remaining_hold_ms)
        self.assertEqual(lower_pending.status, "waiting")
        self.assertIsNone(lower_pending.remaining_hold_ms)

        # Ook veel later mogen gelijke/lagere prioriteiten de actieve TX niet afbreken.
        with patch("engine_poc.services.floor.now_ms", return_value=2_010_000):
            equal_still_waiting = request_floor(channel=self.channel, session=equal, emergency=False, client_request_id="d")
            lower_still_waiting = request_floor(channel=self.channel, session=lower, emergency=False, client_request_id="e")
        self.assertEqual(equal_still_waiting.status, "waiting")
        self.assertEqual(lower_still_waiting.status, "waiting")

    def test_priority_91_to_99_preempts_immediately_when_higher(self):
        normal = self.session("normal", 40)
        urgent = self.session("urgent", 91)
        request_floor(channel=self.channel, session=normal, emergency=False, client_request_id="a")
        result = request_floor(channel=self.channel, session=urgent, emergency=False, client_request_id="b")
        self.assertEqual(result.status, "granted")
        self.assertEqual(result.effective_priority, 91)

    def test_equal_emergency_waits(self):
        first = self.session("emergency-first", 10)
        second = self.session("emergency-second", 10)
        request_floor(channel=self.channel, session=first, emergency=True, client_request_id="a")
        result = request_floor(channel=self.channel, session=second, emergency=True, client_request_id="b")
        self.assertEqual(result.status, "waiting")

    def test_emergency_99_preempts_immediately(self):
        normal = self.session("normal", 10)
        emergency = self.session("emergency", 1)
        request_floor(channel=self.channel, session=normal, emergency=False, client_request_id="a")
        result = request_floor(channel=self.channel, session=emergency, emergency=True, client_request_id="b")
        self.assertEqual(result.status, "granted")
        self.assertEqual(result.effective_priority, 99)

    def test_release_leaves_waiter_to_claim_next(self):
        owner = self.session("owner", 20)
        waiter = self.session("waiter", 10)
        first = request_floor(channel=self.channel, session=owner, emergency=False, client_request_id="a")
        request_floor(channel=self.channel, session=waiter, emergency=False, client_request_id="b")
        release_floor(
            channel=self.channel, session=owner, floor_token=first.floor_token,
            client_request_id="release-a",
        )
        result = request_floor(channel=self.channel, session=waiter, emergency=False, client_request_id="c")
        self.assertEqual(result.status, "granted")

    def test_ptt_release_cancels_waiter(self):
        owner = self.session("owner", 20)
        waiter = self.session("waiter", 10)
        request_floor(channel=self.channel, session=owner, emergency=False, client_request_id="a")
        request_floor(channel=self.channel, session=waiter, emergency=False, client_request_id="b")
        self.assertTrue(cancel_floor_waiter(channel=self.channel, session=waiter))
        self.assertFalse(FloorWaiter.objects.filter(channel=self.channel, session=waiter).exists())
