"""Channel feeds (M97, docs/FEEDS.md): RSS / Atom subscriptions whose new entries are posted into
a channel.

Any member registers a feed (it is theirs); the channel's feed bot (role `bot`, one per channel,
shared by its feeds, named 「RSS」) posts 「📝 {owner} の新しい記事: {title}」 through the ordinary
message path (seq, outbox, pushes, search), without taking mentions from the text. Adding a feed
fetches it once: it must parse, and what it holds then is recorded as seen (the backlog is never
posted). The worker fetches each enabled feed every FEED_POLL_INTERVAL_MINUTES with a conditional
GET through the previews' SSRF-safe fetcher, posts at most FEED_MAX_POSTS_PER_FETCH new entries
(newest ones, oldest first), and after FEED_FAILURE_NOTIFY_AFTER failures in a row tells the owner
once, in a DM from the bot. Nothing is fetched while the channel is archived or the owner is
deactivated or not a member; what was published meanwhile is not posted afterwards.

Network I/O never happens inside a database transaction: the rows are claimed (next_fetch_at moved
on) and committed first, fetched, then locked again to record the result.
"""

import logging
import secrets
import uuid
from datetime import datetime, timedelta

import httpx
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.admin import service as admin
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.feeds import repository as repo
from app.modules.feeds.models import MAX_URL_LENGTH, ChannelFeed
from app.modules.feeds.parser import (
    FeedEntry,
    FeedParseError,
    ParsedFeed,
    discover_feed_url,
    looks_like_html,
    parse_feed,
)
from app.modules.feeds.schemas import FeedCreate, FeedOut, FeedUpdate
from app.modules.link_previews.fetcher import (
    FeedFetcher,
    FeedResponse,
    PreviewError,
    UrlNotAllowed,
    check_url_shape,
)
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.workflows.render import escape_text

log = logging.getLogger(__name__)

# SECURITY.md §5: feeds in one channel, and feeds one person registers (all channels).
MAX_PER_CHANNEL = 20
MAX_PER_USER = 20
# Seen entry hashes kept per feed (the current document's are always among them).
MAX_SEEN = 500
BOT_NAME = "RSS"
# A post's client_msg_id comes from the feed and the entry: a retried post finds its message.
_POST_NAMESPACE = uuid.UUID("0b7f5b8e-3c1d-4f6a-9e2b-7d4c1a5e8f90")
# Entries dated this much before the feed was registered are backlog (a site that changed its
# entry ids would otherwise look all new).
_BACKLOG_MARGIN = timedelta(days=1)


# --- access -----------------------------------------------------------------------------------


async def _can_manage(db: AsyncSession, actor: User, row: ChannelFeed) -> bool:
    if actor.id == row.owner_id or actor.is_admin:
        return True
    membership = await channels.membership_of(db, actor.id, row.channel_id)
    return membership is not None and membership.role == "owner"


async def _readable_row(
    db: AsyncSession, actor: User, feed_id: uuid.UUID, *, for_update: bool = False
) -> ChannelFeed:
    row = await repo.get(db, feed_id, for_update=for_update)
    if row is None:
        raise not_found("feed_not_found", "Feed not found")
    try:
        await channels.require_readable(db, actor, row.channel_id)
    except AppError as exc:  # someone who cannot read the channel does not learn it exists
        raise not_found("feed_not_found", "Feed not found") from exc
    return row


async def _managed_row(db: AsyncSession, actor: User, feed_id: uuid.UUID) -> ChannelFeed:
    row = await _readable_row(db, actor, feed_id, for_update=True)
    if not await _can_manage(db, actor, row):
        raise forbidden(
            "feed_manage_restricted",
            "Only the member who added the feed, the channel's owners and administrators can",
        )
    return row


