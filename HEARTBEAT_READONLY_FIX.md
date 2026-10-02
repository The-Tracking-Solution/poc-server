# Heartbeat read-only fix

De 5s radio heartbeat mag geen kanaalhandover, control-WebSocket rebuild of LiveKit reconnect uitvoeren.

Wijziging:
- `synchronizeChannel(data)` verwijderd uit de 5s heartbeat callback.
- defensieve `source === "heartbeat"` guard toegevoegd aan `synchronizeChannel`.
- kanaalwissels blijven via expliciete select/move/config flows lopen.
- static cacheversie verhoogd.
