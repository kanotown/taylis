"""Application settings loaded from environment variables (and a local .env file)."""

from functools import lru_cache
from typing import Any, Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "ChikuwaChat"
    environment: Literal["development", "test", "production"] = "development"
    debug: bool = False
    log_level: str = "INFO"
    log_json: bool = True

    database_url: str = "postgresql+asyncpg://chikuwa:chikuwa@localhost:5432/chikuwa"

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

    # Object storage (S3 API, versitygw). Used from M9; only the readiness check touches it in M1.
    s3_endpoint: str | None = None
    s3_bucket: str = "chikuwa"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"

    run_background_tasks: bool = True

    # Browser-like clients (the Tauri WebView and the Vite dev server) need CORS. Comma separated.
    # Tokens travel in the Authorization header, never in cookies, so credentials stay disabled.
    cors_allow_origins: str = (
        "tauri://localhost,http://tauri.localhost,http://localhost:1420,http://localhost:1421"
    )

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

    # Realtime (SYNC_PROTOCOL.md §5)
    ws_auth_timeout_seconds: float = 5.0
    ws_heartbeat_interval_seconds: int = 30
    ws_idle_timeout_seconds: float = 90.0
    ws_max_lifetime_seconds: float = 86_400.0
    ws_send_queue_size: int = 1000

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