async def _outs(db: AsyncSession, actor: User, rows: list[ChannelFeed]) -> list[FeedOut]:
    if not rows:
        return []
    owners = await users.get_users(db, list({row.owner_id for row in rows}))
    out: list[FeedOut] = []
    members: dict[uuid.UUID, set[uuid.UUID]] = {}
    for row in rows:
        if row.channel_id not in members:
            members[row.channel_id] = set(await channels.member_ids_of(db, row.channel_id))
        owner = owners.get(row.owner_id)
        out.append(
            FeedOut(
                id=row.id,
                channel_id=row.channel_id,
                owner_id=row.owner_id,
                bot_user_id=row.bot_user_id,
                url=row.url,
                title=row.title,
                site_url=row.site_url,
                enabled=row.enabled,
                owner_active=owner is not None
                and owner.is_active
                and row.owner_id in members[row.channel_id],
                can_manage=await _can_manage(db, actor, row),
                last_fetched_at=row.last_fetched_at,
                last_success_at=row.last_success_at,
                last_error_code=row.last_error_code,
                last_error=row.last_error,
                consecutive_failures=row.consecutive_failures,
                post_count=row.post_count,
                last_post_at=row.last_post_at,
                created_at=row.created_at,
                updated_at=row.updated_at,
            )
        )
    return out


# --- fetching ---------------------------------------------------------------------------------


class FetchFailed(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message[:300]


async def _get(
    fetch: FeedFetcher, url: str, etag: str | None, last_modified: str | None
) -> FeedResponse:
    """One fetch; every failure becomes FetchFailed(code) except a refused address
    (UrlNotAllowed), which the caller reports as such."""
    try:
        return await fetch(url, etag, last_modified)
    except UrlNotAllowed:
        raise
    except PreviewError as exc:
        raise FetchFailed(exc.code, str(exc)) from exc
    except httpx.TimeoutException as exc:
        raise FetchFailed("timeout", "The site did not answer in time") from exc
    except httpx.HTTPError as exc:
        raise FetchFailed("network", type(exc).__name__) from exc
    except ValueError as exc:  # a malformed host or port
        raise FetchFailed("network", "Malformed address") from exc


def _parse(response: FeedResponse) -> ParsedFeed:
    try:
        return parse_feed(response.body, response.url)
    except FeedParseError as exc:
        raise FetchFailed(exc.code, str(exc)) from exc


def _invalid(exc: FetchFailed) -> AppError:
    return AppError(
        422,
        "feed_invalid",
        f"Could not read a feed at this address: {exc.message}",
        details={"reason": exc.code},
    )


# --- CRUD -------------------------------------------------------------------------------------


async def list_for_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> list[FeedOut]:
    """Whoever reads the channel sees its feeds (the posts name them anyway)."""
    await channels.require_readable(db, actor, channel_id)
    return await _outs(db, actor, await repo.list_for_channel(db, channel_id))


async def _feed_bot(db: AsyncSession, actor: User, channel: Channel) -> uuid.UUID:
    """The channel's feed bot: the one its feeds already use (back in the channel if someone
    removed it), else a new 「RSS」 bot that joins the channel."""
    existing = await repo.bot_of_channel(db, channel.id)
    if existing is not None:
        bot = await users.require_user(db, existing)
        if bot.is_active:
            if await channels.membership_of(db, bot.id, channel.id) is None:
                await channels.add_member_in_tx(db, channel, bot.id)
            return bot.id
    bot = await admin.create_bot_in_tx(
        db, actor_id=actor.id, username=f"feed-{secrets.token_hex(4)}", display_name=BOT_NAME
    )
    await channels.add_member_in_tx(db, channel, bot.id)
    return bot.id


async def create(
    db: AsyncSession,
    actor: User,
    channel_id: uuid.UUID,
    data: FeedCreate,
    *,
    settings: Settings,
    fetch: FeedFetcher,
) -> FeedOut:
    channels.require_not_guest(actor)
    channel, _ = await channels.require_member(db, actor.id, channel_id)
    if channel.is_dm:
        raise bad_request("feed_channel_unsupported", "Feeds are for channels, not DMs")
    channels.require_writable(channel)
    url = data.url.strip()
    try:  # the address's shape now; DNS and every redirect are checked by the fetcher
        check_url_shape(url)
    except (UrlNotAllowed, ValueError) as exc:
        raise bad_request("url_not_allowed", "Only public http(s) addresses can be added") from exc
    if await repo.count_for_channel(db, channel.id) >= MAX_PER_CHANNEL:
        raise conflict("too_many_channel_feeds", f"At most {MAX_PER_CHANNEL} feeds per channel")
    if await repo.count_for_owner(db, actor.id) >= MAX_PER_USER:
        raise conflict("too_many_feeds", f"At most {MAX_PER_USER} feeds per person")
    if await repo.find_by_url(db, channel.id, url) is not None:
        raise conflict("feed_exists", "This feed is already in the channel")
    await db.commit()  # no transaction is held while the site answers

    try:
        response = await _get(fetch, url, None, None)
        try:
            parsed = _parse(response)
        except FetchFailed:
            # A site's page that names its feed: follow it once (docs/FEEDS.md §3).
            found = discover_feed_url(response.body, response.url)
            if not looks_like_html(response.body) or found is None or found == url:
                raise
            url = found[:MAX_URL_LENGTH]
            response = await _get(fetch, url, None, None)
            parsed = _parse(response)
    except UrlNotAllowed as exc:
        raise bad_request("url_not_allowed", "Only public http(s) addresses can be added") from exc
    except FetchFailed as exc:
        raise _invalid(exc) from exc

    channel, _ = await channels.require_member(db, actor.id, channel_id)
    channels.require_writable(channel)
    if await repo.find_by_url(db, channel.id, url) is not None:
        raise conflict("feed_exists", "This feed is already in the channel")
    now = utcnow()
    bot_id = await _feed_bot(db, actor, channel)
    row = ChannelFeed(
        channel_id=channel.id,
        owner_id=actor.id,
        bot_user_id=bot_id,
        url=url,
        title=parsed.title,
        site_url=parsed.site_url,
        enabled=True,
        needs_baseline=False,
        etag=response.etag,
        last_modified=response.last_modified,
        seen_keys=_seen_after([], parsed.entries, failed=set()),
        next_fetch_at=now + timedelta(minutes=settings.feed_poll_interval_minutes),
        last_fetched_at=now,
        last_success_at=now,
        consecutive_failures=0,
        post_count=0,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as exc:  # the same URL added at the same moment
        await db.rollback()
        raise conflict("feed_exists", "This feed is already in the channel") from exc
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="feed.created",
        target_type="channel_feed",
        target_id=row.id,
        details={"url": url, "channel_id": str(channel.id)},
    )
    await db.commit()
    return (await _outs(db, actor, [row]))[0]


async def update(db: AsyncSession, actor: User, feed_id: uuid.UUID, data: FeedUpdate) -> FeedOut:
    """Pause or resume. Resuming fetches soon, and posts nothing published while paused."""
    row = await _managed_row(db, actor, feed_id)
    if data.enabled is not None and data.enabled != row.enabled:
        now = utcnow()
        if data.enabled:
            channel = await channels.require_channel(db, row.channel_id)
            channels.require_writable(channel)
            row.needs_baseline = True
            row.next_fetch_at = now
        row.enabled = data.enabled
        row.updated_at = now
        await db.flush()
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="feed.updated",
            target_type="channel_feed",
            target_id=row.id,
            details={"enabled": data.enabled},
        )
    await db.commit()
    return (await _outs(db, actor, [row]))[0]


