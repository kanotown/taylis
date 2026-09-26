"""Reference client for the sync protocol (SYNC_PROTOCOL.md §7-§9).

It is deliberately small and literal so that Desktop / iOS / Android implementations can be
compared against it. Frames are processed only when ``receive()`` is called, which keeps the
contract fixtures deterministic.
"""

import asyncio
import json
import uuid
from typing import Any

import httpx
import websockets

LOCAL_PREFIX = "local:"


class ReferenceClient:
    def __init__(
        self,
        base_url: str,
        ws_url: str,
        token: str,
        *,
        channel_id: str,
        page_size: int = 50,
        gap_limit: int = 5000,
        store: dict[str, Any] | None = None,
    ) -> None:
        self.base_url = base_url
        self.ws_url = ws_url
        self.token = token
        self.channel_id = channel_id
        self.page_size = page_size
        self.gap_limit = gap_limit
        # §7.1 persisted state: cursor per channel plus the messages we hold.
        self.store: dict[str, Any] = store or {
            "channel": {"last_seq": 0, "synced_seq": None},
            "messages": {},  # id -> message (server shape) or local placeholder
        }
        self.ws: websockets.ClientConnection | None = None
        self._buffer: list[dict[str, Any]] = []
        self._buffering = False
        self._drop_next = 0
        self.catch_ups = 0
        self.reloads = 0

    # --- helpers --------------------------------------------------------------------------

    def _http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url, headers={"Authorization": f"Bearer {self.token}"}
        )

    @property
    def synced_seq(self) -> int | None:
        value = self.store["channel"]["synced_seq"]
        return int(value) if value is not None else None

    def messages(self) -> list[dict[str, Any]]:
        confirmed = [m for m in self.store["messages"].values() if m.get("seq") is not None]
        pending = [m for m in self.store["messages"].values() if m.get("seq") is None]
        confirmed.sort(key=lambda m: int(m["seq"]))
        pending.sort(key=lambda m: str(m["created_at"]))
        return confirmed + pending

    def bodies(self) -> list[str]:
        return [str(m["body"]) for m in self.messages()]

    def snapshot(self) -> dict[str, Any]:
        copied: dict[str, Any] = json.loads(json.dumps(self.store))
        return copied

    # --- §8 merge rule ----------------------------------------------------------------------

    def upsert(self, message: dict[str, Any]) -> None:
        placeholder = LOCAL_PREFIX + str(message.get("client_msg_id"))
        self.store["messages"].pop(placeholder, None)  # §9 reconcile
        local = self.store["messages"].get(message["id"])
        if local is not None and int(message["updated_seq"]) <= int(local["updated_seq"]):
            return
        if message.get("deleted"):
            self.store["messages"].pop(message["id"], None)
        else:
            self.store["messages"][message["id"]] = message

    # --- §7.2 start, §7.3 catch_up, §7.4 live -----------------------------------------------

    async def start(self) -> None:
        self.ws = await websockets.connect(self.ws_url)
        await self.ws.send(json.dumps({"type": "auth", "token": self.token}))
        hello = json.loads(await self.ws.recv())
        assert hello["type"] == "hello"
        self._buffering = True  # events arriving before bootstrap is applied are buffered
        async with self._http() as http:
            bootstrap = (await http.get("/api/v1/sync/bootstrap")).json()
        for channel in bootstrap["channels"]:
            if channel["id"] == self.channel_id:
                self.store["channel"]["last_seq"] = channel["last_seq"]
        self._buffering = False
        for frame in self._buffer:
            await self._apply_frame(frame)
        self._buffer.clear()
        await self.catch_up()

    async def stop(self) -> None:
        if self.ws is not None:
            await self.ws.close()
            self.ws = None

    async def catch_up(self) -> None:
        self.catch_ups += 1
        channel = self.store["channel"]
        async with self._http() as http:
            if channel["synced_seq"] is not None and (
                channel["last_seq"] - channel["synced_seq"] > self.gap_limit
            ):
                # §7.3 cutoff: too far behind, reload the latest page instead.
                self.store["messages"] = {}
                channel["synced_seq"] = None
                self.reloads += 1
            if channel["synced_seq"] is None:
                page = (
                    await http.get(
                        f"/api/v1/channels/{self.channel_id}/messages",
                        params={"limit": self.page_size},
                    )
                ).json()
                for message in page["messages"]:
                    self.upsert(message)
                channel["synced_seq"] = page["channel_last_seq"]
                channel["last_seq"] = max(channel["last_seq"], page["channel_last_seq"])
                return
            while True:
                delta = (
                    await http.get(
                        f"/api/v1/channels/{self.channel_id}/sync",
                        params={"since_seq": channel["synced_seq"], "limit": 200},
                    )
                ).json()
                for message in delta["messages"]:
                    self.upsert(message)
                channel["synced_seq"] = delta["next_since_seq"]
                channel["last_seq"] = max(channel["last_seq"], delta["next_since_seq"])
                if not delta["has_more"]:
                    return

    def drop_next(self, count: int) -> None:
        """Simulate lost WebSocket events: the next ``count`` event frames are discarded."""
        self._drop_next += count

    def _is_timeline_event(self, frame: dict[str, Any]) -> bool:
        return (
            frame["type"] == "event"
            and frame.get("channel_id") == self.channel_id
            and frame.get("seq") is not None
        )

    async def receive(self, count: int = 1, wait: float = 5.0) -> None:
        """Process frames until ``count`` timeline events of this channel have been consumed.

        Other frames (pong, membership events, other channels) are applied but not counted.
        """
        assert self.ws is not None
        consumed = 0
        while consumed < count:
            frame = json.loads(await asyncio.wait_for(self.ws.recv(), wait))
            if frame["type"] != "event":
                continue
            timeline = self._is_timeline_event(frame)
            if timeline:
                consumed += 1
                if self._drop_next > 0:
                    self._drop_next -= 1
                    continue
            if self._buffering:
                self._buffer.append(frame)
            else:
                await self._apply_frame(frame)

    async def _apply_frame(self, frame: dict[str, Any]) -> None:
        if frame["channel_id"] != self.channel_id or frame["seq"] is None:
            return  # other channels / non-timeline events are out of scope for the reference client
        channel = self.store["channel"]
        seq = int(frame["seq"])
        if channel["synced_seq"] is None:
            channel["last_seq"] = max(channel["last_seq"], seq)
            return
        if seq == channel["synced_seq"] + 1:
            self.upsert(frame["data"]["message"])
            channel["synced_seq"] = seq
            channel["last_seq"] = max(channel["last_seq"], seq)
        elif seq > channel["synced_seq"] + 1:
            channel["last_seq"] = max(channel["last_seq"], seq)
            await self.catch_up()
        # seq <= synced_seq: already applied, ignore

    # --- §9 optimistic send ---------------------------------------------------------------

    async def send(self, body: str, client_msg_id: str | None = None) -> dict[str, Any]:
        client_msg_id = client_msg_id or str(uuid.uuid4())
        placeholder = LOCAL_PREFIX + client_msg_id
        self.store["messages"].setdefault(
            placeholder,
            {
                "id": placeholder,
                "client_msg_id": client_msg_id,
                "body": body,
                "seq": None,
                "updated_seq": -1,
                "created_at": "9999",
            },
        )
        async with self._http() as http:
            response = await http.post(
                f"/api/v1/channels/{self.channel_id}/messages",
                json={"client_msg_id": client_msg_id, "body": body},
            )
        assert response.status_code in (200, 201), response.text
        message: dict[str, Any] = response.json()
        self.upsert(message)
        return message
