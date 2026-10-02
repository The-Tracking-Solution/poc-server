import json
import uuid
from django.conf import settings
from django.contrib.auth import login as auth_login, logout as auth_logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import AuthenticationForm
from django.http import Http404, JsonResponse, HttpResponse
from django.shortcuts import redirect, render
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from engine_dispatch.models import DispatchSession, DispatchUser
from engine_main.identity_claims import RADIO_SESSION_ID_KEY, user_label
from engine_main.models import HardwareAutoLogin
from engine_main.timeutils import now_ms
from engine_poc.models import DeviceSession
from engine_radio.models import RadioUser


HARDWARE_ID_SESSION_KEY = "android_hardware_id"  # legacy
DEVICE_UUID_SESSION_KEY = "android_device_uuid"
ANDROID_ID_SESSION_KEY = "android_secure_id"


def _normalize_device_uuid(value):
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError, TypeError):
        return ""


def _capture_device_identity(request):
    device_uuid = (
        request.headers.get("X-Device-UUID", "")
        or request.GET.get("device_uuid", "")
        or request.POST.get("device_uuid", "")
    )
    legacy_hardware_id = (
        request.headers.get("X-Hardware-ID", "")
        or request.GET.get("hardware_id", "")
        or request.POST.get("hardware_id", "")
    )
    android_id = (
        request.headers.get("X-Android-ID", "")
        or request.GET.get("android_id", "")
        or request.POST.get("android_id", "")
    )
    device_uuid = _normalize_device_uuid(device_uuid)
    legacy_hardware_id = HardwareAutoLogin.normalize_hardware_id(legacy_hardware_id)
    android_id = HardwareAutoLogin.normalize_android_id(android_id)
    if device_uuid:
        request.session[DEVICE_UUID_SESSION_KEY] = device_uuid
        request.session[HARDWARE_ID_SESSION_KEY] = device_uuid
    elif legacy_hardware_id:
        request.session[HARDWARE_ID_SESSION_KEY] = legacy_hardware_id
    if android_id:
        request.session[ANDROID_ID_SESSION_KEY] = android_id
    return device_uuid, android_id, legacy_hardware_id


def _resolve_hardware_mapping(*, device_uuid="", android_id="", legacy_hardware_id="", create_pending=False):
    mapping = None
    base = HardwareAutoLogin.objects.select_related("user")
    if android_id:
        mapping = base.filter(android_id=android_id).order_by("pk").first()
    if mapping is None and device_uuid:
        mapping = base.filter(device_uuid=device_uuid).first()
    if mapping is None and legacy_hardware_id:
        mapping = base.filter(hardware_id=legacy_hardware_id).first()
    if mapping is not None:
        if android_id and not mapping.android_id:
            mapping.android_id = android_id
            mapping.save(update_fields=["android_id", "last_update_ms"])
        return mapping
    if not create_pending:
        return None
    canonical_uuid = _normalize_device_uuid(device_uuid) or str(uuid.uuid4())
    return HardwareAutoLogin.objects.create(
        hardware_id=canonical_uuid,
        device_uuid=canonical_uuid,
        android_id=android_id,
        user=None,
        name="",
        enabled=False,
    )



def _hardware_device_identifier(request):
    """Stable identifier used to reconnect an Android device to its radio."""
    device_uuid = _normalize_device_uuid(request.session.get(DEVICE_UUID_SESSION_KEY, ""))
    if device_uuid:
        return f"android:{device_uuid}"
    android_id = HardwareAutoLogin.normalize_android_id(request.session.get(ANDROID_ID_SESSION_KEY, ""))
    if android_id:
        return f"android-id:{android_id}"
    return ""