async def delete(db: AsyncSession, actor: User, feed_id: uuid.UUID) -> None:
    """The posts stay. The last feed of a channel takes its bot out (deactivated)."""
    row = await _managed_row(db, actor, feed_id)
    bot_id = row.bot_user_id
    if not await repo.bot_in_use(db, bot_id, besides=row.id):
        channel = await channels.find_channel(db, row.channel_id)
        if channel is not None:
            await channels.remove_member_in_tx(db, channel, bot_id)
        await admin.deactivate_bot_in_tx(db, bot_id)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="feed.deleted",
        target_type="channel_feed",
        target_id=row.id,
        details={"url": row.url, "channel_id": str(row.channel_id)},
    )
    await db.delete(row)
    await db.commit()


# --- polling ----------------------------------------------------------------------------------


def _seen_after(old: list[str], entries: list[FeedEntry], *, failed: set[str]) -> list[str]:
    """The current document's keys first (never forgotten while it carries them), then the older
    ones, at most MAX_SEEN. A key whose post failed stays out, so the next fetch tries again."""
    current = [e.key for e in entries if e.key not in failed]
    current_set = set(current)
    merged = list(dict.fromkeys(current))
    merged.extend(k for k in old if k not in current_set and k not in failed)
    return merged[:MAX_SEEN]


