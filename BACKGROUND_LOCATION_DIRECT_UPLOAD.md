# Native Android background location

Nieuwe endpoint: POST `/user/device-location/`.

Dit endpoint gebruikt geen Django browsersessie. Authenticatie/authorisatie loopt
via de bestaande HardwareAutoLogin `device_uuid` en gekoppelde Django-gebruiker.
De aangeleverde radio_user_id moet aan die gebruiker gekoppeld zijn.

Er is geen nieuwe database-migratie nodig.
