import re

from django.core.exceptions import ValidationError


def validate_engine_slug(value: str) -> None:
    if not value or not re.fullmatch(r"^[a-z0-9]+$", value):
        raise ValidationError("Slug mag alleen kleine ASCII-letters en cijfers bevatten.")
