"""The permalink landing page (M12b) needs no login and says nothing about the message."""

import uuid

from httpx import AsyncClient


async def test_permalink_page_is_public_and_content_free(client: AsyncClient) -> None:
    client.headers.pop("Authorization", None)
    response = await client.get(f"/m/{uuid.uuid4()}")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["x-robots-tag"] == "noindex"
    assert "Taylis" in response.text
    assert (await client.get("/m/not-a-message-id")).status_code == 404


async def test_drive_permalink_page_tells_nothing_about_the_item(client: AsyncClient) -> None:
    """M165 (docs/DRIVE.md §13.1): `/d/<id>` lands on the same kind of page, for any id."""
    client.headers.pop("Authorization", None)
    response = await client.get(f"/d/{uuid.uuid4()}")
    assert response.status_code == 200
    assert response.headers["x-robots-tag"] == "noindex"
    assert response.headers["cache-control"] == "no-store"
    assert "ドライブのファイル" in response.text
    assert (await client.get("/d/not-an-item-id")).status_code == 404
