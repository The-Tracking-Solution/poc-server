from django.urls import include, path
from rest_framework.routers import SimpleRouter
from engine_poc.views import (
    HardwareConfigViewSet, TenantViewSet, RadioUserViewSet, UserProfileViewSet, HardwareProfileViewSet,
    ChannelViewSet, UserStatusViewSet, DeviceSessionListView, EventListView,
    EventDetailView, EventAttachmentListView, EventAttachmentContentView, SessionLoginView, HeartbeatView, LocationUpdateView, WebRTCTokenView, LiveStatusView,
)

tenant_router = SimpleRouter()
tenant_router.register("tenants", TenantViewSet, basename="tenant")
tenant_router.register("hardware-config", HardwareConfigViewSet, basename="hardware-config")

user_router = SimpleRouter()
user_router.register("users", RadioUserViewSet, basename="tenant-user")
user_router.register("user-profiles", UserProfileViewSet, basename="tenant-profile")
user_router.register("hardware-profiles", HardwareProfileViewSet, basename="tenant-hardware")
user_router.register("channels", ChannelViewSet, basename="tenant-channel")
user_router.register("user-statuses", UserStatusViewSet, basename="tenant-status")

urlpatterns = [
    path("", include(tenant_router.urls)),
    path("auth/session/", SessionLoginView.as_view(), name="session-login"),
    path("session/heartbeat/", HeartbeatView.as_view(), name="session-heartbeat"),
    path("location/", LocationUpdateView.as_view(), name="location-update"),
    path("webrtc/token/", WebRTCTokenView.as_view(), name="webrtc-token"),
    path("tenants/<slug:tenant_slug>/", include(user_router.urls)),
    path("tenants/<slug:tenant_slug>/device-sessions/", DeviceSessionListView.as_view(), name="device-session-list"),
    path("tenants/<slug:tenant_slug>/events/", EventListView.as_view(), name="event-list"),
    path("tenants/<slug:tenant_slug>/events/<int:event_id>/", EventDetailView.as_view(), name="event-detail"),
    path("tenants/<slug:tenant_slug>/events/<int:event_id>/attachments/", EventAttachmentListView.as_view(), name="event-attachment-list"),
    path("tenants/<slug:tenant_slug>/events/<int:event_id>/attachments/<int:attachment_id>/content/", EventAttachmentContentView.as_view(), name="event-attachment-content"),
    path("tenants/<slug:tenant_slug>/live-status/", LiveStatusView.as_view(), name="live-status"),
]
