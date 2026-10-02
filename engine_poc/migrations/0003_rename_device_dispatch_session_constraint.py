from django.db import migrations


class Migration(migrations.Migration):
    """Compatibility marker.

    The duplicate DeviceSession constraint name was corrected directly in
    0002_radio_relations for clean installations. No database operation is
    required here.
    """

    dependencies = [("engine_poc", "0002_radio_relations")]
    operations = []