def _to_post(row: ChannelFeed, entries: list[FeedEntry], cap: int) -> list[FeedEntry]:
    """The new entries to post: at most `cap` of the newest (undated ones count as new, the
    document's order breaks ties), returned oldest first. Entries dated well before the feed was
    added are backlog."""
    seen = set(row.seen_keys)
    floor = row.created_at - _BACKLOG_MARGIN
    fresh = [
        e for e in entries if e.key not in seen and (e.published is None or e.published >= floor)
    ]
    far = datetime.max.replace(tzinfo=floor.tzinfo)
    newest = sorted(fresh, key=lambda e: e.published or far, reverse=True)[:cap]
    newest.reverse()
    return newest


def _safe(text: str) -> str:
    """No mention syntax from a feed's text (as a workflow's typed values, M94)."""
    return escape_text(text)


def post_body(owner_name: str, entry: FeedEntry) -> str:
    lines = [f"📝 {_safe(owner_name)} の新しい記事: {_safe(entry.title)}"]
    if entry.link:
        lines.append(entry.link)
    if entry.summary and entry.summary != entry.title:
        lines.append(f"> {_safe(entry.summary)}")
    return "\n".join(lines)


def _failure_note(row: ChannelFeed, channel: Channel, failures: int) -> str:
    name = row.title or row.url
    return (
        f"⚠️ #{channel.name} のフィード「{_safe(name)}」の取得が {failures} 回続けて失敗しています"
        f" ({_safe(row.last_error or row.last_error_code or '')})。\n{row.url}\n"
        "URL を確かめてください。チャンネルの詳細の「フィード」で止める・削除できます。"
    )


async def _active_owner(db: AsyncSession, row: ChannelFeed) -> User | None:
    owner = await users.get_users(db, [row.owner_id])
    person = owner.get(row.owner_id)
    if person is None or not person.is_active:
        return None
    if await channels.membership_of(db, person.id, row.channel_id) is None:
        return None
    return person


async def _post_entries(
    db: AsyncSession, row: ChannelFeed, channel: Channel, owner: User, entries: list[FeedEntry]
) -> tuple[int, set[str]]:
    """Posts each entry in its own savepoint; returns how many were posted and the keys whose
    post failed. The row is not touched here (a failed savepoint may expire it)."""
    bot = await users.require_user(db, row.bot_user_id)
    if await channels.membership_of(db, bot.id, channel.id) is None:
        await channels.add_member_in_tx(db, channel, bot.id)
    failed: set[str] = set()
    posted = 0
    feed_id = row.id
    for entry in entries:
        try:
            async with db.begin_nested():
                _, created = await messages.create_message(
                    db,
                    bot,
                    channel.id,
                    MessageCreate(
                        client_msg_id=uuid.uuid5(_POST_NAMESPACE, f"{feed_id}/{entry.key}"),
                        body=post_body(owner.display_name, entry),
                    ),
                    advance_read=False,
                    commit=False,
                    mentions=False,
                )
            if created:
                posted += 1
        except Exception:
            log.exception("feed %s: posting an entry failed", feed_id)
            failed.add(entry.key)
    return posted, failed


async def _notify_owner(db: AsyncSession, row: ChannelFeed, channel: Channel) -> None:
    """A DM from the channel's feed bot to the owner (pushed as any DM)."""
    bot = await users.require_user(db, row.bot_user_id)
    owner = await users.require_user(db, row.owner_id)
    note = _failure_note(row, channel, row.consecutive_failures)
    dm, _ = await channels.get_or_create_dm(db, bot, [owner])
    await messages.create_message(
        db,
        bot,
        dm.id,
        MessageCreate(client_msg_id=uuid.uuid4(), body=note),
        advance_read=False,
        mentions=False,
    )


