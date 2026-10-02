from django.urls import path
from engine_poc.consumers import ChannelControlConsumer, MapLocationConsumer

websocket_urlpatterns = [
    path("poc/ws/v1/control/<slug:tenant_slug>/<slug:channel_slug>/", ChannelControlConsumer.as_asgi()),
    path("poc/ws/v1/map/<slug:tenant_slug>/", MapLocationConsumer.as_asgi()),
]
