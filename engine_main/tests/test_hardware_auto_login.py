import json
import uuid

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from engine_main.models import HardwareAutoLogin


class HardwareAutoLoginTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="android", password="unused")
        self.device_uuid = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
        self.mapping = HardwareAutoLogin.objects.create(
            hardware_id="abc-123",
            device_uuid=self.device_uuid,
            android_id="android-secure-1",
            name="Test radio",
            user=self.user,
            enabled=True,
        )
        self.url = reverse("engine_main:hardware-auto-login")
        self.device_login_url = reverse("engine_main:hardware-device-login")

    def test_short_code_property_uses_device_uuid(self):
        self.assertEqual(self.mapping.short_code, "550e-0000")

    def test_legacy_header_hardware_id_logs_user_in(self):
        response = self.client.post(self.url, HTTP_X_HARDWARE_ID="abc-123")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.user.pk)

    def test_json_device_uuid_logs_user_in(self):
        response = self.client.post(
            self.url,
            data=json.dumps({
                "device_uuid": str(self.device_uuid),
                "android_id": "android-secure-1",
                "next": "/user/",
            }),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["next"], "/user/")
        self.assertEqual(response.json()["device_code"], "550e-0000")

    def test_unknown_device_creates_pending_record_and_login_shows_short_code(self):
        unknown = "11111111-2222-4333-8444-555555555555"
        response = self.client.get(
            self.device_login_url,
            {"device_uuid": unknown, "android_id": "unknown-android", "next": "/radio/test/"},
        )
        self.assertEqual(response.status_code, 302)
        pending = HardwareAutoLogin.objects.get(android_id="unknown-android")
        self.assertIsNone(pending.user_id)
        self.assertFalse(pending.enabled)
        self.assertEqual(str(pending.device_uuid), unknown)
        login_response = self.client.get(reverse("engine_main:login"))
        self.assertContains(login_response, "1111-5555")

    def test_reinstall_new_local_uuid_recovers_mapping_by_android_id(self):
        new_local_uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        response = self.client.get(
            self.device_login_url,
            {
                "device_uuid": new_local_uuid,
                "android_id": "android-secure-1",
                "next": "/user/",
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], "/user/")
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.user.pk)
        self.mapping.refresh_from_db()
        self.assertEqual(str(self.mapping.device_uuid), str(self.device_uuid))

    def test_disabled_mapping_is_rejected(self):
        self.mapping.enabled = False
        self.mapping.save(update_fields=["enabled", "last_update_ms"])
        response = self.client.post(
            self.url,
            data=json.dumps({"device_uuid": str(self.device_uuid), "android_id": "android-secure-1"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
