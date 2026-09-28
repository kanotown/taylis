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
# §10.1 「最初の未読へ」: backward pages of this size, at most this many per press.
JUMP_PAGE_SIZE = 200
JUMP_MAX_PAGES = 4


def _loaded_range(page: dict[str, Any]) -> dict[str, Any]:
    """oldest_loaded_seq / has_older after a history page (0 = the channel's start is held)."""
    if not page["has_more"] or not page["messages"]:
        return {"oldest_loaded_seq": 0, "has_older": False}
    return {"oldest_loaded_seq": min(int(m["seq"]) for m in page["messages"]), "has_older": True}


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
            "channel": {
                "last_seq": 0,
                "synced_seq": None,
                "last_read_seq": 0,
                "unread_count": 0,
                "mention_count": 0,
                # §10.1: the held timeline is the contiguous range seq >= oldest_loaded_seq.
                "oldest_loaded_seq": None,
                "has_older": True,
            },
            "messages": {},  # id -> message (server shape) or local placeholder
            "me": None,
        }
        self.ws: websockets.ClientConnection | None = None
        self._buffer: list[dict[str, Any]] = []
        self._buffering = False
        self._drop_next = 0
        self.catch_ups = 0
        self.reloads = 0
        self.log: list[dict[str, Any]] = []  # every frame seen (diagnostics)

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
        self.store["me"] = bootstrap["me"]["id"]
        for channel in bootstrap["channels"]:
            if channel["id"] == self.channel_id:
                self.store["channel"]["last_seq"] = channel["last_seq"]
                if channel.get("read_state"):
                    self.apply_read_state(channel["read_state"])
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
                channel["oldest_loaded_seq"] = None
                channel["has_older"] = True
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
                channel.update(_loaded_range(page))
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
            self.log.append(frame)
            if frame["type"] != "event":
                continue
            # Only events newer than the cursor count: an event relayed after we connected but
            # already covered by bootstrap / catch_up is applied (ignored by §7.4) but not counted.
            timeline = self._is_timeline_event(frame) and (
                self.synced_seq is None or int(frame["seq"]) > self.synced_seq
            )
            if timeline:
                consumed += 1
                if self._drop_next > 0:
                    self._drop_next -= 1
                    continue
            if self._buffering:
                self._buffer.append(frame)
            else:
                await self._apply_frame(frame)

    # --- §8 / §10 read state ---------------------------------------------------------------

    def apply_read_state(self, state: dict[str, Any]) -> None:
        channel = self.store["channel"]
        channel["last_read_seq"] = max(int(channel["last_read_seq"]), int(state["last_read_seq"]))
        channel["unread_count"] = int(state["unread_count"])
        channel["mention_count"] = int(state["mention_count"])

    def _count_unread(self, message: dict[str, Any]) -> None:
        """§7.4: a live message from someone else is unread until read.updated says otherwise.

        §10.1 11.: my own message never moves the read position here. A send from this client
        moves it with the POST response (``send``); one from another device is followed by the
        server's read.updated, and a scheduled send (M12d) does not read the channel at all.
        §10.1 12.: only rows the server counts.
        """
        channel = self.store["channel"]
        me = self.store.get("me")
        if message.get("sender_id") == me:
            return
        if message.get("parent_id") is not None and not message.get("also_in_channel"):
            return
        if message.get("type", "user") != "user":
            return
        if int(message["seq"]) <= int(channel["last_read_seq"]):
            return
        channel["unread_count"] += 1
        if message.get("mention_all") or me in (message.get("mentioned_user_ids") or []):
            channel["mention_count"] += 1

    def covers(self, seq: int) -> bool:
        """§10.1: every timeline row after ``seq`` is held."""
        oldest = self.store["channel"]["oldest_loaded_seq"]
        return oldest == 0 or (oldest is not None and int(oldest) <= seq + 1)

    def caught_up(self) -> bool:
        """§10.1: every timeline row up to last_seq is held (no catch-up is still on its way)."""
        channel = self.store["channel"]
        synced = channel["synced_seq"]
        return synced is not None and int(synced) >= int(channel["last_seq"])

    def read_range_ready(self) -> bool:
        channel = self.store["channel"]
        return int(channel["unread_count"]) == 0 or (
            self.covers(int(channel["last_read_seq"])) and self.caught_up()
        )

    async def mark_read(self, seq: int, *, force: bool = False) -> dict[str, Any] | None:
        """PUT /channels/{id}/read; the local position moves first (optimistic, monotonic).

        §10.1: a visible-range read (not ``force``) does nothing while an unread row may be missing
        (the first one not held, or a catch-up still on its way), so it cannot skip unread
        messages never loaded.
        """
        channel = self.store["channel"]
        if not force and not self.read_range_ready():
            return None
        channel["last_read_seq"] = max(int(channel["last_read_seq"]), seq)
        async with self._http() as http:
            response = await http.put(
                f"/api/v1/channels/{self.channel_id}/read", json={"last_read_seq": seq}
            )
        assert response.status_code == 200, response.text
        state: dict[str, Any] = response.json()
        self.apply_read_state(state)
        return state

    async def load_first_unread(self) -> bool:
        """§10.1 「最初の未読へ」: page backwards until the held range reaches the read position."""
        channel = self.store["channel"]
        target = int(channel["last_read_seq"])
        pages = 0
        async with self._http() as http:
            while (
                not self.covers(target)
                and channel["has_older"]
                and (channel["oldest_loaded_seq"] or 0) > 0
                and pages < JUMP_MAX_PAGES
            ):
                page = (
                    await http.get(
                        f"/api/v1/channels/{self.channel_id}/messages",
                        params={
                            "before_seq": channel["oldest_loaded_seq"],
                            "limit": JUMP_PAGE_SIZE,
                        },
                    )
                ).json()
                for message in page["messages"]:
                    self.upsert(message)
                channel.update(_loaded_range(page))
                pages += 1
        return self.covers(target)

    async def _apply_frame(self, frame: dict[str, Any]) -> None:
        if frame["channel_id"] != self.channel_id:
            return  # other channels are out of scope for the reference client
        if frame["event"] == "read.updated":
            self.apply_read_state(frame["data"])
            return
        if frame["seq"] is None:
            return  # membership events etc.
        channel = self.store["channel"]
        seq = int(frame["seq"])
        if channel["synced_seq"] is None:
            channel["last_seq"] = max(channel["last_seq"], seq)
            if frame["event"] == "message.created":
                self._count_unread(frame["data"]["message"])
            return
        if seq == channel["synced_seq"] + 1:
            self.upsert(frame["data"]["message"])
            channel["synced_seq"] = seq
            channel["last_seq"] = max(channel["last_seq"], seq)
            if frame["event"] == "message.created":
                self._count_unread(frame["data"]["message"])
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
        # §10.1 11.: the server read the channel inside the send transaction; this response (not
        # the event) mirrors it.
        channel = self.store["channel"]
        channel["last_read_seq"] = max(int(channel["last_read_seq"]), int(message["seq"]))
        channel["unread_count"] = 0
        channel["mention_count"] = 0
        return message
