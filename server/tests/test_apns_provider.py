"""APNsPushProvider request shape and response mapping (PUSH_NOTIFICATIONS.md §5, §8)."""

import json
import uuid

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.core.time import utcnow
from app.modules.auth.models import Device
from app.modules.notifications.providers import APNsPushProvider


@pytest.fixture
def keypair() -> tuple[str, str]:
    private = ec.generate_private_key(ec.SECP256R1())
    pem = private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    public = (
        private.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    return pem, public


def device(environment: str = "sandbox") -> Device:
    return Device(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        platform="ios",
        push_provider="apns",
        push_token="abcd",
        push_environment=environment,
    )


def provider(keypair: tuple[str, str], handler: object) -> APNsPushProvider:
    transport = httpx.MockTransport(handler)  # type: ignore[arg-type]
    return APNsPushProvider(
        key=keypair[0],
        key_id="KEY1",
        team_id="TEAM1",
        bundle_id="jp.example.app",
        client=httpx.AsyncClient(transport=transport),
    )


async def test_request_shape_and_auth_token(keypair: tuple[str, str]) -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200)

    apns = provider(keypair, handler)
    channel_id = str(uuid.uuid4())
    expires = utcnow().replace(microsecond=0)
    workspace_id = str(uuid.uuid4())
    payload = {
        "kind": "message",
        "workspace_id": workspace_id,
        "title": "Alice",
        "subtitle": None,
        "body": "hi",
        "badge": 1,
        "channel_id": channel_id,
        "message_id": str(uuid.uuid4()),
        "seq": 7,
        "collapse_key": channel_id,
        "expires_at": expires.isoformat(),
    }
    result = await apns.send(device("sandbox"), payload)
    assert result.outcome == "sent"
    request = captured[0]
    assert request.url == "https://api.sandbox.push.apple.com/3/device/abcd"
    assert request.headers["apns-topic"] == "jp.example.app"
    assert request.headers["apns-push-type"] == "alert" and request.headers["apns-priority"] == "10"
    assert request.headers["apns-collapse-id"] == channel_id
    assert request.headers["apns-expiration"] == str(int(expires.timestamp()))
    token = request.headers["authorization"].removeprefix("bearer ")
    claims = jwt.decode(token, keypair[1], algorithms=["ES256"])
    assert claims["iss"] == "TEAM1" and jwt.get_unverified_header(token)["kid"] == "KEY1"
    body = json.loads(request.content)
    assert body["aps"]["alert"] == {"title": "Alice", "body": "hi"}
    assert body["aps"]["thread-id"] == channel_id and body["aps"]["sound"] == "default"
    assert body["channel_id"] == channel_id and body["seq"] == 7
    assert body["workspace_id"] == workspace_id

    await apns.send(device("production"), payload)
    assert captured[1].url.host == "api.push.apple.com"
    assert apns.auth_token() == token  # cached, not regenerated per request


@pytest.mark.parametrize(
    ("status", "reason", "outcome"),
    [
        (200, "", "sent"),
        (400, "BadDeviceToken", "invalid_token"),
        (410, "Unregistered", "invalid_token"),
        (403, "InvalidProviderToken", "retry"),
        (429, "TooManyRequests", "retry"),
        (503, "ServiceUnavailable", "retry"),
        (413, "PayloadTooLarge", "failed"),
    ],
)
async def test_response_mapping(
    keypair: tuple[str, str], status: int, reason: str, outcome: str
) -> None:
    apns = provider(
        keypair, lambda _: httpx.Response(status, json={"reason": reason} if reason else None)
    )
    result = await apns.send(device(), {"kind": "message", "title": "t", "body": "b"})
    assert result.outcome == outcome


async def test_transport_errors_are_retried(keypair: tuple[str, str]) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    assert (
        await provider(keypair, handler).send(device(), {"title": "t", "body": "b"})
    ).outcome == "retry"
