DEFAULT_USER_STATUSES = (
    (0, "Noodsignaal"),
    (1, "Eigen initiatief"),
    (2, "Aanvraag spraak"),
    (3, "Informatievraag"),
    (4, "Aanrijdend naar incident"),
    (5, "Ter plaatse"),
    (6, "Aanrijdend naar bestemming"),
    (7, "Binnenkort beschikbaar"),
    (8, "Beschikbaar, Niet op standplaats"),
    (9, "Op standplaats"),
    (10, "Vertraagd inzetbaar"),
    (11, "Buiten dienst"),
    (12, "Binnenkort in dienst"),
    (13, "Aanvraag privégesprek"),
    (14, "Aanvraag spraak urgent"),
    (15, "Opdracht verstrekt"),
    (16, "Alarmering ontvangen"),
)


def ensure_default_user_statuses(tenant):
    from engine_poc.models import UserStatus

    for code, label in DEFAULT_USER_STATUSES:
        UserStatus.objects.update_or_create(
            tenant=tenant,
            slug=f"systemstatus{code}",
            defaults={
                "system_status": code,
                "display_code": str(code),
                "display_status": label,
                "display_label": label,
                "call_request_priority": 1 if code == 0 else None,
            },
        )
