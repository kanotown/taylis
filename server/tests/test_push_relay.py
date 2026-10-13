"""The push relay (docs/PUSH_RELAY.md): a server without keys sends through one that has them."""

import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI

from app.core.settings import Settings
from app.modules.auth.models import Device
from app.modules.notifications.providers import FakePushProvider, PushResult, build_providers
from app.modules.notifications.relay import RELAY_PATH, RateLimiter, RelayPushProvider

KEY = "k" * 32
URL = "http://relay.test/api/v1" + RELAY_PATH


def _secrets(tmp_path: Path, *, relay_key: str = KEY, client_key: str = KEY) -> str:
    (tmp_path / "clients").mkdir()
    (tmp_path / "clients" / "lab-b").write_text(relay_key)
    (tmp_path / "client_secret").write_text(client_key)
    return str(tmp_path)


def _relay(
    app: FastAPI, settings: Settings, secrets: str, **extra: Any
) -> dict[str, FakePushProvider]:
    app.state.settings = settings.model_copy(
        update={"push_relay_serve": True, "push_relay_secrets_dir": secrets, **extra}
    )
    fakes = {"apns": FakePushProvider("apns"), "fcm": FakePushProvider("fcm")}
    app.state.push_providers = fakes
    return fakes


def _asker(
    app: FastAPI, settings: Settings, secrets: str, provider: str = "apns"
) -> RelayPushProvider:
    asking = settings.model_copy(
        update={
            "push_relay_url": URL,
            "push_relay_client_id": "lab-b",
            "push_relay_secrets_dir": secrets,
        }
    )
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app))
    return RelayPushProvider(provider, url=URL, client_id="lab-b", settings=asking, client=client)


def _device(provider: str = "apns") -> Device:
    return Device(
        id=uuid.uuid4(),
        platform="ios" if provider == "apns" else "android",
        push_provider=provider,
        push_token="tok-123",
        push_environment="production" if provider == "apns" else None,
        base_url="https://b.example",
    )


PAYLOAD = {
    "kind": "message",
    "title": "#研究ミーティング",
    "body": "こんにちは",
    "badge": 3,
    "seq": 7,
}


async def test_the_relay_sends_with_its_own_provider_and_answers_the_outcome(
    app: FastAPI, test_settings: Settings, tmp_path: Path
) -> None:
    fakes = _relay(app, test_settings, _secrets(tmp_path))
    asker = _asker(app, test_settings, str(tmp_path))
    assert await asker.send(_device(), PAYLOAD) == PushResult("sent")
    device, payload = fakes["apns"].sent[0]
    assert (device.push_token, device.push_environment, device.base_url) == (
        "tok-123",
        "production",
        "https://b.example",
    )
    assert payload == PAYLOAD
    # The relay's outcome comes back as is: an invalid token is dropped on the asking server.
    fakes["fcm"].outcomes.append(PushResult("invalid_token", "UNREGISTERED"))
    android = _asker(app, test_settings, str(tmp_path), "fcm")
    assert await android.send(_device("fcm"), PAYLOAD) == PushResult(
        "invalid_token", "UNREGISTERED"
    )
    fakes["apns"].outcomes.append(PushResult("retry", "429", 5.0))
    assert await asker.send(_device(), PAYLOAD) == PushResult("retry", "429", 5.0)


async def test_a_wrong_key_unknown_client_or_a_relay_that_is_off_keeps_the_push_pending(
    app: FastAPI, test_settings: Settings, tmp_path: Path
) -> None:
    fakes = _relay(app, test_settings, _secrets(tmp_path, client_key="w" * 32))
    asker = _asker(app, test_settings, str(tmp_path))
    result = await asker.send(_device(), PAYLOAD)
    assert result.outcome == "retry" and result.detail == "relay 401"
    asker.client_id = "nobody"
    assert (await asker.send(_device(), PAYLOAD)).detail == "relay 401"
    assert fakes["apns"].sent == []
    app.state.settings = app.state.settings.model_copy(update={"push_relay_serve": False})
    asker.client_id = "lab-b"
    assert (await asker.send(_device(), PAYLOAD)).detail == "relay 404"
    # No key file on the asking side: nothing is sent.
    (tmp_path / "client_secret").unlink()
    assert (await asker.send(_device(), PAYLOAD)).detail == "relay key missing"


async def test_old_or_forged_requests_are_refused(
    app: FastAPI, test_settings: Settings, tmp_path: Path
) -> None:
    _relay(app, test_settings, _secrets(tmp_path))
    asker = _asker(app, test_settings, str(tmp_path))
    body = asker.body(_device(), PAYLOAD)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        for headers in (
            {
                "X-Taylis-Relay-Client": "lab-b",
                "X-Taylis-Timestamp": "1",
                "X-Taylis-Signature": "sha256=00",
            },
            {"X-Taylis-Relay-Client": "lab-b"},
            {},
        ):
            response = await client.post(URL, content=body, headers=headers)
            assert response.status_code == 401


async def test_each_client_is_rate_limited(
    app: FastAPI, test_settings: Settings, tmp_path: Path
) -> None:
    fakes = _relay(app, test_settings, _secrets(tmp_path), push_relay_rate_per_minute=2)
    asker = _asker(app, test_settings, str(tmp_path))
    assert (await asker.send(_device(), PAYLOAD)).outcome == "sent"
    assert (await asker.send(_device(), PAYLOAD)).outcome == "sent"
    limited = await asker.send(_device(), PAYLOAD)
    assert limited.outcome == "retry" and limited.detail == "relay 429" and limited.retry_after
    assert len(fakes["apns"].sent) == 2
    limiter = RateLimiter()
    assert limiter.allow("a", 1, now=0.0) is None
    assert limiter.allow("a", 1, now=30.0) == 30.0
    assert limiter.allow("a", 1, now=60.5) is None


def test_a_relay_url_sends_both_platforms_through_the_relay(test_settings: Settings) -> None:
    providers = build_providers(
        test_settings.model_copy(update={"push_relay_url": URL, "push_relay_client_id": "lab-b"})
    )
    assert all(isinstance(p, RelayPushProvider) for p in providers.values())
    assert set(providers) == {"apns", "fcm"}