def _auto_radio_for_user(request, user):
    """Choose a radio for the logged-in user without ever claiming a busy one.

    Priority:
    1. The radio most recently used by this Django user, if it is currently free.
    2. If exactly one radio assigned to this user is currently free, choose it.

    An active/stale radio is never auto-claimed, even when the active session
    belongs to the same user. This keeps automatic reconnect strictly limited
    to radios that are actually available.
    """
    radio_choices = [choice for choice in _choices(user) if choice["kind"] == "radio"]
    if not radio_choices:
        return None

    by_id = {choice["id"]: choice for choice in radio_choices}
    current_ms = now_ms()

    # Determine availability once. _choice_status also expires timed-out
    # sessions, so a radio becomes eligible as soon as its claim timeout ends.
    free_ids = []
    for choice in radio_choices:
        status = _choice_status(request, choice, current_ms)
        if status["state"] == "free":
            free_ids.append(choice["id"])

    if not free_ids:
        return None

    # Prefer the last radio this *user* used; this intentionally does not depend
    # on the Android hardware id.
    previous = (
        DeviceSession.objects.filter(
            django_user=user,
            radio_user_id__in=list(by_id),
            radio_user__django_users=user,
        )
        .order_by("-connected_at_ms", "-pk")
        .values_list("radio_user_id", flat=True)
        .first()
    )
    if previous and previous in free_ids:
        return by_id[previous]

    # No reusable previous radio: when there is only one free radio available
    # to this user, connect to it automatically.
    if len(free_ids) == 1:
        return by_id[free_ids[0]]

    return None


def _activate_auto_radio(request, user):
    choice = _auto_radio_for_user(request, user)
    if choice is None:
        return None
    return _activate(request, choice)

def _choices(user, tenant_slug=None):
    radios = RadioUser.objects.filter(django_users=user).select_related("tenant")
    dispatchers = DispatchUser.objects.filter(django_users=user).select_related("tenant")
    if tenant_slug:
        radios = radios.filter(tenant__slug=tenant_slug)
        dispatchers = dispatchers.filter(tenant__slug=tenant_slug)
    choices = [
        {
            "kind": "radio", "id": item.pk, "name": item.display_name,
            "tenant": item.tenant, "label": "Radio",
        }
        for item in radios.order_by("tenant__name", "external_name").distinct()
    ]
    choices.extend({
        "kind": "dispatch", "id": item.pk, "name": item.display_name,
        "tenant": item.tenant, "label": "Dispatch",
    } for item in dispatchers.order_by("tenant__name", "external_name").distinct())
    return choices


def _tenants(user):
    tenants = {}
    for choice in _choices(user):
        tenants[choice["tenant"].pk] = choice["tenant"]
    return sorted(tenants.values(), key=lambda tenant: tenant.name.lower())


def _session_state(last_seen_at_ms, current_ms):
    age_ms = max(0, current_ms - int(last_seen_at_ms or 0))
    timeout_ms = int(settings.IDENTITY_CLAIM_TIMEOUT_MS)
    stale_ms = int(settings.IDENTITY_STALE_AFTER_MS)
    if age_ms >= timeout_ms:
        return "free", 0
    if age_ms >= stale_ms:
        return "stale", max(0, timeout_ms - age_ms)
    return "busy", max(0, timeout_ms - age_ms)


def _mark_radio_timed_out(session, current_ms):
    DeviceSession.objects.filter(pk=session.pk, status=DeviceSession.Status.ACTIVE).update(
        status=DeviceSession.Status.TIMED_OUT,
        disconnected_at_ms=current_ms,
        last_update_ms=current_ms,
    )
    RadioUser.objects.filter(pk=session.radio_user_id).update(
        device_status=RadioUser.DeviceStatus.OFFLINE,
        last_update_ms=current_ms,
    )


def _mark_dispatch_timed_out(session, current_ms):
    DispatchSession.objects.filter(pk=session.pk, status=DispatchSession.Status.ACTIVE).update(
        status=DispatchSession.Status.TIMED_OUT,
        released_at_ms=current_ms,
        last_update_ms=current_ms,
    )
    DispatchUser.objects.filter(pk=session.dispatch_user_id).update(
        device_status=DispatchUser.DeviceStatus.OFFLINE,
        last_update_ms=current_ms,
    )


