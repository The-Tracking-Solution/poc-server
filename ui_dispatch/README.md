# Dispatch

De tenantgebonden dispatchconsole is beschikbaar via:

- `/dispatch/` – opent de eerste toegankelijke tenant;
- `/dispatch/<tenant-slug>/` – opent een specifieke toegankelijke tenant.

Inloggen is verplicht. Superusers hebben toegang tot alle tenants. Een gewone
gebruiker heeft alleen toegang tot tenants waaraan diens radio-account is
gekoppeld.

Deze eerste versie integreert de aangeleverde GUI-basis. Het oude realtime
WebRTC-protocol uit het bronbestand wordt niet automatisch gestart, omdat de
POC-engine een ander, beveiligd PCM-audioprotocol met server-side
zendvloerbeheer gebruikt.