async def poll_one(
    factory: async_sessionmaker[AsyncSession],
    feed_id: uuid.UUID,
    *,
    settings: Settings,
    fetch: FeedFetcher,
) -> str:
    """One claimed feed: returns what happened ("skipped", "not_modified", "ok", "failed")."""
    async with factory() as db:
        row = await repo.get(db, feed_id)
        if row is None or not row.enabled:
            return "skipped"
        channel = await channels.find_channel(db, row.channel_id)
        owner = await _active_owner(db, row)
        if channel is None or channel.is_archived or owner is None:
            # Not fetched; when it comes back, what was published meanwhile is not posted.
            row.needs_baseline = True
            await db.commit()
            return "skipped"
        url, etag, last_modified = row.url, row.etag, row.last_modified
        await db.commit()

    response: FeedResponse | None = None
    parsed: ParsedFeed | None = None
    failure: FetchFailed | None = None
    try:
        response = await _get(fetch, url, etag, last_modified)
        if response.status != 304:
            parsed = _parse(response)
    except UrlNotAllowed as exc:
        failure = FetchFailed("url_not_allowed", str(exc))
    except FetchFailed as exc:
        failure = exc
    except Exception as exc:  # never let one feed stop the loop
        log.exception("feed %s: fetch failed", feed_id)
        failure = FetchFailed("network", type(exc).__name__)

    now = utcnow()
    async with factory() as db:
        row = await repo.get(db, feed_id, for_update=True)
        if row is None or not row.enabled:
            await db.commit()
            return "skipped"
        row.last_fetched_at = now
        row.updated_at = now
        if failure is not None or response is None:
            assert failure is not None
            row.consecutive_failures += 1
            row.last_error_code = failure.code[:32]
            row.last_error = failure.message or failure.code
            notify = (
                row.consecutive_failures >= settings.feed_failure_notify_after
                and row.failure_notified_at is None
            )
            if notify:
                row.failure_notified_at = now
            await db.commit()
            if notify:
                channel = await channels.find_channel(db, row.channel_id)
                if channel is not None:
                    try:
                        await _notify_owner(db, row, channel)
                    except Exception:
                        log.exception("feed %s: telling the owner failed", feed_id)
                        await db.rollback()
            return "failed"

        row.consecutive_failures = 0
        row.last_error = None
        row.last_error_code = None
        row.failure_notified_at = None
        row.last_success_at = now
        if response.status == 304 or parsed is None:
            await db.commit()
            return "not_modified"

        failed: set[str] = set()
        if not row.needs_baseline:
            channel = await channels.find_channel(db, row.channel_id)
            owner = await _active_owner(db, row)
            if channel is not None and not channel.is_archived and owner is not None:
                chosen = _to_post(row, parsed.entries, settings.feed_max_posts_per_fetch)
                if chosen:
                    await db.flush()  # the bookkeeping above survives a refresh below
                    posted, failed = await _post_entries(db, row, channel, owner, chosen)
                    if failed:
                        await db.refresh(row)
                    if posted:
                        row.post_count += posted
                        row.last_post_at = utcnow()
        row.needs_baseline = False
        row.seen_keys = _seen_after(list(row.seen_keys), parsed.entries, failed=failed)
        if failed:  # fetch the whole document again next time
            row.etag = None
            row.last_modified = None
        else:
            row.etag = (response.etag or "")[:512] or None
            row.last_modified = (response.last_modified or "")[:128] or None
        if parsed.title:
            row.title = parsed.title
        if parsed.site_url:
            row.site_url = parsed.site_url
        await db.commit()
        return "ok"


async def poll_due(
    factory: async_sessionmaker[AsyncSession],
    *,
    settings: Settings,
    fetch: FeedFetcher,
    now: datetime | None = None,
    limit: int = 20,
) -> int:
    """The worker: claims the due feeds (next_fetch_at moved one interval on, committed, so a
    slow or crashing fetch is not retried at once) and fetches them one by one. Returns how many
    were fetched."""
    moment = now or utcnow()
    async with factory() as db:
        rows = await repo.claim_due(db, moment, limit)
        ids = [row.id for row in rows]
        for row in rows:
            row.next_fetch_at = moment + timedelta(minutes=settings.feed_poll_interval_minutes)
        await db.commit()
    fetched = 0
    for feed_id in ids:
        try:
            if await poll_one(factory, feed_id, settings=settings, fetch=fetch) != "skipped":
                fetched += 1
        except Exception:
            log.exception("feed %s: polling failed", feed_id)
    return fetched
