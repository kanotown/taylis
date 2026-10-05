"""Every error code the server can send has a Japanese message for the clients
(apps/shared/errors.json, ARCHITECTURE.md §9)."""

import json
import re
from pathlib import Path

from app.i18n import LOCALES

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "server" / "app"
PATTERNS = [
    # bad_request("code", …), forbidden("code"), not_found(…), conflict(…), unauthorized(…)
    re.compile(r"\b(?:bad_request|forbidden|not_found|conflict|unauthorized)\(\s*\"([a-z_]+)\""),
    re.compile(r"AppError\(\s*\d+,\s*\"([a-z_]+)\""),
]
# Codes that never reach an HTTP client (WebSocket-only frames) or are formatted at runtime.
EXEMPT = {"invalid_frame", "auth_required", "status"}


def test_every_server_error_code_has_a_japanese_message() -> None:
    table = json.loads((ROOT / "apps" / "shared" / "errors.json").read_text())["codes"]
    used: set[str] = set()
    for path in APP.rglob("*.py"):
        text = path.read_text()
        for pattern in PATTERNS:
            used.update(pattern.findall(text))
    missing = sorted(code for code in used - EXEMPT if code not in table)
    assert missing == [], f"add these codes to apps/shared/errors.json: {missing}"
    # M115 (docs/I18N.md): in every UI language.
    untranslated = sorted(
        code for code, texts in table.items() if not all(texts.get(loc) for loc in LOCALES)
    )
    assert untranslated == [], f"add en / zh-Hans texts to apps/shared/errors.json: {untranslated}"
