#!/usr/bin/env python3
"""Generate the per-platform error-message tables from errors.json. Run after editing the JSON:

    python3 apps/shared/gen_errors.py

errors.json has every message in each UI language (ja, en, zh-Hans; docs/I18N.md). Every code the
server raises (server/app/core/errors.py and the modules) must have an entry in every language; the
server test tests/test_error_codes.py checks that.

Each client table keeps the old accessors (byCode / byStatus / network / unknown, the desktop's
errorMessage helpers) answering in the table's current `locale`, which the app sets from its
effective UI language; unknown locales and missing texts fall back to ja. The server gets a plain
copy of the JSON (server/app/i18n/errors.json) because its image does not contain apps/.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = json.loads((Path(__file__).parent / "errors.json").read_text())
LOCALES: list[str] = DATA["locales"]
HEADER = "Generated from apps/shared/errors.json by apps/shared/gen_errors.py; do not edit by hand."


def q(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def check() -> None:
    for group in ("codes", "status"):
        for key, texts in DATA[group].items():
            missing = [loc for loc in LOCALES if not texts.get(loc)]
            assert not missing, f"{group}.{key} has no text for {missing}"
    for key in ("network", "unknown"):
        assert all(DATA[key].get(loc) for loc in LOCALES), key


def by_locale(group: str, locale: str) -> list[tuple[str, str]]:
    items = DATA[group].items()
    return sorted((k, v[locale]) for k, v in items) if group == "codes" else [(k, v[locale]) for k, v in items]


def ts() -> str:
    lines = [f"// {HEADER}", "", f"export const ERROR_LOCALES = [{', '.join(q(loc) for loc in LOCALES)}] as const;", "export type ErrorLocale = (typeof ERROR_LOCALES)[number];", ""]
    lines += ["/** The message for each server error code, per UI language. */", "export const ERROR_MESSAGES_BY_LOCALE: Readonly<Record<ErrorLocale, Readonly<Record<string, string>>>> = {"]
    for loc in LOCALES:
        lines.append(f"  {q(loc)}: {{")
        lines += [f"    {code}: {q(text)}," for code, text in by_locale("codes", loc)]
        lines.append("  },")
    lines += ["};", "", "/** Fallbacks by HTTP status (\"5xx\" for any server error), per UI language. */", "export const STATUS_MESSAGES_BY_LOCALE: Readonly<Record<ErrorLocale, Readonly<Record<string, string>>>> = {"]
    for loc in LOCALES:
        lines.append(f"  {q(loc)}: {{")
        lines += [f"    {q(status)}: {q(text)}," for status, text in by_locale("status", loc)]
        lines.append("  },")
    lines += ["};", ""]
    lines.append("export const NETWORK_ERROR_MESSAGE_BY_LOCALE: Readonly<Record<ErrorLocale, string>> = {" + ", ".join(f"{q(loc)}: {q(DATA['network'][loc])}" for loc in LOCALES) + "};")
    lines.append("export const UNKNOWN_ERROR_MESSAGE_BY_LOCALE: Readonly<Record<ErrorLocale, string>> = {" + ", ".join(f"{q(loc)}: {q(DATA['unknown'][loc])}" for loc in LOCALES) + "};")
    lines += ["", "/** The Japanese tables (tests). The app reads the UI language's through api/errors.ts (errorMessageFor, describeError). */"]
    lines += ["export const ERROR_MESSAGES = ERROR_MESSAGES_BY_LOCALE.ja;", "export const STATUS_MESSAGES = STATUS_MESSAGES_BY_LOCALE.ja;", "export const NETWORK_ERROR_MESSAGE = NETWORK_ERROR_MESSAGE_BY_LOCALE.ja;", "export const UNKNOWN_ERROR_MESSAGE = UNKNOWN_ERROR_MESSAGE_BY_LOCALE.ja;"]
    lines.append("")
    return "\n".join(lines)


def swift() -> str:
    lines = [f"// {HEADER}", "", "enum ErrorMessages {"]
    lines += ["    /// The UI language the accessors answer in (\"ja\", \"en\", \"zh-Hans\"); the app sets it from its effective locale.", "    static var locale = \"ja\"", ""]
    lines += ["    /// The message for each server error code, in the current `locale` (ja when it has none).", "    static var byCode: [String: String] { byCodeByLocale[locale] ?? byCodeByLocale[\"ja\"]! }", "    /// Fallbacks by HTTP status (\"5xx\" for any server error), in the current `locale`.", "    static var byStatus: [String: String] { byStatusByLocale[locale] ?? byStatusByLocale[\"ja\"]! }", "    static var network: String { networkByLocale[locale] ?? networkByLocale[\"ja\"]! }", "    static var unknown: String { unknownByLocale[locale] ?? unknownByLocale[\"ja\"]! }", ""]
    lines.append("    static let byCodeByLocale: [String: [String: String]] = [")
    for loc in LOCALES:
        lines.append(f"        {q(loc)}: [")
        lines += [f"            {q(code)}: {q(text)}," for code, text in by_locale("codes", loc)]
        lines.append("        ],")
    lines += ["    ]", "", "    static let byStatusByLocale: [String: [String: String]] = ["]
    for loc in LOCALES:
        lines.append(f"        {q(loc)}: [")
        lines += [f"            {q(status)}: {q(text)}," for status, text in by_locale("status", loc)]
        lines.append("        ],")
    lines += ["    ]", ""]
    lines.append("    static let networkByLocale: [String: String] = [" + ", ".join(f"{q(loc)}: {q(DATA['network'][loc])}" for loc in LOCALES) + "]")
    lines.append("    static let unknownByLocale: [String: String] = [" + ", ".join(f"{q(loc)}: {q(DATA['unknown'][loc])}" for loc in LOCALES) + "]")
    lines += ["}", ""]
    return "\n".join(lines)


def kotlin() -> str:
    lines = ["package jp.chikuwachat.android.api", "", f"// {HEADER}", "", "object ErrorMessages {"]
    lines += ["    /** The UI language the accessors answer in (\"ja\", \"en\", \"zh-Hans\"); the app sets it from its effective locale. */", "    @Volatile", "    var locale: String = \"ja\"", ""]
    lines += ["    /** The message for each server error code, in the current [locale] (ja when it has none). */", "    val byCode: Map<String, String> get() = byCodeByLocale[locale] ?: byCodeByLocale.getValue(\"ja\")", "    /** Fallbacks by HTTP status (\"5xx\" for any server error), in the current [locale]. */", "    val byStatus: Map<String, String> get() = byStatusByLocale[locale] ?: byStatusByLocale.getValue(\"ja\")", "    val NETWORK: String get() = networkByLocale[locale] ?: networkByLocale.getValue(\"ja\")", "    val UNKNOWN: String get() = unknownByLocale[locale] ?: unknownByLocale.getValue(\"ja\")", ""]
    lines.append("    val byCodeByLocale: Map<String, Map<String, String>> = mapOf(")
    for loc in LOCALES:
        lines.append(f"        {q(loc)} to mapOf(")
        lines += [f"            {q(code)} to {q(text)}," for code, text in by_locale("codes", loc)]
        lines.append("        ),")
    lines += ["    )", "", "    val byStatusByLocale: Map<String, Map<String, String>> = mapOf("]
    for loc in LOCALES:
        lines.append(f"        {q(loc)} to mapOf(")
        lines += [f"            {q(status)} to {q(text)}," for status, text in by_locale("status", loc)]
        lines.append("        ),")
    lines += ["    )", ""]
    lines.append("    val networkByLocale: Map<String, String> = mapOf(" + ", ".join(f"{q(loc)} to {q(DATA['network'][loc])}" for loc in LOCALES) + ")")
    lines.append("    val unknownByLocale: Map<String, String> = mapOf(" + ", ".join(f"{q(loc)} to {q(DATA['unknown'][loc])}" for loc in LOCALES) + ")")
    lines += ["}", ""]
    return "\n".join(lines)


def server_copy() -> str:
    return json.dumps({"_comment": HEADER, **{k: v for k, v in DATA.items() if k != "_comment"}}, ensure_ascii=False, indent=1) + "\n"


def main() -> None:
    check()
    (ROOT / "apps/desktop/src/api/errorMessages.ts").write_text(ts())
    (ROOT / "apps/ios/ChikuwaChat/Api/ErrorMessages.swift").write_text(swift())
    (ROOT / "apps/android/app/src/main/java/jp/chikuwachat/android/api/ErrorMessages.kt").write_text(kotlin())
    (ROOT / "server/app/i18n").mkdir(exist_ok=True)
    (ROOT / "server/app/i18n/errors.json").write_text(server_copy())
    print(f"wrote {len(DATA['codes'])} error messages × {len(LOCALES)} languages to 3 platforms and the server")


if __name__ == "__main__":
    main()
