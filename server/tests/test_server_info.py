from collections.abc import AsyncIterator

from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.main import API_VERSION, create_app
from app.modules.workspace import service as workspace
from app.modules.workspace.models import WorkspaceIdentity
from tests.conftest import TEST_DATABASE_URL


async def test_server_info_is_public(client: AsyncClient, db: AsyncSession) -> None:
    response = await client.get("/api/v1/server")
    assert response.status_code == 200
    assert response.json() == {
        "product": "chikuwachat",
        "workspace_id": str(await workspace.workspace_id(db)),
        "name": "Taylis",
        "api_version": API_VERSION,
    }


async def test_workspace_identity_is_one_stable_row(db: AsyncSession) -> None:
    first = await workspace.workspace_id(db)
    assert first is not None
    assert await workspace.ensure(db) == first
    # A restore that lost the row gets a fresh identity at the next start.
    await db.execute(delete(WorkspaceIdentity))
    renewed = await workspace.ensure(db)
    assert renewed != first and await workspace.workspace_id(db) == renewed


async def _client(**overrides: str) -> AsyncIterator[AsyncClient]:
    app = create_app(
        build_settings(
            environment="test",
            database_url=TEST_DATABASE_URL,
            secret_key="test-secret-key-" + "0" * 40,
            log_json=False,
            **overrides,
        )
    )
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            yield c
    finally:
        await app.state.db.dispose()


async def test_server_info_uses_the_configured_workspace_name() -> None:
    async for client in _client(workspace_name="  開発チーム  "):
        assert (await client.get("/api/v1/server")).json()["name"] == "開発チーム"
    async for client in _client(workspace_name="   "):
        assert (await client.get("/api/v1/server")).json()["name"] == "Taylis"
