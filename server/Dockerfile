# Debian 13 (trixie) since AL5 (docs/ALBUMS.md §19): its ffmpeg 7.1 reads HEIC (bookworm's 5.1 cannot).
FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# M79: ffprobe / ffmpeg read a video's size and poster frame at upload (SECURITY.md §4 「動画」);
# AL5: they also decode HEIC / HEIF photos (app/modules/attachments/heif.py).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/server

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .
RUN useradd --system --create-home --uid 10001 app && chown -R app:app /srv/server
USER app

EXPOSE 8000
ENTRYPOINT ["/srv/server/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
