from django.db import connection
from django.http import JsonResponse
from engine_poc.timeutils import now_ms


def health_view(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception as exc:
        return JsonResponse(
            {"status": "unhealthy", "timestamp_ms": now_ms(), "database": "error", "detail": str(exc)},
            status=503,
        )
    return JsonResponse({"status": "ok", "timestamp_ms": now_ms(), "database": "ok"})
