import django.db.models.deletion
from django.db import migrations, models

import engine_main.timeutils
import engine_main.validators
import engine_poc.timeutils


class Migration(migrations.Migration):
    initial = True
    dependencies = [("engine_main", "0001_initial")]

    operations = [
        migrations.CreateModel(
            name="UserStatus",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("slug", models.CharField(max_length=64, validators=[engine_main.validators.validate_engine_slug], verbose_name="Technische naam")),
                ("label_short", models.CharField(max_length=100, verbose_name="Kort label")),
                ("label_long", models.CharField(max_length=200, verbose_name="Lang label")),
                ("call_request_priority", models.PositiveSmallIntegerField(blank=True, choices=[(1,"1"),(2,"2"),(3,"3"),(4,"4"),(5,"5")], default=None, null=True, verbose_name="Call request priority")),
                ("system_status", models.PositiveSmallIntegerField(blank=True, choices=[(0,"Noodsignaal"),(1,"Eigen initiatief"),(2,"Aanvraag spraak"),(3,"Informatievraag"),(4,"Aanrijdend naar incident"),(5,"Ter plaatse"),(6,"Aanrijdend naar bestemming"),(7,"Binnenkort beschikbaar"),(8,"Beschikbaar, Niet op standplaats"),(9,"Op standplaats"),(10,"Vertraagd inzetbaar"),(11,"Buiten dienst"),(12,"Binnenkort in dienst"),(13,"Aanvraag privégesprek"),(14,"Aanvraag spraak urgent"),(15,"Opdracht verstrekt"),(16,"Alarmering ontvangen")], null=True, verbose_name="Systeemstatus")),
                ("display_code", models.CharField(blank=True, default="", max_length=32, verbose_name="Displaycode")),
                ("display_status", models.CharField(blank=True, default="", max_length=200, verbose_name="Displaystatus")),
                ("display_label", models.CharField(blank=True, default="", max_length=200, verbose_name="Displaylabel")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["tenant__name","system_status","display_code"],"verbose_name":"Gebruikersstatus","verbose_name_plural":"Gebruikersstatussen"},
        ),
        migrations.AddConstraint(model_name="userstatus", constraint=models.UniqueConstraint(fields=("tenant","slug"), name="engine_poc_userstatus_tenant_slug_uq")),
        migrations.AddConstraint(model_name="userstatus", constraint=models.UniqueConstraint(condition=models.Q(("system_status__isnull", False)), fields=("tenant","system_status"), name="engine_poc_userstatus_tenant_system_status_uq")),
        migrations.CreateModel(
            name="Channel",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("slug", models.CharField(max_length=64, validators=[engine_main.validators.validate_engine_slug], verbose_name="Technische naam")),
                ("name", models.CharField(max_length=200, verbose_name="Naam")),
                ("status", models.CharField(choices=[("active","Actief"),("inactive","Inactief")], default="active", max_length=16, verbose_name="Status")),
                ("channel_type", models.CharField(choices=[("group","Groep"),("echo","Echo")], default="group", max_length=16, verbose_name="Kanaaltype")),
                ("max_ptt_duration_ms", models.PositiveIntegerField(blank=True, null=True, verbose_name="Maximale PTT-duur (ms)")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["tenant__name","name"],"verbose_name":"Kanaal","verbose_name_plural":"Kanalen"},
        ),
        migrations.AddConstraint(model_name="channel", constraint=models.UniqueConstraint(fields=("tenant","slug"), name="engine_poc_channel_tenant_slug_uq")),
        migrations.CreateModel(
            name="EventLog",
            fields=[
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("sequence_number", models.BigAutoField(primary_key=True, serialize=False, verbose_name="Volgnummer")),
                ("timestamp_ms", models.BigIntegerField(db_index=True, default=engine_poc.timeutils.now_ms, verbose_name="Tijdstip (ms)")),
                ("client_request_id", models.CharField(blank=True, max_length=200, null=True, verbose_name="Client-request-ID")),
                ("tenant_slug_snapshot", models.CharField(max_length=64, verbose_name="Tenant-slug")),
                ("tenant_name_snapshot", models.CharField(max_length=200, verbose_name="Tenantnaam")),
                ("actor_slug", models.CharField(blank=True, default="SYSTEM", max_length=64, verbose_name="Actor-slug")),
                ("actor_name", models.CharField(blank=True, default="System", max_length=200, verbose_name="Actor")),
                ("subject_slug", models.CharField(blank=True, default="", max_length=64, verbose_name="Onderwerp-slug")),
                ("subject_name", models.CharField(blank=True, default="", max_length=200, verbose_name="Onderwerp")),
                ("channel_slug", models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="Kanaal-slug")),
                ("channel_name", models.CharField(blank=True, default="", max_length=200, verbose_name="Kanaal")),
                ("action_type", models.CharField(db_index=True, max_length=64, verbose_name="Actietype")),
                ("entity_type", models.CharField(blank=True, default="", max_length=64, verbose_name="Entiteittype")),
                ("entity_slug", models.CharField(blank=True, default="", max_length=64, verbose_name="Entiteit-slug")),
                ("entity_name", models.CharField(blank=True, default="", max_length=200, verbose_name="Entiteit")),
                ("message", models.TextField(blank=True, default="", verbose_name="Bericht")),
                ("value", models.CharField(blank=True, default="", max_length=200, verbose_name="Waarde")),
                ("ptt_priority", models.PositiveSmallIntegerField(blank=True, null=True, verbose_name="PTT-prioriteit")),
                ("metadata", models.JSONField(blank=True, default=dict, verbose_name="Metadata")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="events", to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["-sequence_number"],"verbose_name":"Eventlogregel","verbose_name_plural":"Eventlog"},
        ),
        migrations.AddConstraint(model_name="eventlog", constraint=models.UniqueConstraint(condition=models.Q(("client_request_id__isnull", False)), fields=("tenant","client_request_id"), name="event_client_request_tenant_uq")),
        migrations.CreateModel(
            name="EventAttachment",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, editable=False, verbose_name="Aangemaakt op (ms)")),
                ("last_update_ms", models.BigIntegerField(default=engine_main.timeutils.now_ms, verbose_name="Laatst bijgewerkt (ms)")),
                ("attachment_type", models.CharField(choices=[("audio","Audio")], default="audio", max_length=16, verbose_name="Bijlagetype")),
                ("file", models.FileField(upload_to="poc/audio/%Y/%m/%d/", verbose_name="Bestand")),
                ("original_filename", models.CharField(max_length=255, verbose_name="Oorspronkelijke bestandsnaam")),
                ("mime_type", models.CharField(max_length=100, verbose_name="MIME-type")),
                ("file_size", models.PositiveBigIntegerField(verbose_name="Bestandsgrootte (bytes)")),
                ("duration_ms", models.PositiveIntegerField(blank=True, null=True, verbose_name="Duur (ms)")),
                ("checksum", models.CharField(max_length=64, verbose_name="Checksum")),
                ("event", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="attachments", to="engine_poc.eventlog", verbose_name="Event")),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="engine_main.tenant", verbose_name="Tenant")),
            ],
            options={"ordering":["-created_at_ms"],"verbose_name":"Eventbijlage","verbose_name_plural":"Eventbijlagen"},
        ),
    ]
