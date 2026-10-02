from django.urls import path

from . import views

app_name = "engine_main"

urlpatterns = [
    path("", views.entry, name="entry"),
    path("login/", views.login, name="login"),
    path("auto-login/", views.hardware_auto_login, name="hardware-auto-login"),
    path("device-login/", views.hardware_device_login, name="hardware-device-login"),
    path("device-location/", views.hardware_device_location, name="hardware-device-location"),
    path("logout/", views.logout, name="logout"),
    path("app-logout/", views.app_logout, name="app-logout"),
    path("select/", views.select_identity, name="select"),
    path("<slug:tenant_slug>/select/", views.select_tenant_identity, name="tenant-select"),
    path("<slug:tenant_slug>/identity-status/", views.identity_status, name="identity-status"),
]
