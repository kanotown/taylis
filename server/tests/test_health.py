from httpx import AsyncClient


async def test_healthz(client: AsyncClient) -> None:
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["x-request-id"]


async def test_readyz_checks_database(client: AsyncClient) -> None:
    response = await client.get("/readyz")
    assert response.status_code == 200
    assert response.json()["checks"]["db"] == "ok"


async def test_unknown_route_uses_error_format(client: AsyncClient) -> None:
    response = await client.get("/api/v1/does-not-exist")
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "not_found"
    assert set(body["error"]) == {"code", "message", "details"}


async def test_cors_preflight_for_the_desktop_webview(client: AsyncClient) -> None:
    allowed = await client.options(
        "/api/v1/auth/login",
        headers={
            "Origin": "tauri://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "tauri://localhost"
    assert "content-type" in allowed.headers["access-control-allow-headers"].lower()
    assert "access-control-allow-credentials" not in allowed.headers

    denied = await client.options(
        "/api/v1/auth/login",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in denied.headers


async def test_cors_preflight_allows_the_desktop_refresh(client: AsyncClient) -> None:
    """The desktop's refresh carries X-Requested-With (the browser build's CSRF header, M12j):
    a preflight that refuses it leaves the Tauri app unable to renew its token, forever offline."""
    for origin in ("tauri://localhost", "http://localhost:1420"):
        preflight = await client.options(
            "/api/v1/auth/refresh",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-requested-with",
            },
        )
        assert preflight.status_code == 200, preflight.text
        assert preflight.headers["access-control-allow-origin"] == origin
        assert "x-requested-with" in preflight.headers["access-control-allow-headers"].lower()
        assert "access-control-allow-credentials" not in preflight.headers
