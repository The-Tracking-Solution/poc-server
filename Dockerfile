FROM python:3.12-slim AS builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --upgrade pip && /opt/venv/bin/pip install -r requirements.txt

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH="/opt/venv/bin:$PATH"
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl netcat-openbsd libpq5 binutils libproj-dev gdal-bin ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 appuser
COPY --from=builder /opt/venv /opt/venv

# Lokale Nederlandse Piper-stem voor de virtuele testklok.
# Model: nl_NL-alex-medium (CC0 voice dataset), geen cloud/API nodig.
RUN mkdir -p /opt/piper-voices \
    && curl -L --fail --retry 3 -o /opt/piper-voices/nl_NL-alex-medium.onnx \
       https://huggingface.co/rhasspy/piper-voices/resolve/main/nl/nl_NL/alex/medium/nl_NL-alex-medium.onnx \
    && curl -L --fail --retry 3 -o /opt/piper-voices/nl_NL-alex-medium.onnx.json \
       https://huggingface.co/rhasspy/piper-voices/resolve/main/nl/nl_NL/alex/medium/nl_NL-alex-medium.onnx.json
COPY . /app
RUN chmod +x /app/docker/*.sh && mkdir -p /app/media /app/staticfiles /app/logs /app/backups \
    && chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "--access-log", "-", "config.asgi:application"]
