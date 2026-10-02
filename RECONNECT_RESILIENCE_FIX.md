# Reconnect resilience fix

- Retry scheduling is now performed after `reconnectInFlight` is released, so failed bootstrap attempts cannot terminate the retry chain.
- A control WebSocket open timeout forces a new fresh-bootstrap reconnect instead of hanging indefinitely in CONNECTING.
- Existing LiveKit media objects receive the latest bootstrap `access_token`, `session_id`, token URL and bitrate after server restart.
- Returning to the foreground / focus immediately kicks reconnect when the connection is still lost.
- Existing PTT, channel handover, master volume, dispatch GUI and test-clock functionality are unchanged.