def _choice_status(request, choice, current_ms=None):
    current_ms = current_ms or now_ms()
    if choice["kind"] == "radio":
        session = (
            DeviceSession.objects.select_related("django_user")
            .filter(radio_user_id=choice["id"], status=DeviceSession.Status.ACTIVE)
            .order_by("-connected_at_ms")
            .first()
        )
        if not session:
            return {"state": "free", "occupant": "", "remaining_ms": 0, "selectable": True}
        state, remaining_ms = _session_state(
            max(session.last_heartbeat_at_ms or 0, session.last_seen_at_ms or 0),
            current_ms,
        )
        if state == "free":
            _mark_radio_timed_out(session, current_ms)
            return {"state": "free", "occupant": "", "remaining_ms": 0, "selectable": True}
        occupant = user_label(session.django_user) if session.django_user_id else "Externe verbinding"
        own_session = request.session.get(RADIO_SESSION_ID_KEY) == session.pk
        return {
            "state": state,
            "occupant": occupant,
            "remaining_ms": remaining_ms,
            "selectable": own_session,
        }

    session = (
        DispatchSession.objects.select_related("django_user")
        .filter(dispatch_user_id=choice["id"], status=DispatchSession.Status.ACTIVE)
        .order_by("-claimed_at_ms")
        .first()
    )
    if not session:
        return {"state": "free", "occupant": "", "remaining_ms": 0, "selectable": True}
    state, remaining_ms = _session_state(session.last_seen_at_ms, current_ms)
    if state == "free":
        _mark_dispatch_timed_out(session, current_ms)
        return {"state": "free", "occupant": "", "remaining_ms": 0, "selectable": True}
    own_session = bool(
        request.session.session_key
        and session.session_key == request.session.session_key
        and session.django_user_id == request.user.id
    )
    return {
        "state": state,
        "occupant": user_label(session.django_user),
        "remaining_ms": remaining_ms,
        "selectable": own_session,
    }


def _decorate_choices(request, choices):
    current_ms = now_ms()
    for choice in choices:
        choice["availability"] = _choice_status(request, choice, current_ms)
    return choices, current_ms


def _activate(request, choice):
    tenant_slug = choice["tenant"].slug
    if choice["kind"] == "radio":
        selections = dict(request.session.get("selected_radio_users") or {})
        selections[tenant_slug] = choice["id"]
        request.session["selected_radio_users"] = selections
        destination = "ui_radio:screen"
    else:
        selections = dict(request.session.get("selected_dispatch_users") or {})
        selections[tenant_slug] = choice["id"]
        request.session["selected_dispatch_users"] = selections
        destination = "dispatch:console"
    request.session.modified = True
    return redirect(destination, tenant_slug=tenant_slug)


@login_required
def entry(request):
    auto_response = _activate_auto_radio(request, request.user)
    if auto_response is not None:
        return auto_response
    tenants = _tenants(request.user)
    if len(tenants) == 1:
        return redirect("engine_main:tenant-select", tenant_slug=tenants[0].slug)
    return redirect("engine_main:select")


@login_required
def select_identity(request):
    tenants = _tenants(request.user)
    if len(tenants) == 1:
        return redirect("engine_main:tenant-select", tenant_slug=tenants[0].slug)
    return render(request, "engine_main/select_tenant.html", {"tenants": tenants})


@login_required
def select_tenant_identity(request, tenant_slug):
    choices = _choices(request.user, tenant_slug)
    if not choices:
        raise Http404("Geen identiteit beschikbaar binnen deze tenant.")

    if request.method == "GET" and str(request.GET.get("choose") or "").lower() not in {"1", "true", "yes"}:
        radio_choices = [choice for choice in choices if choice["kind"] == "radio"]
        free_radios = [
            choice for choice in radio_choices
            if _choice_status(request, choice)["state"] == "free"
        ]
        if len(free_radios) == 1:
            return _activate(request, free_radios[0])

    error_message = ""
    if request.method == "POST":
        kind = str(request.POST.get("kind") or "")
        try:
            identity_id = int(request.POST.get("identity_id") or 0)
        except (TypeError, ValueError):
            identity_id = 0
        choice = next((item for item in choices if item["kind"] == kind and item["id"] == identity_id), None)
        if choice is None:
            raise Http404("Deze identiteit is niet aan uw account gekoppeld.")
        status = _choice_status(request, choice)
        if status["state"] == "free" or status["selectable"]:
            return _activate(request, choice)
        error_message = f'{choice["name"]} is in gebruik door {status["occupant"]}.'

    choices, server_now_ms = _decorate_choices(request, choices)
    return render(request, "engine_main/select_identity.html", {
        "identity_choices": choices,
        "selected_tenant": choices[0]["tenant"],
        "multiple_tenants": len(_tenants(request.user)) > 1,
        "server_now_ms": server_now_ms,
        "identity_claim_timeout_ms": settings.IDENTITY_CLAIM_TIMEOUT_MS,
        "error_message": error_message,
    }, status=409 if error_message else 200)


