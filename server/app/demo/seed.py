"""`app.cli seed-demo`: write the fictional demo lab (app/demo/content.py) into a database.

The data goes in through the public API, served in-process (httpx's ASGI transport, no network
and no running server needed), so every row is made by the same code paths as in real use: channel
sequences, the outbox, search, polls, collections, reservations. Only the timestamps are then moved
into the past with a few UPDATEs (posting happens "now"), so that the workspace looks lived-in.

`reset` empties every table first (keeping the schema and the workspace identity). It refuses
unless WORKSPACE_NAME is the demo's name or the caller passes `i_know`.
"""

import importlib.util
import logging
import re
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import Database
from app.core.security import hash_password
from app.core.settings import Settings
from app.core.time import utcnow
from app.demo import assets
from app.demo import content as c
from app.modules.recurring.schedule import expand_template

log = logging.getLogger("app.demo")

API = "/api/v1"
JST = ZoneInfo(c.TZ)
SERVER_DIR = Path(__file__).resolve().parents[2]
WEEKDAYS_JA = "月火水木金土日"


class DemoSeedError(Exception):
    """A refusal or a failed step; the message says what to do."""


@dataclass
class SeedOutcome:
    status: str  # "seeded" | "already_seeded"
    # username -> password for the accounts made now (the review password only when generated).
    credentials: dict[str, str] = field(default_factory=dict)
    messages: int = 0
    reset: bool = False


# --- time and text ------------------------------------------------------------------------------


def anchor_day(now: datetime) -> date:
    """Day 0 of the script: today, or yesterday before noon (day-0 posts are in the morning)."""
    local = now.astimezone(JST)
    return local.date() if local.hour >= 12 else local.date() - timedelta(days=1)


def at(anchor: date, spec: tuple[int, str]) -> datetime:
    day, clock = spec
    hour, minute = (int(part) for part in clock.split(":"))
    return datetime.combine(anchor + timedelta(days=day), time(hour, minute), JST)


def date_label(day: date) -> str:
    return f"{day.month}/{day.day}（{WEEKDAYS_JA[day.weekday()]}）"


_DATE_TOKEN = re.compile(r"\{(d|iso)([+-]\d+)\}")
_MENTION = re.compile(r"<@([a-z0-9._-]+)>")


def render(body: str, anchor: date, user_ids: dict[str, uuid.UUID]) -> str:
    def date_token(match: re.Match[str]) -> str:
        day = anchor + timedelta(days=int(match.group(2)))
        return date_label(day) if match.group(1) == "d" else day.isoformat()

    body = _DATE_TOKEN.sub(date_token, body)
    return _MENTION.sub(lambda m: f"<@{user_ids[m.group(1)]}>", body)


# --- safety and reset ---------------------------------------------------------------------------


def is_demo_workspace(settings: Settings) -> bool:
    return settings.workspace_name.strip() in c.DEMO_WORKSPACE_NAMES


async def _scalar(session: AsyncSession, sql: str, **params: Any) -> Any:
    return (await session.execute(text(sql), params)).scalar()


async def demo_state(session: AsyncSession, review_username: str) -> str:
    """ "empty" (no demo account yet), "complete" (the last step ran) or "partial"."""
    names = [p.username for p in c.CAST] + [review_username]
    found = await _scalar(session, "SELECT count(*) FROM users WHERE username = ANY(:n)", n=names)
    if not found:
        return "empty"
    pool = await _scalar(
        session, "SELECT count(*) FROM reservation_pools WHERE name = :n", n=c.POOL_NAME
    )
    return "complete" if found == len(names) and pool else "partial"


BLOB_COLUMNS = (
    ("attachments", ("storage_key", "thumbnail_key", "preview_pdf_key", "preview_thumb_key")),
    ("custom_emoji", ("storage_key",)),
    ("emoji_packs", ("tab_storage_key",)),
    ("users", ("avatar_key",)),
    ("workspace_settings", ("icon_key",)),
)


