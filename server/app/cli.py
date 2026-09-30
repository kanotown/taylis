"""Command-line tools: ``uv run python -m app.cli <command>``."""

import argparse
import asyncio
import getpass
import json
import os
import re
import sys
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
                title="ChikuwaChat",
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


def parse_user_map(pairs: Sequence[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for pair in pairs:
        mm, sep, chikuwa = pair.partition("=")
        if not sep or not mm.strip() or not chikuwa.strip():
            raise ValueError(f"--user {pair}: use MATTERMOST_NAME=CHIKUWA_NAME")
        mapping[mm.strip().lstrip("@").lower()] = chikuwa.strip().lstrip("@").lower()
    return mapping


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
    print("dry run: nothing was written" if report.dry_run else "imported")
    print("people:")
    for line in report.people:
        print(f"  {line}")
    print("counts:")
    for key, value in sorted(report.counts.items()):
        print(f"  {key}: {value}")
    if report.unmatched_emoji:
        # Names a custom emoji can take (NAME in app.modules.emoji.service) show up once added.
        from app.modules.emoji.service import NAME

        print("reactions without an emoji image (add a custom emoji of the same name to show it):")
        for name, count in report.unmatched_emoji.most_common():
            note = "" if NAME.match(name) else "  (not a valid custom emoji name)"
            print(f"  :{name}: {count} times{note}")
    if report.dropped_emoji:
        print("reactions not imported (the name is not a valid reaction):")
        for name, count in report.dropped_emoji.most_common():
            print(f"  {name} {count} times")
    if report.warnings:
        print(f"warnings ({len(report.warnings)}):")
        for line in report.warnings[:200]:
            print(f"  {line}")
        if len(report.warnings) > 200:
            print(f"  … and {len(report.warnings) - 200} more")
    return 0


def cmd_import_mattermost(args: argparse.Namespace) -> int:
    """Import a mattermost-extract file (M18). Safe to run again: only new posts are added."""
    return asyncio.run(_import_mattermost(args))


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

    export = sub.add_parser("export-openapi", help="write the OpenAPI document to openapi/")
    export.add_argument("--out", default=str(REPO_ROOT / "openapi" / "openapi.json"))
    export.set_defaults(func=cmd_export_openapi)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