@login_required
@require_GET
def identity_status(request, tenant_slug):
    choices = _choices(request.user, tenant_slug)
    if not choices:
        raise Http404("Geen identiteit beschikbaar binnen deze tenant.")
    choices, server_now_ms = _decorate_choices(request, choices)
    return JsonResponse({
        "server_now_ms": server_now_ms,
        "claim_timeout_ms": settings.IDENTITY_CLAIM_TIMEOUT_MS,
        "items": [
            {
                "kind": choice["kind"],
                "id": choice["id"],
                **choice["availability"],
            }
            for choice in choices
        ],
    })


@require_GET
def root_entry(request):
    """Publieke landing voor browser en Android.

    Android opent uitsluitend ``/`` en stuurt zijn device-identiteit als query
    parameters mee. Hier slaan we die identiteit eerst in de sessie op, voordat
    er naar login/radio/dispatch wordt doorgestuurd.
    """
    device_uuid, android_id, legacy_hardware_id = _capture_device_identity(request)

    if device_uuid or android_id or legacy_hardware_id:
        mapping = _resolve_hardware_mapping(
            device_uuid=device_uuid,
            android_id=android_id,
            legacy_hardware_id=legacy_hardware_id,
            create_pending=True,
        )
        canonical_uuid = str(mapping.device_uuid)
        request.session[DEVICE_UUID_SESSION_KEY] = canonical_uuid
        request.session[HARDWARE_ID_SESSION_KEY] = canonical_uuid
        if mapping.android_id:
            request.session[ANDROID_ID_SESSION_KEY] = mapping.android_id

        if mapping.enabled and mapping.user_id and mapping.user.is_active:
            auth_login(request, mapping.user, backend="django.contrib.auth.backends.ModelBackend")
            current_ms = now_ms()
            HardwareAutoLogin.objects.filter(pk=mapping.pk).update(
                last_login_at_ms=current_ms,
                last_update_ms=current_ms,
            )
            auto_response = _activate_auto_radio(request, mapping.user)
            if auto_response is not None:
                return auto_response
            return redirect("engine_main:entry")

    if request.user.is_authenticated:
        return redirect("engine_main:entry")
    return redirect("engine_main:login")


@ensure_csrf_cookie
def login(request):
    next_url = str(request.POST.get("next") or request.GET.get("next") or "").strip()
    if not url_has_allowed_host_and_scheme(
        next_url, allowed_hosts={request.get_host()}, require_https=request.is_secure()
    ):
        next_url = ""

    _capture_device_identity(request)
    device_uuid = _normalize_device_uuid(request.session.get(DEVICE_UUID_SESSION_KEY, ""))
    hardware_id = HardwareAutoLogin.normalize_hardware_id(
        request.session.get(HARDWARE_ID_SESSION_KEY, "")
    )
    hardware_short_code = HardwareAutoLogin.short_code_for_hardware_id(
        device_uuid.replace("-", "") if device_uuid else hardware_id
    )

    if request.user.is_authenticated:
        return redirect(next_url or "engine_main:entry")

    # Login-prioriteit:
    # 1. Zodra username of password is ingevuld gebruiken we altijd de normale
    #    Django gebruikerslogin.
    # 2. Zijn beide velden leeg en kennen we dit Android-device, dan is de
    #    submitknop een expliciete device-login poging. Het admin-vinkje
    #    ``enabled`` bepaalt alleen of root_entry deze stap automatisch mag
    #    overslaan; een bewuste klik op Inloggen blijft dus toegestaan.
    posted_username = str(request.POST.get("username") or "")
    posted_password = str(request.POST.get("password") or "")
    has_user_credentials = bool(posted_username.strip() or posted_password)
    device_login_error = ""

    if request.method == "POST" and not has_user_credentials and (device_uuid or hardware_id):
        android_id = str(request.session.get(ANDROID_ID_SESSION_KEY, "") or "").strip()
        mapping = _resolve_hardware_mapping(
            device_uuid=device_uuid,
            android_id=android_id,
            legacy_hardware_id=hardware_id,
            create_pending=True,
        )
        if mapping.user_id and mapping.user.is_active:
            auth_login(
                request,
                mapping.user,
                backend="django.contrib.auth.backends.ModelBackend",
            )
            current_ms = now_ms()
            HardwareAutoLogin.objects.filter(pk=mapping.pk).update(
                last_login_at_ms=current_ms,
                last_update_ms=current_ms,
            )
            auto_response = _activate_auto_radio(request, mapping.user)
            if auto_response is not None:
                return auto_response
            return redirect(next_url or "engine_main:entry")
        device_login_error = "Deze Device ID is nog niet aan een actieve gebruiker gekoppeld."

    form = AuthenticationForm(
        request=request,
        data=(
            request.POST
            if request.method == "POST" and (has_user_credentials or not hardware_short_code)
            else None
        ),
    )
    if request.method == "POST" and has_user_credentials and form.is_valid():
        auth_login(request, form.get_user())
        return redirect(next_url or "engine_main:entry")

    return render(
        request,
        "engine_main/login.html",
        {
            "form": form,
            "next": next_url,
            "hardware_id": hardware_id,
            "device_uuid": device_uuid,
            "hardware_short_code": hardware_short_code,
            "login_mode": "device" if hardware_short_code and not has_user_credentials else "user",
            "device_login_error": device_login_error,
        },
    )


