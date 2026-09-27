from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TotpStatusOut(BaseModel):
    enabled: bool
    enabled_at: datetime | None
    recovery_codes_left: int


class TotpSetupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(max_length=128, repr=False)


class TotpSetupOut(BaseModel):
    """Shown once: the secret for manual entry, the otpauth URI and its QR code as PNG."""

    secret: str = Field(repr=False)
    otpauth_uri: str = Field(repr=False)
    qr_png_base64: str = Field(repr=False)


class TotpEnableRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=16, repr=False)


class TotpEnabledOut(BaseModel):
    """Recovery codes are shown once; each works for one login without the authenticator."""

    recovery_codes: list[str] = Field(repr=False)
