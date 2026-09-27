#!/usr/bin/env python3
"""Generate the per-platform Japanese error tables from errors.json. Run after editing the JSON:

    python3 apps/shared/gen_errors.py

Every code the server raises (server/app/core/errors.py and the modules) must have an entry; the
server test tests/test_error_codes.py checks that.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = json.loads((Path(__file__).parent / "errors.json").read_text())
HEADER = "Generated from apps/shared/errors.json by apps/shared/gen_errors.py; do not edit by hand."


def q(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def ts() -> str:
    lines = [f"// {HEADER}", "", "/** Japanese message for each server error code. */", "export const ERROR_MESSAGES: Readonly<Record<string, string>> = {"]
    lines += [f"  {code}: {q(text)}," for code, text in sorted(DATA["codes"].items())]
    lines += ["};", "", "/** Fallbacks by HTTP status (\"5xx\" for any server error). */", "export const STATUS_MESSAGES: Readonly<Record<string, string>> = {"]
    lines += [f"  {q(status)}: {q(text)}," for status, text in DATA["status"].items()]
    lines += ["};", "", f"export const NETWORK_ERROR_MESSAGE = {q(DATA['network'])};", f"export const UNKNOWN_ERROR_MESSAGE = {q(DATA['unknown'])};", ""]
    return "\n".join(lines)


def swift() -> str:
    lines = [f"// {HEADER}", "", "enum ErrorMessages {", "    /// Japanese message for each server error code.", "    static let byCode: [String: String] = ["]
    lines += [f"        {q(code)}: {q(text)}," for code, text in sorted(DATA["codes"].items())]
    lines += ["    ]", "", "    /// Fallbacks by HTTP status (\"5xx\" for any server error).", "    static let byStatus: [String: String] = ["]
    lines += [f"        {q(status)}: {q(text)}," for status, text in DATA["status"].items()]
    lines += ["    ]", "", f"    static let network = {q(DATA['network'])}", f"    static let unknown = {q(DATA['unknown'])}", "}", ""]
    return "\n".join(lines)


def kotlin() -> str:
    lines = ["package jp.chikuwachat.android.api", "", f"// {HEADER}", "", "object ErrorMessages {", "    /** Japanese message for each server error code. */", "    val byCode: Map<String, String> = mapOf("]
    lines += [f"        {q(code)} to {q(text)}," for code, text in sorted(DATA["codes"].items())]
    lines += ["    )", "", "    /** Fallbacks by HTTP status (\"5xx\" for any server error). */", "    val byStatus: Map<String, String> = mapOf("]
    lines += [f"        {q(status)} to {q(text)}," for status, text in DATA["status"].items()]
    lines += ["    )", "", f"    const val NETWORK = {q(DATA['network'])}", f"    const val UNKNOWN = {q(DATA['unknown'])}", "}", ""]
    return "\n".join(lines)


def main() -> None:
    (ROOT / "apps/desktop/src/api/errorMessages.ts").write_text(ts())
    (ROOT / "apps/ios/ChikuwaChat/Api/ErrorMessages.swift").write_text(swift())
    (ROOT / "apps/android/app/src/main/java/jp/chikuwachat/android/api/ErrorMessages.kt").write_text(kotlin())
    print(f"wrote {len(DATA['codes'])} error messages to 3 platforms")


if __name__ == "__main__":
    main()
