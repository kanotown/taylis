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

    password_min_length: int = 12
    login_rate_limit_per_ip: int = 10  # attempts per minute
    login_rate_limit_per_account: int = 5  # attempts per minute

    # Object storage (S3 API, versitygw). Used from M9; only the readiness check touches it in M1.
    s3_endpoint: str | None = None
    s3_bucket: str = "chikuwa"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"

    run_background_tasks: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()


def build_settings(**overrides: Any) -> Settings:
    """Settings that ignore any .env file (tests and CLI tools)."""
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg]
