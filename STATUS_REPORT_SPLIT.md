# Heartbeat / status-report split

## Iedere 5 seconden: /api/heartbeat/
Compact operationeel bericht:
- control
- media
- tx
- rx
- rtt_ms
- network

Server-side blijft kanaal, radio-identiteit, tenant en gebruikersstatus uit de eigen database komen en worden daarom niet door de radio teruggestuurd.

Als `tx` expliciet false is terwijl deze DeviceSession server-side nog een actieve PTT-floor heeft, wordt die floor na een korte 2,5s grant-grace vrijgegeven met reason `heartbeat_tx_inactive`. Socket/PTT-stop blijft de primaire release.

## Iedere 60 seconden: /api/status-report/
Diagnostiek die de server niet zelf kan weten:
- transport/provider/codec
- sample count
- jitter
- RX/TX packet loss
- RX/TX bitrate
- concealment delta's
- jitterbuffer statistieken
- remote audio track / audio element diagnostiek
- active remote participant
- native reason indien aanwezig
- Android audio diagnostics indien aanwezig

Het status-report houdt de sessie nadrukkelijk niet in leven. Alleen de 5s heartbeat is het liveness-signaal.
