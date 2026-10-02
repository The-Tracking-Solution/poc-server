from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "development-only-change-me")
DEBUG = os.getenv("DJANGO_DEBUG", "0") == "1"
ALLOWED_HOSTS = [h.strip() for h in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h.strip()]
CSRF_TRUSTED_ORIGINS = [u.strip() for u in os.getenv("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if u.strip()]

INSTALLED_APPS = [
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.gis",
    "channels",
    "rest_framework",
    "drf_spectacular",
    "utils.apps.UtilsConfig",
    "core.apps.CoreConfig",
    "engine_main.apps.EngineMainConfig",
    "engine_poc.apps.EnginePocConfig",
    "engine_radio.apps.EngineRadioConfig",
    "engine_dispatch.apps.EngineDispatchConfig",
    "ui_radio.apps.UiRadioConfig",
    "ui_dispatch.apps.UiDispatchConfig",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
        "django.contrib.messages.context_processors.messages",
        "engine_main.context_processors.site_brand",
    ]},
}]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DB_ENGINE = os.getenv("DB_ENGINE", "django.contrib.gis.db.backends.postgis")
if DB_ENGINE == "django.db.backends.sqlite3":
    DATABASES = {"default": {"ENGINE": DB_ENGINE, "NAME": os.getenv("DB_NAME", str(BASE_DIR / "db.sqlite3"))}}
else:
    DATABASES = {
        "default": {
            "ENGINE": DB_ENGINE,
            "NAME": os.getenv("DB_NAME", "engine_poc"),
            "USER": os.getenv("DB_USER", "engine_poc"),
            "PASSWORD": os.getenv("DB_PASSWORD", "engine_poc"),
            "HOST": os.getenv("DB_HOST", "db"),
            "PORT": os.getenv("DB_PORT", "5432"),
            "CONN_MAX_AGE": int(os.getenv("DB_CONN_MAX_AGE", "60")),
        }
    }

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LANGUAGE_CODE = "nl-nl"
TIME_ZONE = "Europe/Amsterdam"
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = Path(os.getenv("STATIC_ROOT", str(BASE_DIR / "staticfiles")))
MEDIA_URL = "/media/"
MEDIA_ROOT = Path(os.getenv("MEDIA_ROOT", str(BASE_DIR / "media")))
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "engine_poc.authentication.DeviceSessionAuthentication",
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.BasicAuthentication",
    ],
    "EXCEPTION_HANDLER": "engine_poc.exceptions.api_exception_handler",
}
SPECTACULAR_SETTINGS = {
    "TITLE": "POC Engine API",
    "DESCRIPTION": "Server-authoritatieve Push-to-Talk engine.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
CHANNEL_LAYER_BACKEND = os.getenv("CHANNEL_LAYER_BACKEND", "channels_redis.core.RedisChannelLayer")
if CHANNEL_LAYER_BACKEND == "channels.layers.InMemoryChannelLayer":
    CHANNEL_LAYERS = {"default": {"BACKEND": CHANNEL_LAYER_BACKEND}}
else:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": CHANNEL_LAYER_BACKEND,
            "CONFIG": {
                "hosts": [
                    {
                        "address": REDIS_URL,
                        "socket_connect_timeout": 10,
                        "socket_timeout": None,
                        "health_check_interval": 30,
                        "retry_on_timeout": True,
                    }
                ],
                "capacity": int(os.getenv("CHANNEL_LAYER_CAPACITY", "5000")),
                "expiry": int(os.getenv("CHANNEL_LAYER_EXPIRY", "60")),
                "group_expiry": int(os.getenv("CHANNEL_LAYER_GROUP_EXPIRY", "86400")),
            },
        }
    }

POC_AUDIO_MAX_FRAME_BYTES = int(os.getenv("POC_AUDIO_MAX_FRAME_BYTES", "65536"))
FILE_UPLOAD_MAX_MEMORY_SIZE = int(os.getenv("FILE_UPLOAD_MAX_MEMORY_SIZE", "10485760"))
DATA_UPLOAD_MAX_MEMORY_SIZE = int(os.getenv("DATA_UPLOAD_MAX_MEMORY_SIZE", "10485760"))


# Productiebeveiliging en reverse-proxyondersteuning
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True
SECURE_SSL_REDIRECT = os.getenv("DJANGO_SECURE_SSL_REDIRECT", "0") == "1"
SESSION_COOKIE_SECURE = os.getenv("DJANGO_SESSION_COOKIE_SECURE", "0") == "1"
CSRF_COOKIE_SECURE = os.getenv("DJANGO_CSRF_COOKIE_SECURE", "0") == "1"
SECURE_HSTS_SECONDS = int(os.getenv("DJANGO_SECURE_HSTS_SECONDS", "0"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = os.getenv("DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS", "0") == "1"
SECURE_HSTS_PRELOAD = os.getenv("DJANGO_SECURE_HSTS_PRELOAD", "0") == "1"

# Intentional HSTS policy: preload/includeSubDomains stay disabled until every
# subdomain is confirmed HTTPS-only. Silence only those two deployment checks.
SILENCED_SYSTEM_CHECKS = ["security.W005", "security.W021"]
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {"format": "{asctime} {levelname} {name} {message}", "style": "{"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "standard"},
    },
    "root": {"handlers": ["console"], "level": os.getenv("DJANGO_LOG_LEVEL", "INFO")},
}

RADIO_PRIORITY_COUNTDOWN_SECONDS = int(os.getenv("RADIO_PRIORITY_COUNTDOWN_SECONDS", "5"))
IDENTITY_STALE_AFTER_MS = int(os.getenv("IDENTITY_STALE_AFTER_MS", "60000"))
IDENTITY_CLAIM_TIMEOUT_MS = int(os.getenv("IDENTITY_CLAIM_TIMEOUT_MS", "300000"))
LOGIN_URL = "/user/login/"
