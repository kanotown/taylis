from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.modules.auth.models import Device, UserSession
from app.modules.users.schemas import UserMe

Platform = Literal["ios", "android", "desktop"]


class DeviceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_name: str | None = Field(default=None, max_length=80)
    app_version: str | None = Field(default=None, max_length=40)


class DeviceCreate(DeviceUpdate):
    platform: Platform


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=32)
    password: str = Field(max_length=128, repr=False)
    device: DeviceCreate


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=256, repr=False)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(max_length=128, repr=False)
    new_password: str = Field(min_length=12, max_length=128, repr=False)


class DeviceOut(BaseModel):
    id: UUID
    platform: str
    device_name: str | None
    app_version: str | None
    enabled: bool
    disabled_reason: str | None
    last_seen_at: datetime | None
    created_at: datetime
    updated_at: datetime


class TokenResponse(BaseModel):
    access_token: str = Field(repr=False)
    refresh_token: str = Field(repr=False)
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    session_id: UUID
    device: DeviceOut
    user: UserMe


class SessionOut(BaseModel):
    id: UUID
    device: DeviceOut
    current: bool
    last_ip: str | None
    created_at: datetime
    last_used_at: datetime
    expires_at: datetime


def to_device_out(device: Device) -> DeviceOut:
    return DeviceOut(
        id=device.id,
        platform=device.platform,
        device_name=device.device_name,
        app_version=device.app_version,
        enabled=device.enabled,
        disabled_reason=device.disabled_reason,
        last_seen_at=device.last_seen_at,
        created_at=device.created_at,
        updated_at=device.updated_at,
    )


def to_session_out(session: UserSession, device: Device, current_id: UUID) -> SessionOut:
    return SessionOut(
        id=session.id,
        device=to_device_out(device),
        current=session.id == current_id,
        last_ip=session.last_ip,
        created_at=session.created_at,
        last_used_at=session.last_used_at,
        expires_at=session.expires_at,
    )