async def _blob_keys(session: AsyncSession) -> list[str]:
    keys: list[str] = []
    for table, columns in BLOB_COLUMNS:
        if not await _scalar(session, "SELECT to_regclass(:t) IS NOT NULL", t=f"public.{table}"):
            continue
        for column in columns:
            rows = await session.execute(
                text(f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL AND {column} <> ''")
            )
            keys += [str(row[0]) for row in rows]
    return keys


def _message_template_defaults() -> list[tuple[str, str, str]]:
    """The workspace templates migration 0041 seeds (日報, 週報), read from the migration itself."""
    path = SERVER_DIR / "migrations" / "versions" / "0041_message_templates.py"
    spec = importlib.util.spec_from_file_location("_demo_mig_0041", path)
    if spec is None or spec.loader is None:
        log.warning("could not read %s: no default message templates", path)
        return []
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.DEFAULTS)


async def wipe(session: AsyncSession, settings: Settings) -> None:
    """Empty every table but the migration version, keep the workspace identity (installed clients
    keep treating the server as the same workspace) and put back the rows migrations seed."""
    from app.modules.attachments.blobstore import build_blobstore
    from app.modules.canvases import service as canvases

    keys = await _blob_keys(session)
    identity = await _scalar(session, "SELECT id FROM workspace_identity")
    tables = [
        str(row[0])
        for row in await session.execute(
            text(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public' "
                "AND tablename <> 'alembic_version'"
            )
        )
    ]
    await session.execute(text("SET LOCAL lock_timeout = '60s'"))
    quoted = ", ".join(f'"{name}"' for name in tables)
    await session.execute(text(f"TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE"))
    await session.execute(
        text("INSERT INTO workspace_identity (singleton, id) VALUES (true, :id)"),
        {"id": identity or uuid.uuid4()},
    )
    await session.execute(text("INSERT INTO workspace_settings (singleton) VALUES (true)"))
    for position, (name, suggest_in, body) in enumerate(_message_template_defaults()):
        await session.execute(
            text(
                "INSERT INTO message_templates (id, scope, name, body, suggest_in, position) "
                "VALUES (:id, 'workspace', :name, :body, :suggest_in, :position)"
            ),
            {
                "id": uuid.uuid4(),
                "name": name,
                "body": body,
                "suggest_in": suggest_in,
                "position": position,
            },
        )
    await session.commit()
    await canvases.ensure_builtin_templates(session)

    blobs = build_blobstore(settings)
    failed = 0
    for key in keys:
        try:
            await blobs.delete(key)
        except Exception as exc:  # an orphaned object is harmless; say so and go on
            failed += 1
            log.warning("could not delete object %s: %s", key, exc)
    if failed:
        log.warning("%d object(s) were left in the bucket", failed)


async def _set_password(session: AsyncSession, username: str, password: str) -> None:
    await session.execute(
        text(
            "UPDATE users SET password_hash = :h, must_change_password = false, "
            "updated_at = now() WHERE username = :u"
        ),
        {"h": await hash_password(password), "u": username},
    )
    await session.commit()


# --- the API, in-process ------------------------------------------------------------------------


