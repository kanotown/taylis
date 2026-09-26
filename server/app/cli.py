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
    return 0


USERNAME_PATTERN = re.compile(r"^[a-z0-9._-]{3,32}$")
MIN_PASSWORD_LENGTH = 12


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
    username = _validate_username(args.username)
    password = args.password or getpass.getpass("Password (min 12 chars): ")
    if not args.password and password != getpass.getpass("Repeat password: "):
        raise SystemExit("error: passwords do not match")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"error: password must be at least {MIN_PASSWORD_LENGTH} characters")
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
