from django.apps import AppConfig


class EnginePocConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "engine_poc"
    label = "engine_poc"
    verbose_name = "POC engine"

    def ready(self):
        # Registreer automatische basisobjecten en noodstatus-sync.
        from . import signals  # noqa: F401
        from . import schema  # noqa: F401  # registreert drf-spectacular extensions
