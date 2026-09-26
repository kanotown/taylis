"""FCMPushProvider: token grant, request shape and response mapping (PUSH_NOTIFICATIONS.md §8)."""

import json
import uuid
from urllib.parse import parse_qs

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.time import utcnow
from app.modules.auth.models import Device
from app.modules.notifications.providers import FCMPushProvider

TOKEN_URI = "https://oauth2.example/token"
FCM_HOST = "https://fcm.example"


@pytest.fixture(scope="module")
def keypair() -> tuple[str, str]:
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    public = (
        private.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    return pem, public


def device() -> Device:
    return Device(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        platform="android",
        push_provider="fcm",
        push_token="fcm-token-1",
    )


def provider(keypair: tuple[str, str], handler: object) -> FCMPushProvider:
    transport = httpx.MockTransport(handler)  # type: ignore[arg-type]
    return FCMPushProvider(
        project_id="chikuwa-test",
        client_email="push@chikuwa-test.iam.gserviceaccount.com",
        private_key=keypair[0],
        token_uri=TOKEN_URI,
        fcm_host=FCM_HOST,
        client=httpx.AsyncClient(transport=transport),
    )


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "kind": "message",
        "channel_id": str(uuid.uuid4()),
        "message_id": str(uuid.uuid4()),
        "seq": 7,
        "title": "alice",
        "subtitle": None,
        "body": "hello",
        "badge": 1,
        "collapse_key": "c1",
        "sent_at": utcnow().isoformat(),
        "expires_at": utcnow().isoformat(),
    }
    base.update(overrides)
    return base


def fcm_error(
    status: int, grpc_status: str, message: str, code: str | None = None
) -> httpx.Response:
    error: dict[str, object] = {"code": status, "message": message, "status": grpc_status}
    if code:
        error["details"] = [
            {"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": code}
        ]
    return httpx.Response(status, json={"error": error})


async def test_token_grant_and_data_only_message(keypair: tuple[str, str]) -> None:
    token_calls: list[dict[str, list[str]]] = []
    sends: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URI:
            token_calls.append(parse_qs(request.content.decode()))
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        sends.append(request)
        return httpx.Response(200, json={"name": "projects/chikuwa-test/messages/1"})

    fcm = provider(keypair, handler)
    assert (await fcm.send(device(), payload())).outcome == "sent"
    assert (await fcm.send(device(), payload(kind="silent"))).outcome == "sent"

    # One grant for both sends; the assertion is an RS256 JWT with the messaging scope.
    assert len(token_calls) == 1
    form = token_calls[0]
    assert form["grant_type"] == [FCMPushProvider.GRANT_TYPE]
    claims = jwt.decode(form["assertion"][0], keypair[1], algorithms=["RS256"], audience=TOKEN_URI)
    assert claims["iss"] == "push@chikuwa-test.iam.gserviceaccount.com"
    assert claims["scope"] == FCMPushProvider.SCOPE

    assert len(sends) == 2
    first = sends[0]
    assert str(first.url) == f"{FCM_HOST}/v1/projects/chikuwa-test/messages:send"
    assert first.headers["authorization"] == "Bearer at-1"
    message = json.loads(first.content)["message"]
    assert message["token"] == "fcm-token-1"
    assert "notification" not in message  # data-only (§5): the app renders it
    assert all(isinstance(value, str) for value in message["data"].values())
    assert message["data"]["title"] == "alice" and message["data"]["seq"] == "7"
    assert "subtitle" not in message["data"]
    assert message["android"]["priority"] == "HIGH"
    assert message["android"]["collapse_key"] == "c1"
    assert message["android"]["ttl"].endswith("s")
    assert json.loads(sends[1].content)["message"]["android"]["priority"] == "NORMAL"


@pytest.mark.parametrize(
    ("response", "outcome", "detail"),
    [
        (
            fcm_error(404, "NOT_FOUND", "Requested entity was not found.", "UNREGISTERED"),
            "invalid_token",
            "UNREGISTERED",
        ),
        (
            fcm_error(
                400,
                "INVALID_ARGUMENT",
                "The registration token is not a valid FCM registration token",
                "INVALID_ARGUMENT",
            ),
            "invalid_token",
            "INVALID_ARGUMENT",
        ),
        (
            fcm_error(
                400, "INVALID_ARGUMENT", "Invalid JSON payload received.", "INVALID_ARGUMENT"
            ),
            "failed",
            None,
        ),
        (
            fcm_error(429, "RESOURCE_EXHAUSTED", "Quota exceeded", "QUOTA_EXCEEDED"),
            "retry",
            "QUOTA_EXCEEDED",
        ),
        (httpx.Response(503, text="unavailable"), "retry", "503"),
    ],
)
async def test_response_mapping(
    keypair: tuple[str, str], response: httpx.Response, outcome: str, detail: str | None
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URI:
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return response

    result = await provider(keypair, handler).send(device(), payload())
    assert result.outcome == outcome
    if detail is not None:
        assert result.detail == detail


async def test_retry_after_and_transport_errors(keypair: tuple[str, str]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URI:
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(503, headers={"retry-after": "12"}, text="")

    result = await provider(keypair, handler).send(device(), payload())
    assert result.outcome == "retry" and result.retry_after == 12.0

    def failing(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    result = await provider(keypair, failing).send(device(), payload())
    assert result.outcome == "retry" and "transport" in (result.detail or "")


async def test_auth_failure_refreshes_the_access_token(keypair: tuple[str, str]) -> None:
    grants = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal grants
        if str(request.url) == TOKEN_URI:
            grants += 1
            return httpx.Response(200, json={"access_token": f"at-{grants}", "expires_in": 3600})
        if request.headers["authorization"] == "Bearer at-1":
            return fcm_error(
                401, "UNAUTHENTICATED", "Request had invalid authentication credentials."
            )
        return httpx.Response(200, json={"name": "m"})

    fcm = provider(keypair, handler)
    first = await fcm.send(device(), payload())
    assert first.outcome == "retry"
    second = await fcm.send(device(), payload())
    assert second.outcome == "sent"
    assert grants == 2


async def test_expired_access_token_is_renewed(keypair: tuple[str, str]) -> None:
    grants = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal grants
        grants += 1
        return httpx.Response(200, json={"access_token": f"at-{grants}", "expires_in": 100})

    fcm = provider(keypair, handler)
    assert await fcm.access_token(now=1000.0) == "at-1"
    assert await fcm.access_token(now=1020.0) == "at-1"  # still valid
    assert await fcm.access_token(now=1050.0) == "at-2"  # inside the safety margin → renewed
