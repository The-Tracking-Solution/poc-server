from django.db import migrations


# Historisch was deze migration een data-seed met update_or_create().
# Dat is bewust verwijderd: migrations mogen beheerder-configuratie niet
# terugzetten naar release-defaults. De initiële defaults worden voortaan
# uitsluitend door `preload_if_empty` geladen wanneer de applicatie-DB leeg is.
class Migration(migrations.Migration):
    dependencies = [
        ("engine_radio", "0002_hardware_to_hardware_config"),
    ]

    operations = []
