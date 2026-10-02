import django.db.models.deletion
from django.db import migrations, models

import engine_main.timeutils
import engine_poc.timeutils


class Migration(migrations.Migration):
    dependencies = [("engine_poc", "0001_initial"), ("engine_radio", "0001_initial"), ("engine_dispatch", "0001_initial")]

    operations = [
        migrations.CreateModel(
            name="DeviceSession",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("session_token_hash", models.CharField(editable=False, max_length=256)),
                ("device_identifier", models.CharField(max_length=200, verbose_name="Apparaat-ID")),
                ("status", models.CharField(choices=[("active","Actief"),("revoked","Ingetrokken"),("disconnected","Verbinding verbroken"),("timed_out","Time-out")], default="active", max_length=20, verbose_name="Status")),
                ("connected_at_ms", models.BigIntegerField(default=engine_poc.timeutils.now_ms, verbose_name="Verbonden op (ms)")),
                ("disconnected_at_ms", models.BigIntegerField(blank=True, null=True, verbose_name="Verbroken op (ms)")),
                ("last_seen_at_ms", models.BigIntegerField(default=engine_poc.timeutils.now_ms, verbose_name="Laatst gezien (ms)")),
                ("last_heartbeat_at_ms", models.BigIntegerField(blank=True, null=True, verbose_name="Laatste heartbeat (ms)")),
                ("last_roundtrip_ms", models.PositiveIntegerField(blank=True, null=True, verbose_name="Laatste roundtrip (ms)")),
                ("average_roundtrip_ms", models.FloatField(blank=True, null=True, verbose_name="Gemiddelde roundtrip (ms)")),
                ("heartbeat_samples", models.PositiveIntegerField(default=0, verbose_name="Heartbeatmetingen")),
                ("missed_heartbeats", models.PositiveIntegerField(default=0, verbose_name="Gemiste heartbeats")),
                ("telemetry", models.JSONField(blank=True, default=dict, help_text="Geaggregeerde metingen ontvangen sinds de vorige heartbeat.", verbose_name="Laatste heartbeattelemetrie")),
                ("current_channel", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, to="engine_poc.channel", verbose_name="Huidig kanaal")),
                ("dispatch_user", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="device_sessions", to="engine_dispatch.dispatchuser", verbose_name="Dispatcher")),
                ("radio_user", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="sessions", to="engine_radio.radiouser", verbose_name="Radio")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["-connected_at_ms"],"verbose_name":"Apparaatsessie","verbose_name_plural":"Apparaatsessies"},
        ),
        migrations.AddConstraint(model_name="devicesession", constraint=models.CheckConstraint(condition=models.Q(models.Q(("dispatch_user__isnull", True), ("radio_user__isnull", False)), models.Q(("dispatch_user__isnull", False), ("radio_user__isnull", True)), _connector="OR"), name="device_session_exactly_one_actor")),
        migrations.AddConstraint(model_name="devicesession", constraint=models.UniqueConstraint(condition=models.Q(("radio_user__isnull", False), ("status","active")), fields=("radio_user",), name="one_active_session_per_radio_user")),
        migrations.AddConstraint(model_name="devicesession", constraint=models.UniqueConstraint(condition=models.Q(("dispatch_user__isnull", False), ("status","active")), fields=("dispatch_user",), name="one_active_device_session_per_dispatch_user")),
        migrations.CreateModel(
            name="ChannelState",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("floor_status", models.CharField(choices=[("idle","Vrij"),("active","Actief"),("preemption_pending","Overname in afwachting"),("emergency","Noodoproep")], default="idle", max_length=32, verbose_name="Floorstatus")),
                ("active_user_slug", models.CharField(blank=True, default="", max_length=64, verbose_name="Actieve gebruiker (slug)")),
                ("active_user_name", models.CharField(blank=True, default="", max_length=200, verbose_name="Actieve gebruiker")),
                ("active_priority", models.PositiveSmallIntegerField(blank=True, null=True, verbose_name="Actieve prioriteit")),
                ("active_event_sequence", models.PositiveBigIntegerField(blank=True, db_index=True, null=True, verbose_name="Actieve eventreeks")),
                ("floor_token_hash", models.CharField(blank=True, default="", max_length=256)),
                ("granted_at_ms", models.BigIntegerField(blank=True, null=True, verbose_name="Toegekend op (ms)")),
                ("pending_user_slug", models.CharField(blank=True, default="", max_length=64, verbose_name="Wachtende gebruiker (slug)")),
                ("pending_user_name", models.CharField(blank=True, default="", max_length=200, verbose_name="Wachtende gebruiker")),
                ("pending_priority", models.PositiveSmallIntegerField(blank=True, null=True, verbose_name="Wachtende prioriteit")),
                ("pending_since_ms", models.BigIntegerField(blank=True, null=True, verbose_name="Wacht sinds (ms)")),
                ("active_session", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="active_floors", to="engine_poc.devicesession", verbose_name="Actieve sessie")),
                ("channel", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="state", to="engine_poc.channel", verbose_name="Kanaal")),
                ("emergency_users", models.ManyToManyField(blank=True, related_name="emergency_channel_states", to="engine_radio.radiouser", verbose_name="Radio's met noodoproep")),
                ("pending_session", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="pending_floors", to="engine_poc.devicesession", verbose_name="Wachtende sessie")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["tenant__name","channel__name"],"verbose_name":"Kanaalstatus","verbose_name_plural":"Kanaalstatussen"},
        ),
        migrations.AddConstraint(model_name="channelstate", constraint=models.UniqueConstraint(fields=("tenant","channel"), name="channel_state_tenant_channel_uq")),
        migrations.CreateModel(
            name="CallRequest",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("priority", models.PositiveSmallIntegerField(choices=[(1,"1"),(2,"2"),(3,"3"),(4,"4"),(5,"5")])),
                ("status", models.CharField(choices=[("active","Actief"),("cleared","Beëindigd")], default="active", max_length=16)),
                ("activated_at_ms", models.BigIntegerField(default=engine_poc.timeutils.now_ms)),
                ("cleared_at_ms", models.BigIntegerField(blank=True, null=True)),
                ("accepted_at_ms", models.BigIntegerField(blank=True, null=True)),
                ("clear_reason", models.CharField(blank=True, default="", max_length=64)),
                ("channel", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="call_requests", to="engine_poc.channel")),
                ("radio_user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="call_requests", to="engine_radio.radiouser")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="call_requests", to="engine_main.tenant")),
            ],
            options={"ordering":["-activated_at_ms"],"verbose_name":"Call request","verbose_name_plural":"Call requests"},
        ),
        migrations.CreateModel(
            name="ChannelPresence",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("connection_id", models.CharField(max_length=255, unique=True)),
                ("role", models.CharField(choices=[("radio","Radio"),("dispatch","Dispatcher")], max_length=16)),
                ("listening", models.BooleanField(default=True)),
                ("channel", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="channel_presences", to="engine_poc.channel")),
                ("session", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="channel_presences", to="engine_poc.devicesession")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="channel_presences", to="engine_main.tenant")),
            ],
        ),
        migrations.AddIndex(model_name="channelpresence", index=models.Index(fields=["tenant","channel","role","listening"], name="engine_poc_a_tenant__index")),
    ]
