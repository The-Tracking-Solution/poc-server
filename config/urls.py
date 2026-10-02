from django.contrib import admin
from django.urls import include, path
from django.views.generic import RedirectView
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from engine_poc.health import health_view
from engine_main import views as engine_main_views

urlpatterns = [
    path("health/", health_view, name="health"),
    path("admin/", admin.site.urls),
    path("poc/api/v1/", include("engine_poc.urls")),
    path("poc/openapi/", SpectacularAPIView.as_view(), name="poc-openapi"),
    path("poc/docs/", SpectacularSwaggerView.as_view(url_name="poc-openapi"), name="poc-docs"),
    path("radio/", include("ui_radio.urls", namespace="ui_radio")),
    path("dispatch/", include("ui_dispatch.urls", namespace="dispatch")),
    path("user/", include("engine_main.urls", namespace="engine_main")),
    path("", engine_main_views.root_entry, name="root-entry"),
]