@require_POST
def logout(request):
    auth_logout(request)
    return redirect("engine_main:login")


@require_GET
def app_logout(request):
    """Native Android exit endpoint: terminate the Django session before closing."""
    auth_logout(request)
    return HttpResponse("OK", content_type="text/plain")


@require_GET
def hardware_device_login(request):
    """Browser-entrypoint voor Android hardware auto-login."""
    device_uuid, android_id, legacy_hardware_id = _capture_device_identity(request)
    mapping = _resolve_hardware_mapping(
        device_uuid=device_uuid,
        android_id=android_id,
        legacy_hardware_id=legacy_hardware_id,
        create_pending=True,
    )
    canonical_uuid = str(mapping.device_uuid)
    request.session[DEVICE_UUID_SESSION_KEY] = canonical_uuid
    request.session[HARDWARE_ID_SESSION_KEY] = canonical_uuid
    if mapping.android_id:
        request.session[ANDROID_ID_SESSION_KEY] = mapping.android_id

    next_url = str(request.GET.get("next") or "").strip()
    if not url_has_allowed_host_and_scheme(
        next_url, allowed_hosts={request.get_host()}, require_https=request.is_secure()
    ):
        next_url = ""

    if mapping.enabled and mapping.user_id and mapping.user.is_active:
        auth_login(request, mapping.user, backend="django.contrib.auth.backends.ModelBackend")
        current_ms = now_ms()
        HardwareAutoLogin.objects.filter(pk=mapping.pk).update(
            last_login_at_ms=current_ms,
            last_update_ms=current_ms,
        )
        auto_response = _activate_auto_radio(request, mapping.user)
        if auto_response is not None:
            return auto_response
        return redirect(next_url or "engine_main:entry")

    login_url = "/user/login/"
    if next_url:
        from urllib.parse import urlencode
        login_url += "?" + urlencode({"next": next_url})
    return redirect(login_url)


