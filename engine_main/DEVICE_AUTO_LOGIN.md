# HardwareAutoLogin device identity

`HardwareAutoLogin.device_uuid` is de canonical UUID4 van het toestel.
`HardwareAutoLogin.android_id` is uitsluitend een herstelkenmerk voor Android re-installs.

Nieuwe onbekende Android devices worden automatisch als pending record aangemaakt met `user = NULL` en `enabled = False`. Koppel in Django admin een gebruiker en zet `enabled` aan. Daarna logt het toestel bij de volgende start automatisch in.

Op het login-scherm wordt nooit de volledige UUID getoond; alleen `xxxx-yyyy` (eerste 4 + laatste 4 van UUID hex).
