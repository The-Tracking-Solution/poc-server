from django.urls import path

from . import views

app_name = "ui_radio"

urlpatterns = [
    path("", views.index, name="index"),
    path("<slug:tenant_slug>/", views.screen, name="screen"),
    path("<slug:tenant_slug>/api/bootstrap/", views.bootstrap, name="bootstrap"),
    path("<slug:tenant_slug>/api/webrtc/token/", views.webrtc_token, name="webrtc-token"),
    path("<slug:tenant_slug>/api/heartbeat/", views.heartbeat, name="heartbeat"),
    path("<slug:tenant_slug>/api/location/", views.update_location, name="location"),
    path("<slug:tenant_slug>/api/state/", views.state, name="state"),
    path("<slug:tenant_slug>/api/channel-presence/", views.channel_presence, name="channel-presence"),
    path("<slug:tenant_slug>/api/channel/<slug:channel_slug>/select/", views.select_channel, name="select-channel"),
    path("<slug:tenant_slug>/api/channel/move/", views.move_channel, name="move-channel"),
    path("<slug:tenant_slug>/api/status/select/", views.select_status, name="select-status"),
    path("<slug:tenant_slug>/api/emergency/cancel/", views.cancel_emergency, name="cancel-emergency"),
    path("<slug:tenant_slug>/api/ptt/start/", views.ptt_start, name="ptt-start"),
    path("<slug:tenant_slug>/api/ptt/heartbeat/", views.ptt_heartbeat, name="ptt-heartbeat"),
    path("<slug:tenant_slug>/api/ptt/stop/", views.ptt_stop, name="ptt-stop"),
    path("<slug:tenant_slug>/api/parrot/start/", views.parrot_start, name="parrot-start"),
    path("<slug:tenant_slug>/api/parrot/stop/", views.parrot_stop, name="parrot-stop"),
]
