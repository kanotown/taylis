"""Command-line tools: ``uv run python -m app.cli <command>``."""

import argparse
import asyncio
import getpass
import json
import os
import re
import sys
import unicodedata
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


def cmd_export_openapi(args: argparse.Namespace) -> int:
    from app.core.settings import build_settings
    from app.main import create_app

    settings = build_settings(
        environment="test", secret_key="openapi-export-" + "0" * 32, log_json=False
    )
    spec = create_app(settings).openapi()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(spec, indent=2, ensure_ascii=False, sort_keys=True) + "\n")
    print(f"wrote {out}")

    from app.modules.sync.catalog import ws_events_document

    ws_out = out.parent / "ws-events.json"
    ws_out.write_text(
        json.dumps(ws_events_document(), indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    )
    print(f"wrote {ws_out}")
    return 0


USERNAME_PATTERN = re.compile(r"^[a-z0-9._-]{3,32}$")


async def _insert_user(
    *, username: str, display_name: str, password: str | None, role: str, must_change_password: bool
) -> str:
    from app.core.db import Database
    from app.core.errors import AppError
    from app.core.settings import get_settings
    from app.modules.admin.schemas import AdminUserCreate
    from app.modules.admin.service import create_user

    db = Database(get_settings().database_url)
    try:
        async with db.session_factory() as session:
            try:
                _, secret = await create_user(
                    session,
                    AdminUserCreate(username=username, display_name=display_name, role=role),  # type: ignore[arg-type]
                    password=password,
                    must_change_password=must_change_password,
                )
            except AppError as exc:
                raise SystemExit(f"error: {exc.message}") from exc
            return secret
    finally:
        await db.dispose()


def _validate_username(username: str) -> str:
    if not USERNAME_PATTERN.match(username):
        raise SystemExit("error: username must match [a-z0-9._-]{3,32}")
    return username


def cmd_create_admin(args: argparse.Namespace) -> int:
    """Create an administrator with a password chosen now (no forced change)."""
    from app.core.settings import get_settings

    minimum = get_settings().password_min_length
    username = _validate_username(args.username)
    password = args.password or getpass.getpass(f"Password (min {minimum} chars): ")
    if not args.password and password != getpass.getpass("Repeat password: "):
        raise SystemExit("error: passwords do not match")
    if len(password) < minimum:
        raise SystemExit(f"error: password must be at least {minimum} characters")
    asyncio.run(
        _insert_user(
            username=username,
            display_name=args.display_name or username,
            password=password,
            role="admin",
            must_change_password=False,
        )
    )
    print(f"created admin '{username}'")
    return 0


def cmd_create_user(args: argparse.Namespace) -> int:
    """Create a member with a temporary password that must be changed at first login."""
    username = _validate_username(args.username)
    temporary = asyncio.run(
        _insert_user(
            username=username,
            display_name=args.display_name or username,
            password=None,
            role=args.role,
            must_change_password=True,
        )
    )
    print(f"created {args.role} '{username}'")
    print(f"temporary password (shown once): {temporary}")
    return 0


async def _push_test(username: str, body: str) -> int:
    from sqlalchemy import select

    from app.core.db import Database
    from app.core.settings import get_settings
    from app.core.time import utcnow
    from app.modules.auth.models import Device
    from app.modules.notifications.providers import build_providers
    from app.modules.notifications.schemas import PushPayload
    from app.modules.users.models import User
    from app.modules.workspace import service as workspace

    settings = get_settings()
    providers = build_providers(settings)
    db = Database(settings.database_url)
    try:
        async with db.session_factory() as session:
            user = (
                await session.execute(select(User).where(User.username == username))
            ).scalar_one_or_none()
            if user is None:
                raise SystemExit(f"error: user '{username}' not found")
            devices = list(
                (
                    await session.execute(
                        select(Device).where(
                            Device.user_id == user.id,
                            Device.enabled.is_(True),
                            Device.push_token.is_not(None),
                        )
                    )
                ).scalars()
            )
            if not devices:
                print(f"no push-registered devices for '{username}'")
                return 1
            payload = PushPayload(
                kind="test",
                workspace_id=await workspace.workspace_id(session),
                title="Taylis",
                body=body,
                sent_at=utcnow(),
            ).model_dump(mode="json")
            for device in devices:
                provider = providers[device.push_provider]
                result = await provider.send(device, payload)
                label = f"{device.platform} {device.push_provider} ({device.push_environment})"
                print(f"{label} -> {result.outcome} {result.detail or ''}")
                if result.outcome == "invalid_token":
                    device.push_token = None
                    device.push_token_invalid_reason = result.detail or "invalid_token"
            await session.commit()
        return 0
    finally:
        await db.dispose()


async def _verify_attachments() -> int:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.attachments import service as attachments
    from app.modules.attachments.blobstore import build_blobstore

    settings = get_settings()
    db = Database(settings.database_url)
    blobs = build_blobstore(settings)
    try:
        async with db.session_factory() as session:
            missing = await attachments.verify(session, blobs)
        for attachment_id, key in missing:
            print(f"missing blob: attachment {attachment_id} key {key}")
        print(f"{len(missing)} missing object(s)")
        return 1 if missing else 0
    finally:
        await db.dispose()


async def _anonymize_user(username: str) -> int:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.admin import service as admin
    from app.modules.attachments.blobstore import build_blobstore
    from app.modules.users import service as users

    settings = get_settings()
    db = Database(settings.database_url)
    try:
        async with db.session_factory() as session:
            user = await users.get_by_username(session, username)
            if user is None:
                print(f"no such user: {username}", file=sys.stderr)
                return 1
            anonymized = await admin.anonymize_user(
                session, None, user.id, build_blobstore(settings)
            )
            print(f"anonymized {username} -> {anonymized.username}")
            return 0
    finally:
        await db.dispose()


def cmd_anonymize_user(args: argparse.Namespace) -> int:
    """Erase a user's identity while keeping the channel history (M10)."""
    return asyncio.run(_anonymize_user(args.username))


async def export_channel_lines(session: Any, channel_id: uuid.UUID) -> list[str]:
    """JSONL lines for a channel: one per message (with reactions and attachment metadata), then
    one per canvas (`"type": "canvas"`, M41)."""
    from app.modules.canvases import service as canvases
    from app.modules.messages import service as messages
    from app.modules.users import service as users

    names = {u.id: u.username for u in await users.list_users(session)}
    lines: list[str] = []
    for message in await messages.export_rows(session, channel_id):
        record = message.model_dump(mode="json")
        record["sender_username"] = names.get(message.sender_id)
        lines.append(json.dumps(record, ensure_ascii=False))
    # M41 (CANVAS.md §4.14): the conversation's canvases after its messages, marked by "type".
    for canvas in await canvases.export_rows(session, channel_id):
        record = {"type": "canvas", **canvas.model_dump(mode="json")}
        record["created_by_username"] = names.get(canvas.created_by)
        lines.append(json.dumps(record, ensure_ascii=False))
    return lines


async def _export_channel(channel: str) -> list[str] | None:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.channels import repository as channels_repo

    db = Database(get_settings().database_url)
    try:
        async with db.session_factory() as session:
            try:
                record = await channels_repo.get_channel(session, uuid.UUID(channel))
            except ValueError:
                record = await channels_repo.get_channel_by_name(session, channel)
            if record is None:
                return None
            return await export_channel_lines(session, record.id)
    finally:
        await db.dispose()


def cmd_export_channel(args: argparse.Namespace) -> int:
    """Write a channel's history as JSONL (M10): a portable, grep-able archive."""
    lines = asyncio.run(_export_channel(args.channel))
    if lines is None:
        print(f"no such channel: {args.channel}", file=sys.stderr)
        return 1
    Path(args.out).write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    print(f"wrote {len(lines)} messages to {args.out}")
    return 0


def cmd_verify_attachments(args: argparse.Namespace) -> int:
    """After a restore: report attachment rows whose bytes are missing (ARCHITECTURE.md §8)."""
    return asyncio.run(_verify_attachments())


async def _probe_videos(limit: int) -> int:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.attachments.blobstore import build_blobstore
    from app.modules.attachments.video_backfill import probe_stored_videos

    settings = get_settings()
    db = Database(settings.database_url)
    blobs = build_blobstore(settings)
    try:
        async with db.session_factory() as session:
            try:
                result = await probe_stored_videos(session, blobs, settings, limit=limit)
            except RuntimeError as exc:
                raise SystemExit(f"error: {exc}") from exc
        print(
            f"probed {result.probed} video(s): {result.found} now have a size or poster, "
            f"{result.announced} message(s) updated"
        )
        if result.remaining:
            print("more videos are left: run it again")
        return 0
    finally:
        await db.dispose()


def cmd_probe_videos(args: argparse.Namespace) -> int:
    """M79: size, length and poster of the videos stored before M79 (resumable)."""
    if args.limit < 1:
        raise SystemExit("error: --limit must be at least 1")
    return asyncio.run(_probe_videos(args.limit))


async def _generate_previews(limit: int, retry_failed: bool) -> int:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.attachments.blobstore import build_blobstore
    from app.modules.attachments.previews import build_converter, generate_stored

    settings = get_settings()
    db = Database(settings.database_url)
    blobs = build_blobstore(settings)
    converter = build_converter(settings)
    if converter is None:
        print("PREVIEW_CONVERTER_URL is not set: only PDFs get previews", file=sys.stderr)
    try:
        async with db.session_factory() as session:
            try:
                result = await generate_stored(
                    session, blobs, converter, settings, limit=limit, retry_failed=retry_failed
                )
            except RuntimeError as exc:
                raise SystemExit(f"error: {exc}") from exc
        print(
            f"tried {result.tried} file(s): {result.ready} ready, {result.failed} failed, "
            f"{result.retrying} left to the server's retries"
        )
        if result.remaining:
            print("more files are left: run it again")
        return 0
    finally:
        await db.dispose()


def cmd_generate_previews(args: argparse.Namespace) -> int:
    """M108: previews of the PDFs and Office files stored before previews (resumable)."""
    if args.limit < 1:
        raise SystemExit("error: --limit must be at least 1")
    return asyncio.run(_generate_previews(args.limit, args.retry_failed))


def cmd_push_test(args: argparse.Namespace) -> int:
    """Send a test notification to every push-registered device of a user."""
    return asyncio.run(_push_test(args.username, args.body))


def mattermost_dsn(args: argparse.Namespace) -> str | None:
    """--dsn, then $MM_DSN, then SqlSettings.DataSource of Mattermost's config.json (--mm-config):
    the password need not appear on a command line."""
    if args.dsn:
        return str(args.dsn)
    if os.environ.get("MM_DSN"):
        return os.environ["MM_DSN"]
    if args.mm_config:
        config = json.loads(Path(args.mm_config).read_text(encoding="utf-8"))
        source = config.get("SqlSettings", {}).get("DataSource")
        return str(source) if source else None
    return None


def cmd_mattermost_extract(args: argparse.Namespace) -> int:
    """Read one Mattermost team into a JSONL file (M18); Mattermost itself is only read."""
    from app.modules.importer.mattermost_extract import extract_team

    dsn = mattermost_dsn(args)
    if dsn is None:
        print("give --mm-config, --dsn or $MM_DSN", file=sys.stderr)
        return 2
    try:
        counts = asyncio.run(extract_team(dsn, args.team, Path(args.out)))
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {args.out}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    return 0


def parse_user_map(pairs: Sequence[str], source: str = "MATTERMOST") -> dict[str, str]:
    mapping: dict[str, str] = {}
    for pair in pairs:
        mm, sep, chikuwa = pair.partition("=")
        if not sep or not mm.strip() or not chikuwa.strip():
            raise ValueError(f"--user {pair}: use {source}_NAME=CHIKUWA_NAME")
        mapping[mm.strip().lstrip("@").lower()] = chikuwa.strip().lstrip("@").lower()
    return mapping


_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_DOMAIN = re.compile(rf"^(?=.{{1,253}}$){_LABEL}(?:\.{_LABEL})+$")


def parse_domain(value: str) -> str:
    domain = value.strip().lower().lstrip("@")
    if not _DOMAIN.match(domain):
        raise ValueError(f"{value!r} is not a mail domain (e.g. g.example.ac.jp)")
    return domain


def parse_domain_map(pairs: Sequence[str]) -> dict[str, str]:
    """``--email-domain-map FROM=TO`` (M91), repeatable; the domains in lower case."""
    mapping: dict[str, str] = {}
    for pair in pairs:
        old, sep, new = pair.partition("=")
        if not sep:
            raise ValueError(f"--email-domain-map {pair}: use FROM=TO (e.g. vc.example=g.example)")
        old, new = parse_domain(old), parse_domain(new)
        if mapping.get(old, new) != new:
            raise ValueError(f"--email-domain-map: {old} is mapped twice")
        mapping[old] = new
    return mapping


def parse_bot_as(pairs: Sequence[str]) -> dict[str, str]:
    """``--bot-as BOTNAME=TARGET`` (M92), repeatable; the bot names compared in lower case.
    TARGET (a Slack user, ``@taylis-user`` or ``new:<display name>[:guest]``) is checked by the
    import, which knows the export's people."""
    mapping: dict[str, str] = {}
    for pair in pairs:
        bot, sep, target = pair.partition("=")
        bot, target = bot.strip(), target.strip()
        if not sep or not bot or not target:
            raise ValueError(
                f"--bot-as {pair}: use BOTNAME=TARGET (a Slack user, @taylis-user or "
                "new:<display name>[:guest])"
            )
        key = unicodedata.normalize("NFC", bot.lower())
        if mapping.get(key, target) != target:
            raise ValueError(f"--bot-as: {bot} is mapped twice")
        mapping[key] = target
    return mapping


def parse_bot_names(pairs: Sequence[str]) -> dict[str, str]:
    """``--bot-name BOT=NAME`` (M98), repeatable: BOT is a bot_id, a post's username or the
    bot_profile.name (any case); NAME the display name of the bot account made for it."""
    mapping: dict[str, str] = {}
    for pair in pairs:
        bot, sep, name = pair.partition("=")
        bot, name = bot.strip(), name.strip()
        if not sep or not bot or not name or len(name) > 80:
            raise ValueError(f"--bot-name {pair}: use BOT=NAME (a display name of 1-80 characters)")
        key = unicodedata.normalize("NFC", bot.lower())
        if mapping.get(key, name) != name:
            raise ValueError(f"--bot-name: {bot} is named twice")
        mapping[key] = name
    return mapping


def parse_emoji_renames(pairs: Sequence[str], files: Sequence[str] = ()) -> dict[str, str]:
    """``--emoji-rename FROM=TO`` and the lines of ``--emoji-rename-file`` (``FROM=TO``, blank
    lines and ``#`` comments skipped) (M92). TO must be a custom emoji name."""
    from app.modules.emoji.service import NAME

    entries = [(f"--emoji-rename {pair}", pair) for pair in pairs]
    for path in files:
        text = Path(path).read_text(encoding="utf-8")
        for number, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if line and not line.startswith("#"):
                entries.append((f"{path}:{number}", line))
    mapping: dict[str, str] = {}
    for where, pair in entries:
        old, sep, new = pair.partition("=")
        old = unicodedata.normalize("NFC", old.strip().strip(":"))
        new = new.strip().strip(":").lower()
        if not sep or not old or not new:
            raise ValueError(f"{where}: use FROM=TO (e.g. 完了=kanryo)")
        if not NAME.match(new):
            raise ValueError(
                f"{where}: {new!r} is not a custom emoji name (a-z 0-9 _ + -, 2 to 32 characters)"
            )
        if mapping.get(old, new) != new:
            raise ValueError(f"{where}: {old} is renamed twice")
        mapping[old] = new
    return mapping


def _width(text: str) -> int:
    """Columns on a terminal: CJK characters take two."""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def _fit(text: str, width: int) -> str:
    """``text`` cut to ``width`` columns (with …) and padded to it."""
    if _width(text) > width:
        out = ""
        for char in text:
            if _width(out + char) > width - 1:
                break
            out += char
        text = out + "…"
    return text + " " * (width - _width(text))


def print_people_table(report: Any) -> None:
    """M91: one line per source person — who they were there, who they are here and why —
    grouped by what happens to them, then the counts. What the administrator reviews before the
    real run."""
    from app.modules.importer.core import ACTIONS

    rows = sorted(
        report.people_rows,
        key=lambda r: (ACTIONS.index(r.action), r.name.lower(), r.source_id),
    )
    headers = ("Slack id", "name", "Slack email", "→ username", "email", "action")
    cells = [
        (r.source_id, r.name, r.source_email or "-", r.username or "-", r.email or "-", r.action)
        for r in rows
    ]
    caps = (14, 34, 40, 24, 40, 24)
    widths = [
        min(cap, max([_width(h)] + [_width(c[i]) for c in cells]))
        for i, (h, cap) in enumerate(zip(headers, caps, strict=True))
    ]
    print(f"people ({len(rows)}):")
    print("  " + "  ".join(_fit(h, w) for h, w in zip(headers, widths, strict=True)).rstrip())
    print("  " + "  ".join("-" * w for w in widths))
    last = None
    for row, cell in zip(rows, cells, strict=True):
        if last is not None and row.action != last:
            print()
        last = row.action
        print("  " + "  ".join(_fit(c, w) for c, w in zip(cell, widths, strict=True)).rstrip())
    print("people by action:")
    counts = {a: sum(1 for r in rows if r.action == a) for a in ACTIONS}
    for action, count in counts.items():
        if count:
            print(f"  {action}: {count}")


def print_import_report(report: Any) -> None:
    """The summary of an import (M18, M87): people, counts, per channel, emoji, files, warnings."""
    print("dry run: nothing was written" if report.dry_run else "imported")
    if report.people_rows:
        print_people_table(report)
    else:
        print("people:")
        for line in report.people:
            print(f"  {line}")
    if report.unmapped:
        print("people nobody was mapped to (new accounts; map them with --user and run again):")
        for line in report.unmapped:
            print(f"  {line}")
    print("counts:")
    for key, value in sorted(report.counts.items()):
        if not key.startswith("people: "):  # in the table's own counts
            print(f"  {key}: {value}")
    if report.channels:
        print("per channel:")
        for label, counts in sorted(report.channels.items()):
            print(f"  {label}: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    if report.unmatched_emoji:
        # Names a custom emoji can take (NAME in app.modules.emoji.service) show up once added.
        from app.modules.emoji.service import NAME

        print("reactions without an emoji image (add a custom emoji of the same name to show it):")
        from app.modules.importer.core import standard_glyph

        for name, count in report.unmatched_emoji.most_common():
            note = "" if NAME.match(name) else "  (not a valid custom emoji name)"
            glyph = standard_glyph(name)
            if glyph is not None:  # M92: a keycap, which a reaction cannot be as a glyph
                note = f"  (a reaction cannot be {glyph}; a custom emoji :{name}: would show)"
            print(f"  :{name}: {count} times{note}")
    if getattr(report, "emoji_lines", None):
        print("custom emoji (--emoji-dir / --emoji-rename):")
        for line in report.emoji_lines:
            print(f"  {line}")
    if report.dropped_emoji:
        print("reactions not imported (the name is not a valid reaction):")
        for name, count in report.dropped_emoji.most_common():
            hint = "" if name.isascii() else "  (give it a name with --emoji-rename FROM=TO)"
            print(f"  {name} {count} times{hint}")
    if report.failed_files:
        print(f"files not brought over ({len(report.failed_files)}):")
        for line in report.failed_files[:500]:
            print(f"  {line}")
        if len(report.failed_files) > 500:
            print(f"  … and {len(report.failed_files) - 500} more")
    if report.warnings:
        print(f"warnings ({len(report.warnings)}):")
        for line in report.warnings[:200]:
            print(f"  {line}")
        if len(report.warnings) > 200:
            print(f"  … and {len(report.warnings) - 200} more")


async def _import_mattermost(args: argparse.Namespace) -> int:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.attachments.blobstore import build_blobstore
    from app.modules.importer.mattermost_import import ImportFailed, import_mattermost

    settings = get_settings()
    db = Database(settings.database_url)
    try:
        async with db.session_factory() as session:
            try:
                report = await import_mattermost(
                    session,
                    Path(args.file),
                    files_root=Path(args.files) if args.files else None,
                    user_map=parse_user_map(args.user or []),
                    actor_username=args.actor,
                    blobs=build_blobstore(settings),
                    settings=settings,
                    dry_run=args.dry_run,
                    refresh_emoji=args.refresh_emoji,
                )
            except (ImportFailed, ValueError) as exc:
                print(f"Error: {exc}", file=sys.stderr)
                return 1
    finally:
        await db.dispose()
    print_import_report(report)
    return 0


def cmd_import_mattermost(args: argparse.Namespace) -> int:
    """Import a mattermost-extract file (M18). Safe to run again: only new posts are added."""
    return asyncio.run(_import_mattermost(args))


def read_secret_file(path: str | None) -> str | None:
    """A secret from a file (never from argv: it would stay in the shell history)."""
    if not path:
        return None
    value = Path(path).read_text(encoding="utf-8").strip()
    if not value:
        raise ValueError(f"{path} is empty")
    return value


async def _import_slack(args: argparse.Namespace) -> int:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.attachments.blobstore import build_blobstore
    from app.modules.importer.core import ImportFailed
    from app.modules.importer.slack_import import FileSource, Options, import_slack

    if args.download and args.files_dir:
        print("Error: give --download or --files-dir, not both", file=sys.stderr)
        return 2
    if args.download and not args.files_cache:
        print("Error: --download needs --files-cache DIR (resumable)", file=sys.stderr)
        return 2
    if args.slack_token_file and not args.download:
        print("Error: --slack-token-file is for --download", file=sys.stderr)
        return 2
    try:
        token = read_secret_file(args.slack_token_file)
        user_map = parse_user_map(args.user or [], "SLACK")
        domain_map = parse_domain_map(args.email_domain_map or [])
        activate = [parse_domain(d) for d in args.activate_domain or []]
        bot_as = parse_bot_as(args.bot_as or [])
        bot_names = parse_bot_names(args.bot_name or [])
        renames = parse_emoji_renames(args.emoji_rename or [], args.emoji_rename_file or [])
    except (OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    files = FileSource(
        files_dir=Path(args.files_dir) if args.files_dir else None,
        cache_dir=Path(args.files_cache) if args.files_cache else None,
        download=args.download,
        token=token,
        concurrency=args.download_concurrency,
    )
    options = Options(
        channel_prefix=args.channel_prefix or "",
        include_private=args.include_private,
        include_dms=args.include_dms,
        emoji_dir=Path(args.emoji_dir) if args.emoji_dir else None,
        bot_as=bot_as,
        bot_names=bot_names,
        emoji_renames=renames,
    )
    settings = get_settings()
    db = Database(settings.database_url)
    try:
        async with db.session_factory() as session:
            try:
                report = await import_slack(
                    session,
                    Path(args.export),
                    files=files,
                    options=options,
                    user_map=user_map,
                    actor_username=args.actor,
                    blobs=build_blobstore(settings),
                    settings=settings,
                    dry_run=args.dry_run,
                    email_domain_map=domain_map,
                    activate_domains=activate,
                    people_only=args.people_only,
                )
            except (ImportFailed, ValueError) as exc:
                print(f"Error: {exc}", file=sys.stderr)
                return 1
    finally:
        await db.dispose()
    if args.people_only:
        print("people only: nothing was written (channels, messages and files not looked at)")
        print_people_table(report)
        for line in report.warnings:
            print(f"warning: {line}")
        return 0
    print_import_report(report)
    if report.dry_run and args.download:
        print("(the dry run filled --files-cache; the real run reuses it)")
    return 0


def cmd_import_slack(args: argparse.Namespace) -> int:
    """Import a Slack export ZIP (M87). Safe to run again: only new messages are added."""
    return asyncio.run(_import_slack(args))


def _notion_user_map(pairs: Sequence[str], files: Sequence[str]) -> dict[str, str]:
    """NOTION_NAME=USERNAME pairs (--user) and lines of files (--user-map, # comments). The
    Notion name keeps its case and spaces (a display name)."""
    lines = list(pairs)
    for path in files:
        lines += Path(path).read_text(encoding="utf-8").splitlines()
    mapping: dict[str, str] = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, username = line.rpartition("=")
        if not sep or not name.strip() or not username.strip():
            raise ValueError(f"{line!r}: use NOTION_NAME=USERNAME")
        mapping[name.strip().lstrip("@")] = username.strip().lstrip("@")
    return mapping


def print_notion_report(report: Any) -> None:
    """The summary of a Notion import (M125): counts, databases and their guessed types, links
    and files that did not come, blocks written another way, pages left as edited."""
    print("dry run: nothing was written" if report.dry_run else "imported")
    print("counts:")
    for key, value in sorted(report.counts.items()):
        print(f"  {key}: {value}")
    if report.databases:
        print("databases (column: guessed type):")
        for line in report.databases:
            extra = []
            if line.extra_rows:
                extra.append(f"{line.extra_rows} row pages not in the CSV (templates?)")
            if line.csv_only:
                extra.append(f"{line.csv_only} CSV rows without a page")
            if line.calendar:
                extra.append("calendar view added")
            print(f"  {line.title}: {line.rows} rows" + (f" ({'; '.join(extra)})" if extra else ""))
            for column in line.columns:
                note = f"  ({column.note})" if column.note else ""
                print(f"    {column.name}: {column.type}{note}")
    if report.unsupported:
        print("written another way:")
        for what, count in report.unsupported.most_common():
            print(f"  {what}: {count}")
    sections = (
        ("pages changed in Taylis since the last import (left as they are)", report.edited),
        ("links that do not lead to an imported page or file", report.unresolved_links),
        ("files not brought over", report.failed_files),
        ("warnings", report.warnings),
    )
    for title, lines in sections:
        if not lines:
            continue
        print(f"{title} ({len(lines)}):")
        for line in lines[:300]:
            print(f"  {line}")
        if len(lines) > 300:
            print(f"  … and {len(lines) - 300} more")
    if report.roots and not report.dry_run:
        print("imported top pages: " + ", ".join(str(r) for r in report.roots))


async def _import_notion(args: argparse.Namespace, options: Any) -> int:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.attachments.blobstore import build_blobstore
    from app.modules.importer.core import ImportFailed
    from app.modules.importer.notion_import import import_notion

    settings = get_settings()
    db = Database(settings.database_url)
    try:
        async with db.session_factory() as session:
            try:
                report = await import_notion(
                    session,
                    Path(args.export),
                    actor_username=args.actor,
                    blobs=build_blobstore(settings),
                    settings=settings,
                    options=options,
                    dry_run=args.dry_run,
                )
            except (ImportFailed, ValueError) as exc:
                print(f"Error: {exc}", file=sys.stderr)
                return 1
    finally:
        await db.dispose()
    print_notion_report(report)
    return 0


def cmd_import_notion(args: argparse.Namespace) -> int:
    """Import a Notion export into Docs (M125, docs/WIKI.md §6). Safe to run again."""
    import uuid

    from app.modules.importer.notion_import import Options, parse_column_types

    try:
        user_map = _notion_user_map(args.user or [], args.user_map or [])
        column_types = (
            parse_column_types(Path(args.column_types).read_text(encoding="utf-8").splitlines())
            if args.column_types
            else {}
        )
        parent = uuid.UUID(args.parent) if args.parent else None
    except (OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    options = Options(
        parent_id=parent,
        access=args.access,
        user_map=user_map,
        column_types=column_types,
        timezone=args.timezone,
        progress=lambda message: print(message, file=sys.stderr, flush=True),
    )
    return asyncio.run(_import_notion(args, options))


async def _import_emoji_presets(directory: str, restore: Sequence[str]) -> int:
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.attachments.blobstore import build_blobstore
    from app.modules.emoji import presets

    settings = get_settings()
    blobs = build_blobstore(settings)
    db = Database(settings.database_url)
    try:
        async with db.session_factory() as session:
            report = await presets.import_presets(
                session, Path(directory), settings, blobs, restore=restore
            )
    finally:
        await db.dispose()
    for warning in report.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    print(report.summary())
    if report.busy:
        return 2
    return 1 if report.failed or report.no_admin else 0


def cmd_import_emoji_presets(args: argparse.Namespace) -> int:
    """M102 (docs/EMOJI.md §8): what the app does at startup, now (e.g. after copying art)."""
    from app.core.settings import get_settings

    directory = args.dir or get_settings().emoji_presets_dir
    if not directory:
        raise SystemExit("error: set EMOJI_PRESETS_DIR or pass --dir")
    return asyncio.run(_import_emoji_presets(directory, args.restore))


def _write_private(path: str, body: str) -> Path:
    """Write a file only its owner can read (created with mode 600, never world-readable)."""
    out = Path(path)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(body + "\n")
    out.chmod(0o600)
    return out


async def _seed_demo(args: argparse.Namespace) -> int:
    from app.core.settings import get_settings
    from app.demo.content import WORKSPACE_NAME
    from app.demo.seed import DemoSeedError, seed_demo

    try:
        review_password = read_secret_file(args.review_password_file)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"error: {exc}") from exc
    review_password = review_password or os.environ.get("DEMO_REVIEW_PASSWORD") or None
    try:
        outcome = await seed_demo(
            get_settings(),
            reset=args.reset,
            i_know=args.i_know,
            review_username=_validate_username(args.review_user),
            review_password=review_password,
        )
    except DemoSeedError as exc:
        raise SystemExit(f"error: {exc}") from exc
    if outcome.status == "already_seeded":
        note = " (review password updated)" if review_password else ""
        print(f"the demo lab is already in this database{note}; --reset seeds it again")
        return 0
    print(
        f"seeded {WORKSPACE_NAME!r}: {outcome.messages} posts"
        + (" after reset" if args.reset else "")
    )
    lines = [f"{username}\t{password}" for username, password in outcome.credentials.items()]
    if args.credentials_out:
        out = _write_private(args.credentials_out, "username\tpassword\n" + "\n".join(lines))
        print(f"passwords of the {len(lines)} new accounts written to {out}")
    else:
        print("passwords (shown once; tanaka is the administrator):")
        for line in lines:
            print(f"  {line}")
    return 0


def cmd_seed_demo(args: argparse.Namespace) -> int:
    return asyncio.run(_seed_demo(args))


async def _wiki_acl(rebuild: bool) -> int:
    """M120 (docs/WIKI.md §4.6): compare wiki_effective_grants (and the pages' paths) with a
    recomputation from the roots; --rebuild rewrites the table first."""
    from app.core.db import Database
    from app.core.settings import get_settings
    from app.modules.wiki import access

    settings = get_settings()
    db = Database(settings.database_url)
    try:
        async with db.session_factory() as session:
            if rebuild:
                pages = await access.rebuild(session)
                await session.commit()
                print(f"rebuilt the effective access of {pages} page(s)")
            problems = await access.verify(session)
        for problem in problems[:100]:
            print(problem)
        if len(problems) > 100:
            print(f"… and {len(problems) - 100} more")
        print(f"{len(problems)} difference(s)")
        return 1 if problems else 0
    finally:
        await db.dispose()


def cmd_wiki_acl(args: argparse.Namespace) -> int:
    return asyncio.run(_wiki_acl(args.rebuild))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    admin = sub.add_parser("create-admin", help="create an administrator account")
    admin.add_argument("--username", required=True)
    admin.add_argument("--display-name")
    admin.add_argument("--password", help="omit to be prompted")
    admin.set_defaults(func=cmd_create_admin)

    user = sub.add_parser("create-user", help="create a user with a temporary password")
    user.add_argument("--username", required=True)
    user.add_argument("--display-name")
    user.add_argument("--role", choices=["member", "admin"], default="member")
    user.set_defaults(func=cmd_create_user)

    push = sub.add_parser("push-test", help="send a test push notification to a user's devices")
    push.add_argument("--user", dest="username", required=True)
    push.add_argument("--body", default="テスト通知です")
    push.set_defaults(func=cmd_push_test)

    verify = sub.add_parser("verify-attachments", help="report attachments whose bytes are missing")
    verify.set_defaults(func=cmd_verify_attachments)

    probe = sub.add_parser(
        "probe-videos", help="fill in the size and poster of videos uploaded before M79"
    )
    probe.add_argument("--limit", type=int, default=1000, help="at most this many a run")
    probe.set_defaults(func=cmd_probe_videos)

    gen_previews = sub.add_parser(
        "generate-previews",
        help="make previews of PDFs and Office files stored before previews (docs/PREVIEWS.md)",
    )
    gen_previews.add_argument("--limit", type=int, default=200, help="at most this many a run")
    gen_previews.add_argument(
        "--retry-failed", action="store_true", help="also try again the ones that failed"
    )
    gen_previews.set_defaults(func=cmd_generate_previews)

    anonymize = sub.add_parser("anonymize-user", help="erase a user's identity, keep the history")
    anonymize.add_argument("--username", required=True)
    anonymize.set_defaults(func=cmd_anonymize_user)

    export_channel = sub.add_parser("export-channel", help="write a channel's messages as JSONL")
    export_channel.add_argument("--channel", required=True, help="channel name or id")
    export_channel.add_argument("--out", required=True)
    export_channel.set_defaults(func=cmd_export_channel)

    mm_extract = sub.add_parser(
        "mattermost-extract", help="read one Mattermost team into a JSONL file (read-only)"
    )
    mm_extract.add_argument("--mm-config", help="Mattermost's config.json (for its DataSource)")
    mm_extract.add_argument("--dsn", help="Mattermost's PostgreSQL URL (or set $MM_DSN)")
    mm_extract.add_argument("--team", required=True, help="the team's name (URL), e.g. ebi")
    mm_extract.add_argument("--out", required=True)
    mm_extract.set_defaults(func=cmd_mattermost_extract)

    mm_import = sub.add_parser("import-mattermost", help="import a mattermost-extract file")
    mm_import.add_argument("file")
    mm_import.add_argument("--files", help="Mattermost's data directory (attachments, emoji)")
    mm_import.add_argument(
        "--user",
        action="append",
        metavar="MM=CHIKUWA",
        help="map a Mattermost username to an existing account (repeatable)",
    )
    mm_import.add_argument("--actor", required=True, help="the administrator running the import")
    mm_import.add_argument("--dry-run", action="store_true", help="check everything, write nothing")
    mm_import.add_argument(
        "--refresh-emoji",
        action="store_true",
        help="read emoji imported before again (an animated GIF stored as its first frame moves)",
    )
    mm_import.set_defaults(func=cmd_import_mattermost)

    sl = sub.add_parser("import-slack", help="import a Slack export ZIP (public channels)")
    sl.add_argument("export", help="the export ZIP (or the folder it was unpacked into)")
    sl.add_argument("--actor", required=True, help="the administrator running the import")
    sl.add_argument(
        "--user",
        action="append",
        metavar="SLACK=CHIKUWA",
        help="map a Slack username, display name, user id or e-mail address to an existing "
        "account (repeatable)",
    )
    sl.add_argument(
        "--email-domain-map",
        action="append",
        metavar="FROM=TO",
        help="treat a Slack address local@FROM as local@TO, for matching and for new accounts "
        "(repeatable)",
    )
    sl.add_argument(
        "--activate-domain",
        action="append",
        metavar="DOMAIN",
        help="create regular Slack members whose (mapped) address is in DOMAIN as active "
        "accounts that sign in with Google (repeatable)",
    )
    sl.add_argument(
        "--people-only",
        action="store_true",
        help="print only the people table (writes nothing, no channels / files)",
    )
    sl.add_argument("--channel-prefix", help="put before every new channel name, e.g. slack-")
    sl.add_argument("--download", action="store_true", help="download the files from Slack")
    sl.add_argument(
        "--slack-token-file", help="a file holding a Slack token for the downloads (optional)"
    )
    sl.add_argument("--files-cache", help="where downloads are kept (a rerun resumes from it)")
    sl.add_argument("--download-concurrency", type=int, default=4, help="downloads at once")
    sl.add_argument("--files-dir", help="files downloaded beforehand (<file id>/<name>, …)")
    sl.add_argument(
        "--bot-as",
        action="append",
        metavar="BOTNAME=TARGET",
        help="import a bot's posts (bot_message username / bot_profile.name, any case) as a "
        "person's: a Slack user (id, username, display name, e-mail), @taylis-username, or "
        "new:<display name>[:guest] for a new deactivated account (repeatable)",
    )
    sl.add_argument(
        "--bot-name",
        action="append",
        metavar="BOT=NAME",
        help="the display name of the bot account made for BOT (its bot_id, a post's username "
        "or bot_profile.name, any case), e.g. a bot that posted under many names (repeatable)",
    )
    sl.add_argument(
        "--emoji-dir", help="custom emoji images named <name>.png / .gif / …: a folder or a ZIP"
    )
    sl.add_argument(
        "--emoji-rename",
        action="append",
        metavar="FROM=TO",
        help="the Slack custom emoji FROM becomes the custom emoji TO (image, reactions, "
        ":FROM: in text) (repeatable)",
    )
    sl.add_argument(
        "--emoji-rename-file",
        action="append",
        metavar="PATH",
        help="FROM=TO lines (# comments) as for --emoji-rename (repeatable)",
    )
    sl.add_argument("--include-private", action="store_true", help="also groups.json")
    sl.add_argument("--include-dms", action="store_true", help="also dms.json and mpims.json")
    sl.add_argument("--dry-run", action="store_true", help="check everything, write nothing")
    sl.set_defaults(func=cmd_import_slack)

    notion = sub.add_parser(
        "import-notion", help="import a Notion export (Markdown & CSV) into Docs"
    )
    notion.add_argument("export", help="the export ZIP (a ZIP of ZIPs too) or its unpacked folder")
    notion.add_argument("--actor", required=True, help="the administrator running the import")
    notion.add_argument(
        "--parent", help="the id of the page to import under (default: the top level)"
    )
    notion.add_argument(
        "--access",
        choices=("workspace-edit", "workspace-view", "private"),
        help="the imported top pages' sharing (default: workspace-edit at the top level; "
        "under --parent they inherit)",
    )
    notion.add_argument(
        "--user",
        action="append",
        metavar="NOTION_NAME=USERNAME",
        help="a person's name in Notion (person columns, @mentions) → an account (repeatable)",
    )
    notion.add_argument(
        "--user-map", action="append", metavar="PATH", help="NOTION_NAME=USERNAME lines"
    )
    notion.add_argument(
        "--column-types",
        metavar="PATH",
        help="lines 'COLUMN = TYPE' or 'DATABASE / COLUMN = TYPE' overriding the guesses",
    )
    notion.add_argument(
        "--timezone", default="Asia/Tokyo", help="the zone of times written without one"
    )
    notion.add_argument("--dry-run", action="store_true", help="check everything, write nothing")
    notion.set_defaults(func=cmd_import_notion)

    presets = sub.add_parser(
        "import-emoji-presets",
        help="import the emoji pack folders under EMOJI_PRESETS_DIR (also done at startup)",
    )
    presets.add_argument("--dir", help="the folder of pack folders (default: EMOJI_PRESETS_DIR)")
    presets.add_argument(
        "--restore",
        action="append",
        default=[],
        metavar="FOLDER",
        help="bring back a preset pack (or its emoji) an administrator deleted (repeatable)",
    )
    presets.set_defaults(func=cmd_import_emoji_presets)

    demo = sub.add_parser(
        "seed-demo",
        help="write the fictional demo lab (Taylis デモ研究室); idempotent, --reset to start over",
    )
    demo.add_argument(
        "--reset",
        action="store_true",
        help="delete ALL data first (only when WORKSPACE_NAME is the demo's name, or --i-know)",
    )
    demo.add_argument(
        "--i-know", action="store_true", help="allow --reset / seeding whatever WORKSPACE_NAME is"
    )
    demo.add_argument("--review-user", default="review", help="the reviewers' account (member)")
    demo.add_argument(
        "--review-password-file",
        help="file holding the review account's password (else DEMO_REVIEW_PASSWORD, else random)",
    )
    demo.add_argument(
        "--credentials-out", help="write the generated passwords to this file (mode 600)"
    )
    demo.set_defaults(func=cmd_seed_demo)

    acl = sub.add_parser(
        "wiki-acl", help="check the wiki's effective access against a full recomputation"
    )
    mode = acl.add_mutually_exclusive_group(required=True)
    mode.add_argument("--verify", action="store_true", help="report differences (exit 1 if any)")
    mode.add_argument("--rebuild", action="store_true", help="recompute everything, then verify")
    acl.set_defaults(func=cmd_wiki_acl)

    export = sub.add_parser("export-openapi", help="write the OpenAPI document to openapi/")
    export.add_argument("--out", default=str(REPO_ROOT / "openapi" / "openapi.json"))
    export.set_defaults(func=cmd_export_openapi)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # Every module's models, so that relationships and foreign keys resolve whichever tables a
    # command touches (probe-videos failed in production on attachments.canvas_id → canvases).
    import app.models_registry  # noqa: F401

    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
