"""The permalink landing page (M12b) needs no login and says nothing about the message."""

import uuid

from httpx import AsyncClient


async def test_permalink_page_is_public_and_content_free(client: AsyncClient) -> None:
    client.headers.pop("Authorization", None)
    response = await client.get(f"/m/{uuid.uuid4()}")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["x-robots-tag"] == "noindex"
    assert "ChikuwaChat" in response.text
    assert (await client.get("/m/not-a-message-id")).status_code == 404