@csrf_exempt
@require_POST
def hardware_device_location(request):
    """Ontvang achtergrond-GPS rechtstreeks vanuit de Android foreground service.

    Deze call heeft bewust geen browsercookie nodig. Het device moet wel als
    actieve HardwareAutoLogin gekoppeld zijn aan de Django-gebruiker die toegang
    heeft tot de opgegeven radio. Alleen een actieve radiosessie accepteert GPS.
    """
    try:
        body = json.loads(request.body.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"ok": False, "error": "invalid_json"}, status=400)

    device_uuid = _normalize_device_uuid(
        request.headers.get("X-Device-UUID", "") or body.get("device_uuid", "")
    )
    android_id = HardwareAutoLogin.normalize_android_id(
        request.headers.get("X-Android-ID", "") or body.get("android_id", "")
    )
    if not (device_uuid or android_id):
        return JsonResponse({"ok": False, "error": "device_identity_required"}, status=400)

    mapping = _resolve_hardware_mapping(
        device_uuid=device_uuid,
        android_id=android_id,
        create_pending=False,
    )
    if mapping is None or not mapping.enabled or not mapping.user_id or not mapping.user.is_active:
        return JsonResponse({"ok": False, "error": "hardware_not_authorized"}, status=403)

    try:
        radio_user_id = int(body.get("radio_user_id") or 0)
        latitude = float(body["latitude"])
        longitude = float(body["longitude"])
        accuracy_m = float(body["accuracy_m"])
        timestamp_ms = int(body.get("timestamp_ms") or now_ms())
    except (KeyError, TypeError, ValueError):
        return JsonResponse({"ok": False, "error": "invalid_location_payload"}, status=400)

    tenant_slug = str(body.get("tenant_slug") or "").strip()
    radio_query = RadioUser.objects.filter(pk=radio_user_id, django_users=mapping.user).select_related("tenant")
    if tenant_slug:
        radio_query = radio_query.filter(tenant__slug=tenant_slug)
    radio = radio_query.first()
    if radio is None:
        return JsonResponse({"ok": False, "error": "radio_not_authorized"}, status=403)

    session = (
        DeviceSession.objects.select_related("tenant", "radio_user", "radio_user__current_channel")
        .filter(
            radio_user=radio,
            django_user=mapping.user,
            status=DeviceSession.Status.ACTIVE,
        )
        .order_by("-connected_at_ms")
        .first()
    )
    if session is None:
        return JsonResponse({"ok": False, "error": "radio_session_not_active"}, status=409)

    from engine_poc.services.location import process_location_sample
    try:
        result = process_location_sample(
            session=session,
            latitude=latitude,
            longitude=longitude,
            accuracy_m=accuracy_m,
            timestamp_ms=timestamp_ms,
            source=str(body.get("source") or "android-background"),
        )
    except PermissionError as exc:
        return JsonResponse({"ok": False, "error": "location_disabled", "detail": str(exc)}, status=403)
    except (TypeError, ValueError) as exc:
        return JsonResponse({"ok": False, "error": "invalid_location", "detail": str(exc)}, status=400)

    return JsonResponse({"ok": True, **result})


@csrf_exempt
@require_POST
def hardware_auto_login(request):
    """JSON/form API variant van hardware auto-login."""
    content_type = str(request.content_type or "").lower()
    body = {}
    if "application/json" in content_type:
        try:
            import json
            body = json.loads(request.body.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            body = {}

    device_uuid = _normalize_device_uuid(
        request.headers.get("X-Device-UUID", "")
        or body.get("device_uuid", "")
        or request.POST.get("device_uuid", "")
    )
    android_id = HardwareAutoLogin.normalize_android_id(
        request.headers.get("X-Android-ID", "")
        or body.get("android_id", "")
        or request.POST.get("android_id", "")
    )
    legacy_hardware_id = HardwareAutoLogin.normalize_hardware_id(
        request.headers.get("X-Hardware-ID", "")
        or body.get("hardware_id", "")
        or request.POST.get("hardware_id", "")
    )
    if not (device_uuid or android_id or legacy_hardware_id):
        return JsonResponse({"ok": False, "error": "device_identity_required"}, status=400)

    mapping = _resolve_hardware_mapping(
        device_uuid=device_uuid,
        android_id=android_id,
        legacy_hardware_id=legacy_hardware_id,
        create_pending=True,
    )
    canonical_uuid = str(mapping.device_uuid)
    request.session[DEVICE_UUID_SESSION_KEY] = canonical_uuid
    request.session[HARDWARE_ID_SESSION_KEY] = canonical_uuid
    if android_id:
        request.session[ANDROID_ID_SESSION_KEY] = android_id

    if not (mapping.enabled and mapping.user_id and mapping.user.is_active):
        return JsonResponse({
            "ok": False,
            "error": "hardware_not_authorized",
            "device_uuid": canonical_uuid,
            "device_code": mapping.short_code,
        }, status=403)

    auth_login(request, mapping.user, backend="django.contrib.auth.backends.ModelBackend")
    current_ms = now_ms()
    HardwareAutoLogin.objects.filter(pk=mapping.pk).update(
        last_login_at_ms=current_ms,
        last_update_ms=current_ms,
    )

    next_url = str(request.POST.get("next") or request.GET.get("next") or body.get("next") or "").strip()
    if not url_has_allowed_host_and_scheme(
        next_url, allowed_hosts={request.get_host()}, require_https=request.is_secure()
    ):
        next_url = ""
    destination = next_url or "/user/"
    return JsonResponse({
        "ok": True,
        "user": mapping.user.get_username(),
        "device_uuid": canonical_uuid,
        "device_code": mapping.short_code,
        "next": destination,
    })
