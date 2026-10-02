# Radio session-token stability fix

`ui_radio.views._session()` roteerde voorheen bij iedere HTTP-call het
`DeviceSession.session_token_hash`. Omdat `heartbeat/` en `channel-presence/`
om de 5 seconden lopen, kon een geldige control-WebSocket of een net verkregen
bootstrap-token direct verouderd raken.

De bestaande token uit de Django-sessie wordt nu hergebruikt zolang deze nog
tegen `session_token_hash` valideert. Alleen als de token ontbreekt of ongeldig
is wordt een nieuwe token uitgegeven.

Hierdoor kunnen heartbeat, presence, WebRTC-token requests en control-WebSocket
naast elkaar werken zonder elkaar iedere 5 seconden te invalideren.
