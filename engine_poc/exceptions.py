from rest_framework.views import exception_handler
from engine_poc.timeutils import now_ms


def api_exception_handler(exc, context):
    response = exception_handler(exc, context)
    if response is None:
        return response
    code = getattr(exc, "default_code", "api_error")
    message = response.data.get("detail", response.data) if isinstance(response.data, dict) else response.data
    response.data = {
        "timestamp_ms": now_ms(),
        "error": {"code": str(code).upper(), "message": message, "details": response.data},
    }
    return response