class _Api:
    def __init__(self, app: FastAPI) -> None:
        self.http = AsyncClient(transport=ASGITransport(app=app), base_url="http://demo-seed")
        self.tokens: dict[str, str] = {}

    async def login(self, username: str, password: str) -> None:
        response = await self.http.post(
            f"{API}/auth/login",
            json={
                "username": username,
                "password": password,
                "device": {"platform": "desktop", "device_name": "demo seed"},
            },
        )
        if response.status_code != 200:
            raise DemoSeedError(f"login as {username}: {response.status_code} {response.text}")
        self.tokens[username] = response.json()["access_token"]

    async def __call__(
        self,
        who: str,
        method: str,
        path: str,
        *,
        json: Any = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> Any:
        response = await self.http.request(
            method,
            API + path,
            json=json,
            files=files,
            headers={"Authorization": f"Bearer {self.tokens[who]}"},
        )
        if response.status_code >= 400:
            raise DemoSeedError(f"{method} {path} as {who}: {response.status_code} {response.text}")
        return response.json() if response.content else None

    async def logout_all(self) -> None:
        """The seed's sessions are not left behind (they would show as 「demo seed」)."""
        for who in list(self.tokens):
            await self.http.post(
                f"{API}/auth/logout", headers={"Authorization": f"Bearer {self.tokens[who]}"}
            )
        await self.http.aclose()


def _file_bytes(spec: c.FileSpec, anchor: date) -> tuple[bytes, str]:
    if spec.kind == "chart":
        return assets.chart_png(), "image/png"
    if spec.kind == "pdf":
        return assets.text_pdf(spec.title, [list(page) for page in spec.lines]), "application/pdf"
    paragraphs = [render(line, anchor, {}) for page in spec.lines for line in page]
    return (
        assets.simple_docx(spec.title, paragraphs),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )


# --- seeding ------------------------------------------------------------------------------------


@dataclass
class _Seeder:
    api: _Api
    session: AsyncSession
    anchor: date
    now: datetime
    review: c.Person
    user_ids: dict[str, uuid.UUID] = field(default_factory=dict)
    channels: dict[str, str] = field(default_factory=dict)  # key -> channel id
    messages: dict[str, dict[str, Any]] = field(default_factory=dict)  # key -> MessageOut
    times: dict[str, datetime] = field(default_factory=dict)  # message id -> when it was "posted"
    seqs: dict[str, list[tuple[datetime, int]]] = field(default_factory=dict)  # channel -> posts

    @property
    def people(self) -> tuple[c.Person, ...]:
        return (*c.CAST, self.review)

    def uid(self, username: str) -> str:
        return str(self.user_ids[username])

    def body(self, body: str) -> str:
        # The script says <@review> whatever the review account is called.
        ids = {**self.user_ids, "review": self.user_ids[self.review.username]}
        return render(body, self.anchor, ids)

    def members(self, spec: c.ChannelSpec) -> tuple[str, ...]:
        if spec.members:
            return tuple(self.who(m) for m in spec.members)
        return tuple(p.username for p in self.people)

    async def post(
        self, channel: str, who: str, when: datetime, body: str, **extra: Any
    ) -> dict[str, Any]:
        payload = {"body": body, "client_msg_id": str(uuid.uuid4()), **extra}
        message: dict[str, Any] = await self.api(
            who, "POST", f"/channels/{self.channels[channel]}/messages", json=payload
        )
        self.times[message["id"]] = when
        self.seqs.setdefault(channel, []).append((when, int(message["seq"])))
        return message

    async def profiles(self) -> None:
        tanaka = c.CAST[0].username
        for person in self.people:
            update: dict[str, Any] = {"title": person.title}
            if person.status:
                update["status_emoji"], update["status_text"] = person.status
            await self.api(person.username, "PATCH", "/users/me", json=update)
            line: dict[str, Any] = {"affiliation": person.affiliation}
            if person.rank:
                line["rank"] = person.rank
            if person.grade:
                line["grade"] = person.grade
            if person.supervisor:
                line["supervisor_id"] = self.uid(person.supervisor)
            if person.reading:
                line["reading"] = person.reading
            if person.research_topic:
                line["research_topic"] = person.research_topic
            await self.api(tanaka, "PUT", f"/lab/roster/{self.uid(person.username)}", json=line)
        for name, label, colour, keywords in c.TEXT_EMOJI:
            await self.api(
                tanaka,
                "POST",
                "/emoji/text",
                json={"name": name, "label": label, "color": colour, "keywords": keywords},
            )

    async def make_channels(self) -> None:
        for spec in c.CHANNELS:
            channel = await self.api(
                spec.owner,
                "POST",
                "/channels",
                json={"name": spec.name, "type": spec.type, "topic": spec.topic},
            )
            self.channels[spec.key] = channel["id"]
            others = [self.uid(m) for m in self.members(spec) if m != spec.owner]
            if others:
                await self.api(
                    spec.owner,
                    "POST",
                    f"/channels/{channel['id']}/members/batch",
                    json={"user_ids": others},
                )
        for owner in c.TIMES_OWNERS:
            username = self.review.username if owner == "review" else owner
            channel = await self.api(username, "POST", "/times")
            self.channels[f"times:{owner}"] = channel["id"]
        for key, people in c.DMS.items():
            names = [self.review.username if p == "review" else p for p in people]
            channel = await self.api(
                names[0], "POST", "/dms", json={"user_ids": [self.uid(n) for n in names[1:]]}
            )
            self.channels[key] = channel["id"]
        for channel_key, title, url in c.LINKS:
            await self.api(
                "tanaka",
                "POST",
                f"/channels/{self.channels[channel_key]}/links",
                json={"title": title, "url": url},
            )

    def who(self, name: str) -> str:
        return self.review.username if name == "review" else name

    async def conversations(self) -> None:
        uploads: dict[str, bytes] = {}
        ordered = sorted(c.POSTS, key=lambda p: at(self.anchor, p.at))
        for post in ordered:
            when = at(self.anchor, post.at)
            extra: dict[str, Any] = {}
            if post.parent:
                extra["parent_id"] = self.messages[post.parent]["id"]
            if post.priority:
                extra["priority"] = post.priority
            if post.ack_requested:
                extra["ack_requested"] = True
            if post.poll:
                extra["poll"] = self.poll(post.poll)
            if post.files:
                ids = []
                for key in post.files:
                    spec = c.FILES[key]
                    data, mime = _file_bytes(spec, self.anchor)
                    uploads[key] = data
                    uploaded = await self.api(
                        self.who(post.author),
                        "POST",
                        "/attachments",
                        files={"file": (spec.filename, data, mime)},
                    )
                    ids.append(uploaded["id"])
                extra["attachment_ids"] = ids
            message = await self.post(
                post.channel, self.who(post.author), when, self.body(post.body), **extra
            )
            if post.key:
                self.messages[post.key] = message
            mid = message["id"]
            for emoji, people in post.reactions.items():
                for person in people:
                    await self.api(self.who(person), "PUT", f"/messages/{mid}/reactions/{emoji}")
            for person in post.acks:
                await self.api(self.who(person), "PUT", f"/messages/{mid}/ack")
            for person, index in post.votes:
                await self.api(self.who(person), "PUT", f"/messages/{mid}/poll/votes/{index}")
            for person, answers in post.answers.items():
                await self.api(
                    self.who(person),
                    "PUT",
                    f"/messages/{mid}/poll/answers",
                    json={
                        "answers": [
                            {"index": i, "answer": answer} for i, answer in enumerate(answers)
                        ]
                    },
                )
            if post.pin:
                await self.api(self.who(post.author), "PUT", f"/messages/{mid}/pin")

    def poll(self, spec: dict[str, Any]) -> dict[str, Any]:
        if spec.get("kind") != "schedule":
            return spec
        slots = []
        for day, clock, minutes in spec["slots"]:
            start = at(self.anchor, (day, clock))
            slots.append(
                {
                    "starts_at": start.isoformat(),
                    "ends_at": (start + timedelta(minutes=minutes)).isoformat(),
                }
            )
        return {"kind": "schedule", "question": spec["question"], "slots": slots, "tz": c.TZ}

    async def weekly_report(self) -> None:
        """A recurring 週報 that collects replies; the latest run was last Monday 09:00."""
        channel = self.channels["weekly"]
        targets = [self.uid(s) for s in c.ALL_STUDENTS] + [self.uid(self.review.username)]
        recurring = await self.api(
            "tanaka",
            "POST",
            f"/channels/{channel}/recurring-posts",
            json={
                "name": c.WEEKLY_REPORT_NAME,
                "body": c.WEEKLY_REPORT_BODY,
                "schedule": {"kind": "weekly", "weekdays": [0], "time": "09:00"},
                "tz": c.TZ,
                "collect": {
                    "targets": {"user_ids": targets},
                    "due": {"after_days": 4, "time": "18:00"},
                },
            },
        )
        run = await self.api("tanaka", "POST", f"/recurring-posts/{recurring['id']}/run")
        root = run["message_id"]
        posted = at(self.anchor, (-(self.anchor.weekday() or 7), "09:00"))
        self.times[root] = posted
        limit = at(self.anchor, (0, "11:50"))
        count = len(c.WEEKLY_REPORT_REPLIES)
        for index, (who, hours, body) in enumerate(c.WEEKLY_REPORT_REPLIES):
            when = min(posted + timedelta(hours=hours), limit - timedelta(minutes=count - index))
            await self.post("weekly", who, when, body, parent_id=root)
        due = datetime.combine(posted.date() + timedelta(days=4), time(18, 0), JST)
        await self.session.execute(
            text("UPDATE collections SET due_at = :due WHERE message_id = :m"),
            {"due": due, "m": root},
        )
        # The body was expanded for today ({week}); write it for the day it is shown on.
        await self.session.execute(
            text("UPDATE messages SET body = :body WHERE id = :m"),
            {"body": expand_template(c.WEEKLY_REPORT_BODY, posted.date()), "m": root},
        )
        await self.session.execute(
            text("UPDATE recurring_posts SET last_run_at = :at WHERE id = :id"),
            {"at": posted, "id": recurring["id"]},
        )
        await self.session.commit()

    async def tasks_and_calendar(self) -> None:
        def day(n: int) -> str:
            return (self.anchor + timedelta(days=n)).isoformat()

        review = self.review.username
        source = self.messages["m_ask_review"]["id"]
        tasks: list[tuple[str, dict[str, Any]]] = [
            (
                "tanaka",
                {
                    "title": "サーベイの要点を 5 分で紹介",
                    "channel_id": self.channels["meeting"],
                    "assignee_ids": [self.uid(review)],
                    "due_on": day(7),
                    "source_message_id": source,
                },
            ),
            (
                "suzuki",
                {
                    "title": "学会の旅費申請書を提出",
                    "channel_id": self.channels["conf"],
                    "assignee_ids": [self.uid(u) for u in ("nakamura", "yamamoto", "ito")],
                    "due_on": day(7),
                },
            ),
            (
                "tanaka",
                {
                    "title": "学会 発表スライドの提出",
                    "kind": "deadline",
                    "channel_id": self.channels["conf"],
                    "assignee_ids": [self.uid("nakamura"), self.uid("ito")],
                    "due_at": at(self.anchor, (14, "17:00")).isoformat(),
                    "tz": c.TZ,
                    "notice_days": [7, 3, 1],
                },
            ),
            (
                "tanaka",
                {
                    "title": "修士論文 中間発表の要旨",
                    "kind": "deadline",
                    "channel_id": self.channels["meeting"],
                    "assignee_ids": [self.uid("takahashi"), self.uid("nakamura")],
                    "due_on": day(21),
                    "notice_days": [7, 1],
                },
            ),
            (
                "suzuki",
                {
                    "title": "GPU サーバの CUDA を更新",
                    "status": "done",
                    "channel_id": self.channels["equip"],
                    "assignee_ids": [self.uid("suzuki")],
                    "due_on": day(-3),
                },
            ),
            (
                review,
                {
                    "title": "再現実験の環境を作る",
                    "status": "doing",
                    "due_on": day(4),
                    "subtasks": [
                        {"title": "conda の環境を作る", "done": True},
                        {"title": "ベースラインを動かす"},
                        {"title": "結果を times に書く"},
                    ],
                },
            ),
            (
                "ito",
                {
                    "title": "オシロスコープを返す",
                    "channel_id": self.channels["equip"],
                    "assignee_ids": [self.uid("ito")],
                    "due_on": day(3),
                },
            ),
        ]
        for who, body in tasks:
            await self.api(
                who, "POST", "/tasks", json={"client_task_id": str(uuid.uuid4()), **body}
            )

        first_monday = self.anchor - timedelta(days=13 + (self.anchor - timedelta(13)).weekday())
        events: list[dict[str, Any]] = [
            {
                "title": "研究ミーティング",
                "channel_id": self.channels["meeting"],
                "starts_at": datetime.combine(first_monday, time(13, 0), JST).isoformat(),
                "ends_at": datetime.combine(first_monday, time(14, 30), JST).isoformat(),
                "rrule": "FREQ=WEEKLY;BYDAY=MO",
                "location": "2 号館 3 階 セミナー室",
            },
            {
                "title": "学会発表 練習会",
                "channel_id": self.channels["general"],
                "starts_at": at(self.anchor, (2, "16:00")).isoformat(),
                "ends_at": at(self.anchor, (2, "17:30")).isoformat(),
                "location": "セミナー室",
            },
            {
                "title": "研究室 大掃除",
                "channel_id": self.channels["general"],
                "starts_at": at(self.anchor, (10, "15:00")).isoformat(),
                "ends_at": at(self.anchor, (10, "16:30")).isoformat(),
            },
            {
                "title": "秋の交流会",
                "channel_id": self.channels["general"],
                "starts_at": at(self.anchor, (12, "18:30")).isoformat(),
                "ends_at": at(self.anchor, (12, "20:30")).isoformat(),
                "location": "駅前（お店は投票で決めます）",
            },
            {
                "title": "秋の学会（発表：中村・伊藤）",
                "channel_id": self.channels["conf"],
                "all_day": True,
                "start_date": day(30),
                "end_date": day(32),
            },
        ]
        for event in events:
            await self.api(
                "tanaka",
                "POST",
                "/calendar/events",
                json={"client_event_id": str(uuid.uuid4()), "tz": c.TZ, **event},
            )

        await self.api(
            "tanaka",
            "POST",
            f"/channels/{self.channels['conf']}/canvases",
            json={
                "client_save_id": str(uuid.uuid4()),
                "title": c.CANVAS_TITLE,
                "body": self.body(c.CANVAS_BODY),
                "as_tab": True,
                "tz": c.TZ,
            },
        )

    async def reservations(self) -> None:
        """The pool (operators 鈴木 and 田中), two bookings, two seats in use and one person
        waiting, so the review account can try booking or queueing at once."""
        pool = await self.api(
            "tanaka",
            "POST",
            "/reservation-pools",
            json={
                "name": c.POOL_NAME,
                "capacity": 2,
                "operator_ids": [self.uid("suzuki"), self.uid("tanaka")],
                "tz": c.TZ,
                "log_channel_id": self.channels["equip"],
            },
        )
        pool_id = pool["id"]
        today = self.now.astimezone(JST).date()
        for who, days, hour, hours in (("takahashi", 1, 10, 3), ("watanabe", 2, 13, 2)):
            start = datetime.combine(today + timedelta(days=days), time(hour, 0), JST)
            await self.api(
                who,
                "POST",
                f"/reservation-pools/{pool_id}/bookings",
                json={"start_at": start.isoformat(), "hours": hours},
            )
        for who, assign in (("ito", True), ("nakamura", True), ("yamamoto", False)):
            mine = await self.api(who, "POST", f"/reservation-pools/{pool_id}/reserve")
            if assign:
                await self.api(
                    "suzuki", "POST", f"/reservations/{mine['my_reservation_id']}/assign"
                )

    async def backdate(self) -> None:
        """Move the posts to their script times and make the rest agree with them."""
        start = at(self.anchor, (-14, "09:00"))
        for message_id, when in self.times.items():
            await self.session.execute(
                text("UPDATE messages SET created_at = :at WHERE id = :id"),
                {"at": when, "id": message_id},
            )
        ids = list(self.times)
        channel_ids = list(self.channels.values())
        statements = [
            # Thread summaries and the sidebar order follow the moved posts.
            "UPDATE messages p SET last_reply_at = s.latest FROM (SELECT parent_id, "
            "max(created_at) AS latest FROM messages WHERE parent_id IS NOT NULL "
            "AND deleted_at IS NULL GROUP BY parent_id) s WHERE p.id = s.parent_id "
            "AND p.id = ANY(CAST(:ids AS uuid[]))",
            "UPDATE channels c SET last_message_at = (SELECT max(created_at) FROM messages m "
            "WHERE m.channel_id = c.id AND m.deleted_at IS NULL) "
            "WHERE c.id = ANY(CAST(:channels AS uuid[]))",
            "UPDATE channels SET created_at = :start WHERE id = ANY(CAST(:channels AS uuid[]))",
            "UPDATE channel_members SET joined_at = :start "
            "WHERE channel_id = ANY(CAST(:channels AS uuid[]))",
            # Reactions, votes and acknowledgements a few minutes after their message.
            "UPDATE reactions r SET created_at = LEAST(m.created_at + interval '9 minutes', "
            "now()) FROM messages m WHERE r.message_id = m.id "
            "AND m.id = ANY(CAST(:ids AS uuid[]))",
            "UPDATE poll_votes v SET created_at = LEAST(m.created_at + interval '20 minutes', "
            "now()) FROM messages m WHERE v.message_id = m.id "
            "AND m.id = ANY(CAST(:ids AS uuid[]))",
            "UPDATE message_acks a SET acked_at = LEAST(m.created_at + interval '15 minutes', "
            "now()) FROM messages m WHERE a.message_id = m.id "
            "AND m.id = ANY(CAST(:ids AS uuid[]))",
            "UPDATE users SET created_at = CAST(:start AS timestamptz) - interval '30 days' "
            "WHERE id = ANY(CAST(:users AS uuid[]))",
        ]
        params = {
            "ids": ids,
            "channels": channel_ids,
            "start": start,
            "users": [str(v) for v in self.user_ids.values()],
        }
        for statement in statements:
            await self.session.execute(text(statement), params)
        # The review account has not opened its activity since the start of day 0.
        await self.session.execute(
            text("UPDATE users SET activity_read_at = :t WHERE username = :u"),
            {"t": at(self.anchor, (0, "00:00")), "u": self.review.username},
        )
        await self.session.commit()

    async def read_states(self) -> None:
        for person in self.people:
            await self.api(person.username, "POST", "/channels/read-all", json=None)
        review = self.review.username
        for key, spec in c.REVIEW_UNREAD_FROM.items():
            cutoff = at(self.anchor, spec)
            seen = [seq for when, seq in self.seqs.get(key, []) if when < cutoff]
            await self.api(
                review,
                "PUT",
                f"/channels/{self.channels[key]}/read",
                json={"last_read_seq": max(seen, default=0), "mode": "set"},
            )


async def _create_accounts(
    session: AsyncSession, people: tuple[c.Person, ...], passwords: dict[str, str]
) -> dict[str, uuid.UUID]:
    from app.modules.admin.schemas import AdminUserCreate
    from app.modules.admin.service import create_user

    ids: dict[str, uuid.UUID] = {}
    for person in people:
        user, _ = await create_user(
            session,
            AdminUserCreate(
                username=person.username,
                display_name=person.display_name,
                role="admin" if person.admin else "member",
            ),
            password=passwords[person.username],
            must_change_password=False,
        )
        ids[person.username] = user.id
    return ids


async def seed_demo(
    settings: Settings,
    *,
    reset: bool = False,
    i_know: bool = False,
    review_username: str = "review",
    review_password: str | None = None,
    now: datetime | None = None,
) -> SeedOutcome:
    """Seed the demo lab (or say it is already there). See the module docstring."""
    from app.main import create_app

    demo = is_demo_workspace(settings)
    name = settings.workspace_name.strip() or "(empty)"
    if reset and not (demo or i_know):
        raise DemoSeedError(
            f"refusing to reset: WORKSPACE_NAME is {name!r}, not "
            f"{c.WORKSPACE_NAME!r}. --reset deletes ALL data; set WORKSPACE_NAME to the demo's "
            "name or pass --i-know"
        )
    if review_password is not None and len(review_password) < settings.password_min_length:
        raise DemoSeedError(
            f"the review password must be at least {settings.password_min_length} characters"
        )

    db = Database(settings.database_url)
    try:
        async with db.session_factory() as session:
            if reset:
                await wipe(session, settings)
            state = await demo_state(session, review_username)
            if state == "complete":
                if review_password is not None:
                    await _set_password(session, review_username, review_password)
                return SeedOutcome(status="already_seeded")
            if state == "partial":
                raise DemoSeedError(
                    "an incomplete demo seed is in this database; run again with --reset"
                )
            if not (demo or i_know) and await _scalar(session, "SELECT count(*) FROM messages"):
                raise DemoSeedError(
                    f"this database has messages and WORKSPACE_NAME is {name!r}: refusing to add "
                    f"the fictional demo lab to it. Set WORKSPACE_NAME={c.WORKSPACE_NAME!r} for a "
                    "demo server, or pass --i-know"
                )

            review = c.Person(
                review_username,
                c.REVIEW.display_name,
                c.REVIEW.title,
                c.REVIEW.affiliation,
                grade=c.REVIEW.grade,
                supervisor=c.REVIEW.supervisor,
                reading=c.REVIEW.reading,
                research_topic=c.REVIEW.research_topic,
            )
            people = (*c.CAST, review)
            passwords = {p.username: secrets.token_urlsafe(12) for p in people}
            if review_password is not None:
                passwords[review_username] = review_password
            user_ids = await _create_accounts(session, people, passwords)

            app_settings = settings.model_copy(
                update={
                    "run_background_tasks": False,
                    "login_rate_limit_per_ip": 1_000_000,
                    "login_rate_limit_per_account": 1_000_000,
                    "upload_rate_limit_per_user": 1_000_000,
                }
            )
            app = create_app(app_settings)
            # Hundreds of in-process requests: keep them out of the access log.
            logging.getLogger("app.access").setLevel(logging.WARNING)
            api = _Api(app)
            try:
                for person in people:
                    await api.login(person.username, passwords[person.username])
                current = await api("tanaka", "GET", "/admin/workspace-settings")
                # Join lines would interleave with the script; put the setting back afterwards.
                await api(
                    "tanaka",
                    "PATCH",
                    "/admin/workspace-settings",
                    json={"show_membership_messages": False},
                )
                seeder = _Seeder(
                    api=api,
                    session=session,
                    anchor=anchor_day(now or utcnow()),
                    now=now or utcnow(),
                    review=review,
                    user_ids=user_ids,
                )
                await seeder.profiles()
                await seeder.make_channels()
                await seeder.conversations()
                await seeder.weekly_report()
                await seeder.tasks_and_calendar()
                await seeder.backdate()
                await seeder.read_states()
                await api(
                    "tanaka",
                    "PATCH",
                    "/admin/workspace-settings",
                    json={
                        "show_membership_messages": current["show_membership_messages"],
                        "default_channel_ids": [seeder.channels[k] for k in c.DEFAULT_CHANNELS],
                    },
                )
                # Last: its presence marks a complete seed (demo_state).
                await seeder.reservations()
            finally:
                await api.logout_all()
                await app.state.db.dispose()

            credentials = dict(passwords)
            if review_password is not None:
                credentials.pop(review_username)
            return SeedOutcome(
                status="seeded",
                credentials=credentials,
                messages=len(seeder.times),
                reset=reset,
            )
    finally:
        await db.dispose()
