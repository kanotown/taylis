"""Runs the JSON contract fixtures (SYNC_PROTOCOL.md §13) with the reference client."""

import json
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest

from tests.conftest import LiveServer
from tests.contract_client import ReferenceClient
from tests.helpers import http_login, make_user

PASSWORD = "correct-horse-battery"
FIXTURES = sorted((Path(__file__).parent / "contract").glob("*.json"))
SCENARIOS = [(path.stem, json.loads(path.read_text())) for path in FIXTURES]


class Scenario:
    def __init__(self, live: LiveServer) -> None:
        self.live = live
        self.tokens: dict[str, dict[str, Any]] = {}
        self.channel_id = ""
        self.client: ReferenceClient | None = None
        self.client_user = ""
        self.client_options: dict[str, Any] = {}
        self.posted: dict[str, int] = {}

    def _auth(self, name: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.tokens[name]['access_token']}"}

    async def run(self, step: dict[str, Any]) -> None:
        handler = getattr(self, "op_" + str(step["op"]).replace(".", "_"))
        await handler(step)

    async def op_users(self, step: dict[str, Any]) -> None:
        async with self.live.app.state.db.session_factory() as db:
            for name in step["names"]:
                await make_user(db, name, password=PASSWORD)
        for name in step["names"]:
            self.tokens[name] = await http_login(self.live.base_url, name, PASSWORD)

    async def op_channel(self, step: dict[str, Any]) -> None:
        async with httpx.AsyncClient(base_url=self.live.base_url) as http:
            response = await http.post(
                "/api/v1/channels", json={"name": step["name"]}, headers=self._auth(step["owner"])
            )
            channel = response.json()
            self.channel_id = channel["id"]
            for member in step.get("members", []):
                await http.post(
                    f"/api/v1/channels/{self.channel_id}/join", headers=self._auth(member)
                )

    async def op_post(self, step: dict[str, Any]) -> None:
        name = step["as"]
        async with httpx.AsyncClient(base_url=self.live.base_url) as http:
            for _ in range(int(step.get("count", 1))):
                self.posted[name] = self.posted.get(name, 0) + 1
                index = sum(self.posted.values())
                response = await http.post(
                    f"/api/v1/channels/{self.channel_id}/messages",
                    json={
                        "client_msg_id": str(uuid.uuid4()),
                        "body": str(step["body"]).format(i=index),
                    },
                    headers=self._auth(name),
                )
                assert response.status_code == 201, response.text

    def _new_client(self, store: dict[str, Any] | None = None) -> ReferenceClient:
        return ReferenceClient(
            self.live.base_url,
            self.live.ws_url,
            self.tokens[self.client_user]["access_token"],
            channel_id=self.channel_id,
            page_size=int(self.client_options.get("page_size", 50)),
            gap_limit=int(self.client_options.get("gap_limit", 5000)),
            store=store,
        )

    async def op_client_start(self, step: dict[str, Any]) -> None:
        self.client_user = step["as"]
        self.client_options = step
        self.client = self._new_client()
        await self.client.start()

    async def op_client_stop(self, step: dict[str, Any]) -> None:
        assert self.client is not None
        await self.client.stop()

    async def op_client_restart(self, step: dict[str, Any]) -> None:
        assert self.client is not None
        snapshot = self.client.snapshot()  # what a real client persisted on disk
        await self.client.stop()
        self.client = self._new_client(store=snapshot)
        await self.client.start()

    async def op_client_receive(self, step: dict[str, Any]) -> None:
        assert self.client is not None
        await self.client.receive(int(step.get("count", 1)))

    async def op_client_drop_next(self, step: dict[str, Any]) -> None:
        assert self.client is not None
        self.client.drop_next(int(step["count"]))

    async def op_client_send(self, step: dict[str, Any]) -> None:
        assert self.client is not None
        key = str(uuid.uuid5(uuid.NAMESPACE_URL, str(step["key"])))
        await self.client.send(str(step["body"]), client_msg_id=key)

    async def op_client_send_event_first(self, step: dict[str, Any]) -> None:
        """The WS event for our own message is applied before the REST response is handled."""
        assert self.client is not None
        key = str(uuid.uuid5(uuid.NAMESPACE_URL, str(step["key"])))
        # Post through a separate HTTP call while the client only holds the placeholder ...
        placeholder = "local:" + key
        self.client.store["messages"][placeholder] = {
            "id": placeholder,
            "client_msg_id": key,
            "body": step["body"],
            "seq": None,
            "updated_seq": -1,
            "created_at": "9999",
        }
        async with httpx.AsyncClient(base_url=self.live.base_url) as http:
            response = await http.post(
                f"/api/v1/channels/{self.channel_id}/messages",
                json={"client_msg_id": key, "body": step["body"]},
                headers=self._auth(self.client_user),
            )
        # ... the WS event arrives and is applied first ...
        await self.client.receive(1)
        # ... then the (late) REST response is reconciled.
        self.client.upsert(response.json())

    async def op_expect(self, step: dict[str, Any]) -> None:
        assert self.client is not None
        if "messages" in step:
            assert self.client.bodies() == step["messages"]
        if "message_count" in step:
            assert len(self.client.messages()) == step["message_count"]
        if "first_body" in step:
            assert self.client.bodies()[0] == step["first_body"]
        if "last_body" in step:
            assert self.client.bodies()[-1] == step["last_body"]
        if "synced_seq" in step:
            assert self.client.synced_seq == step["synced_seq"]
        if "catch_ups" in step:
            assert self.client.catch_ups == step["catch_ups"]
        if "reloads" in step:
            assert self.client.reloads == step["reloads"]
        if "server_message_count" in step:
            async with httpx.AsyncClient(base_url=self.live.base_url) as http:
                history = (
                    await http.get(
                        f"/api/v1/channels/{self.channel_id}/messages",
                        headers=self._auth(self.client_user),
                    )
                ).json()
            assert len(history["messages"]) == step["server_message_count"]


@pytest.mark.parametrize("spec", [s for _, s in SCENARIOS], ids=[name for name, _ in SCENARIOS])
async def test_contract(live: LiveServer, spec: dict[str, Any]) -> None:
    scenario = Scenario(live)
    try:
        for step in spec["steps"]:
            await scenario.run(step)
    finally:
        if scenario.client is not None:
            await scenario.client.stop()
