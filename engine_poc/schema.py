from drf_spectacular.extensions import OpenApiAuthenticationExtension


class DeviceSessionAuthenticationScheme(OpenApiAuthenticationExtension):
    target_class = "engine_poc.authentication.DeviceSessionAuthentication"
    name = "DeviceSessionBearer"

    def get_security_definition(self, auto_schema):
        return {
            "type": "apiKey",
            "in": "header",
            "name": "Authorization",
            "description": (
                "DeviceSession-authenticatie. Gebruik 'Bearer <access_token>' in Authorization "
                "en stuur daarnaast X-POC-Session-ID mee."
            ),
        }
