from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.modules.auth.schemas import DeviceCreate

# base64url without padding: a verifier is 43-128 characters (RFC 7636), its SHA-256 is 43.
VERIFIER_PATTERN = r"^[A-Za-z0-9_-]{43,128}$"
CHALLENGE_PATTERN = r"^[A-Za-z0-9_-]{43}$"
SsoPlatform = Literal["web", "desktop", "ios", "android"]
# The codes a failed sign-in returns to the app with (docs/SSO.md §3).
SsoErrorCode = Literal[
    "cancelled",
    "expired",
    "domain_not_allowed",
    "email_not_verified",
    "not_registered",
    "account_disabled",
    "provider_error",
]


class ProviderMethod(BaseModel):
    enabled: bool
    # The Workspace domains the server accepts (SSO_GOOGLE_ALLOWED_DOMAINS); empty when disabled.
    # The login button names the organisation from these (App Store guideline 4.8: an
    # organisational-account login, not a consumer social login).
    domains: list[str] = Field(default_factory=list)
    # The administrator's name for the organisation (SSO_GOOGLE_LABEL), shown instead of the domain.
    label: str | None = None


class AuthMethodsOut(BaseModel):
    """Which sign-in buttons the login screen shows (M48)."""

    password: bool = True
    google: ProviderMethod


class SsoExchange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket: str = Field(min_length=1, max_length=128, repr=False)
    verifier: str = Field(pattern=VERIFIER_PATTERN, repr=False)
    device: DeviceCreate
