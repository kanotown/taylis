"""Application settings loaded from environment variables (and a local .env file)."""

from functools import lru_cache
from typing import Any, Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "ChikuwaChat"
    # Shown in the clients' workspace switcher (WORKSPACES.md); empty means app_name.
    workspace_name: str = ""
    environment: Literal["development", "test", "production"] = "development"
    debug: bool = False
    log_level: str = "INFO"
    log_json: bool = True

    database_url: str = "postgresql+asyncpg://chikuwa:chikuwa@localhost:5432/chikuwa"
    # M19: database connections per process (the pool) and how many more a burst may open.
    db_pool_size: int = 20
    db_max_overflow: int = 10

    # Empty means "not configured". In development an ephemeral key is generated at startup;
    # in production the application refuses to start (see app.main).
    secret_key: str = ""
    access_token_ttl_seconds: int = 900
    refresh_token_ttl_days: int = 30
    refresh_token_max_days: int = 180
    refresh_grace_seconds: int = 30

    password_min_length: int = 8  # NIST SP 800-63B minimum; raise via PASSWORD_MIN_LENGTH
    login_rate_limit_per_ip: int = 10  # attempts per minute
    login_rate_limit_per_account: int = 5  # attempts per minute
    # M12h: the public invite endpoints (preview / accept), per client IP.
    invite_rate_limit_per_ip: int = 20
    # M68: GET /calendar/ical/{token}.ics (calendar apps poll it; CALENDAR.md §10.6).
    ical_rate_limit_per_ip: int = 60
    # M13a: posts through one incoming webhook, per minute.
    webhook_rate_limit_per_hook: int = 60

    # Object storage (S3 API, versitygw). Used from M9; only the readiness check touches it in M1.
    s3_endpoint: str | None = None
    s3_bucket: str = "chikuwa"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"

    run_background_tasks: bool = True

    # Google sign-in (M48, docs/SSO.md §2). Enabled only when the client id, the secret (inline or
    # in a file), at least one allowed domain and PUBLIC_BASE_URL are all set.
    sso_google_client_id: str = ""
    sso_google_client_secret: str = ""
    sso_google_client_secret_file: str = ""
    sso_google_allowed_domains: str = ""  # comma separated Workspace domains
    # Option B: a verified address of an allowed domain without an account gets a member account.
    sso_auto_provision: bool = False
    # Public channels (names, comma separated) such an account joins; unknown names are skipped.
    sso_default_channels: str = ""
    # The start, callback and exchange requests per client IP per minute (one sign-in is three).
    sso_rate_limit_per_ip: int = 30
    # This server's public URL (https://chat.example.ac.jp): the callback and the web return page.
    public_base_url: str = ""

    @property
    def sso_allowed_domains(self) -> list[str]:
        return [d.strip().lower() for d in self.sso_google_allowed_domains.split(",") if d.strip()]

    @property
    def sso_default_channel_names(self) -> list[str]:
        return [n.strip() for n in self.sso_default_channels.split(",") if n.strip()]

    # Browser-like clients (the Tauri WebView and the Vite dev server) need CORS. Comma separated.
    # Tokens travel in the Authorization header, never in cookies, so credentials stay disabled.
    cors_allow_origins: str = (
        "tauri://localhost,http://tauri.localhost,http://localhost:1420,http://localhost:1421"
    )

    @property
    def workspace_display_name(self) -> str:
        return self.workspace_name.strip() or self.app_name

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]

    # Push notifications (PUSH_NOTIFICATIONS.md)
    push_apns_enabled: bool = False
    push_apns_key_path: str = "/run/secrets/apns_key.p8"
    push_apns_key_id: str = ""
    push_apns_team_id: str = ""
    push_apns_bundle_id: str = ""
    push_fcm_enabled: bool = False
    push_fcm_service_account_path: str = "/run/secrets/fcm_service_account.json"
    push_include_content: bool = True
    push_alert_ttl_seconds: int = 600
    push_active_window_seconds: int = 60
    push_poll_interval_seconds: float = 1.0
    push_batch_size: int = 50
    push_concurrency: int = 10
    push_lease_seconds: int = 60
    push_retention_days: int = 7
    attachment_max_bytes: int = 100 * 1024 * 1024
    attachment_pending_ttl_hours: int = 24
    attachment_gc_interval_seconds: int = 3600
    attachment_thumbnail_px: int = 512
    # M79 (SECURITY.md §4 「動画」): a video's shape, length and poster frame, read at upload with
    # ffprobe / ffmpeg (subprocesses with a timeout, at most this many at once). Without the tools
    # (or disabled) videos upload as before and `app.cli probe-videos` fills them in later.
    video_probe_enabled: bool = True
    ffprobe_path: str = "ffprobe"
    ffmpeg_path: str = "ffmpeg"
    video_probe_timeout_seconds: float = 20.0
    video_probe_max_concurrent: int = 2
    upload_rate_limit_per_user: int = 20
    search_rate_limit_per_user: int = 30
    # M19: a search running longer is cancelled (503 search_timeout, the client may retry), and at
    # most this many run at once per process (a search waiting longer than the timeout for a turn
    # gets 503 search_busy): searches never hold every database connection while posts and syncs
    # wait.
    search_timeout_ms: int = 5000
    search_max_concurrent: int = 4
    # Link previews (M11g, SECURITY.md §14): bounded fetches of public pages, cached.
    link_preview_rate_limit_per_user: int = 60
    # SECURITY.md §5: posts per user per minute, and WebSocket sockets / attempts.
    message_rate_limit_per_user: int = 60
    # CANVAS.md §4.3: canvas saves (and creates, restores) per user per minute.
    canvas_save_rate_limit_per_user: int = 120
    # CANVAS.md §4.14 (M42): days a canvas stays in the trash before it is purged for good.
    canvas_trash_retention_days: int = 30
    ws_max_connections_per_user: int = 10
    ws_connect_rate_limit_per_ip: int = 30
    link_preview_timeout_seconds: float = 5.0
    link_preview_max_bytes: int = 512 * 1024
    link_preview_ttl_hours: int = 168
    link_preview_negative_ttl_hours: int = 24
    link_preview_user_agent: str = "ChikuwaChat-LinkPreview/1.0 (+https://github.com/chikuwachat)"
    session_retention_days: int = 30
    device_retention_days: int = 90

    # AI (docs/AI.md, M65): the Anthropic API key lives in a secret file only (never the DB or the
    # clients); without it the AI features report unavailable. Budget per calendar month (UTC)
    # and runs per person per rolling 24 hours (mentions and summaries together).
    ai_api_key_file: str = "/run/secrets/anthropic_api_key"
    # docs/AI.md §12: the OpenAI key, for bots whose model is an OpenAI one (same rules).
    ai_openai_api_key_file: str = "/run/secrets/openai_api_key"
    ai_monthly_budget_usd: float = 30.0
    ai_user_daily_runs: int = 50
    ai_worker_interval_seconds: float = 2.0
    # docs/AI.md §4: the prompt text of a run is dropped after this many days (cost stays).
    ai_input_retention_days: int = 90

    # Realtime (SYNC_PROTOCOL.md §5)
    ws_auth_timeout_seconds: float = 5.0
    ws_heartbeat_interval_seconds: int = 30
    ws_idle_timeout_seconds: float = 90.0
    ws_max_lifetime_seconds: float = 86_400.0
    ws_send_queue_size: int = 1000
    # Presence (SYNC_PROTOCOL.md §5.2): online while a ping with active=true (or the connection
    # itself) is younger than this; announced as away afterwards by the sweep.
    presence_away_seconds: float = 300.0
    presence_sweep_interval_seconds: float = 30.0
    # M12d: how often the worker looks for scheduled messages whose time has come.
    scheduled_send_interval_seconds: float = 15.0
    # M12f: custom emoji images (PNG / GIF / JPEG / WebP, at most 512px).
    emoji_max_bytes: int = 256 * 1024
    # M14a: profile pictures (any common image; stored as a 256px PNG).
    avatar_max_bytes: int = 5 * 1024 * 1024
    # typing frames from one connection are relayed at most this often.
    typing_min_interval_seconds: float = 2.0

    # Outbox relay (ARCHITECTURE.md §6)
    outbox_poll_interval_seconds: float = 1.0
    outbox_batch_size: int = 100
    outbox_max_attempts: int = 10
    outbox_retention_days: int = 7


@lru_cache
def get_settings() -> Settings:
    return Settings()


def build_settings(**overrides: Any) -> Settings:
    """Settings that ignore any .env file (tests and CLI tools)."""
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg]
