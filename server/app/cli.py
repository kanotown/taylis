"""Command-line tools: ``uv run python -m app.cli <command>``."""

import argparse
import asyncio
import getpass
import json
import re
import sys
from collections.abc import Sequence
from pathlib import Path

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
                kind="test", title="ChikuwaChat", body=body, sent_at=utcnow()
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


def cmd_push_test(args: argparse.Namespace) -> int:
    """Send a test notification to every push-registered device of a user."""
    return asyncio.run(_push_test(args.username, args.body))


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
