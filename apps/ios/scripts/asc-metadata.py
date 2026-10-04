#!/usr/bin/env python3
"""Fill the App Store Connect record of the iOS app (version, texts, age rating, review details, screenshots, build).

docs/STORE_RELEASE.md §3.1. Everything the store shows comes from docs/store/appstore.json (keep it in step with
docs/store/LISTING_*.md, PRIVACY_AND_RATINGS.md and REVIEW_NOTES.md, which are the human-readable versions).

    uv run --with pyjwt --with cryptography --with httpx python apps/ios/scripts/asc-metadata.py --dry-run
    uv run --with pyjwt --with cryptography --with httpx python apps/ios/scripts/asc-metadata.py

Options:
    --dry-run           read the current values (GET only) and print what would change; nothing is written
    --build N           attach build number N (default: the highest VALID, unexpired build of the version)
    --no-build          do not touch the attached build
    --only a,b          run only these steps; --skip a,b skips them. Steps:
                        version, build, texts, appinfo, categories, age, review, screenshots
    --config PATH       another JSON file (default docs/store/appstore.json)

The script is idempotent: it compares what App Store Connect has with the JSON and writes only the differences, so it
can be run again after a failure or after editing the JSON. Screenshots are matched by MD5: unchanged files are kept,
others are deleted, missing ones uploaded, and the set is put in the JSON's order.

Settings, outside the repository (the environment wins over the files):
  ~/.config/taylis/release.env (TAYLIS_RELEASE_ENV): ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8 key, never printed)
  ~/.config/taylis/asc-review.env (TAYLIS_ASC_REVIEW_ENV): the App Review contact and demo account:
      ASC_REVIEW_FIRST, ASC_REVIEW_LAST, ASC_REVIEW_EMAIL (override the JSON), ASC_REVIEW_PHONE,
      ASC_REVIEW_DEMO_USER, ASC_REVIEW_DEMO_PASSWORD, ASC_REVIEW_SERVER_URL (fills {server_url} in the notes)
  A missing value is skipped with a warning (the field keeps what App Store Connect has).

Not possible through the API (the script prints a reminder): App Privacy (the nutrition labels), price and
availability, the content rights question, and submitting for review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
import time
from pathlib import Path
from typing import Any

try:
    import httpx
    import jwt
except ImportError:  # pragma: no cover - depends on how the script is started
    sys.exit(
        "asc-metadata: needs pyjwt, cryptography and httpx. Run it with\n"
        "  uv run --with pyjwt --with cryptography --with httpx python apps/ios/scripts/asc-metadata.py --dry-run"
    )

REPO = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG = REPO / "docs/store/appstore.json"
API = "https://api.appstoreconnect.apple.com"
STEPS = ["version", "build", "texts", "appinfo", "categories", "age", "review", "screenshots"]

# Field limits of App Store Connect (characters).
LIMITS = {"name": 30, "subtitle": 30, "promotionalText": 170, "keywords": 100, "description": 4000, "notes": 4000}
# States in which a version's metadata can still be edited.
EDITABLE_VERSION_STATES = {
    "PREPARE_FOR_SUBMISSION",
    "DEVELOPER_REJECTED",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY",
}
# Portrait/landscape sizes accepted for the 6.9"/6.7" iPhone slot (APP_IPHONE_67).
IPHONE_67_SIZES = {(1320, 2868), (1290, 2796), (1260, 2736)}
SECRET_FIELDS = {"demoAccountPassword", "contactPhone"}


class AscError(Exception):
    pass


# ---------------------------------------------------------------------------------------------- settings


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export ") :].strip()
        values[key] = value.strip().strip('"').strip("'")
    return values


def settings() -> dict[str, str]:
    merged: dict[str, str] = {}
    release_env = Path(os.environ.get("TAYLIS_RELEASE_ENV", "~/.config/taylis/release.env")).expanduser()
    review_env = Path(os.environ.get("TAYLIS_ASC_REVIEW_ENV", "~/.config/taylis/asc-review.env")).expanduser()
    merged.update(read_env_file(release_env))
    merged.update(read_env_file(review_env))
    for key, value in os.environ.items():
        if key.startswith("ASC_"):
            merged[key] = value
    return {k: v for k, v in merged.items() if v != ""}


# ---------------------------------------------------------------------------------------------- API client


class Asc:
    def __init__(self, key_id: str, issuer_id: str, key_path: Path, dry_run: bool) -> None:
        self.key_id = key_id
        self.issuer_id = issuer_id
        try:
            self._key = key_path.read_text()
        except OSError as e:
            raise AscError(f"cannot read the API key at {key_path}: {e.strerror}") from None
        self.dry_run = dry_run
        self._token = ""
        self._token_exp = 0.0
        self.http = httpx.Client(base_url=API, timeout=120)
        self.writes = 0

    def _auth(self) -> dict[str, str]:
        now = time.time()
        if now > self._token_exp - 60:
            iat = int(now)
            self._token = jwt.encode(
                {"iss": self.issuer_id, "iat": iat, "exp": iat + 15 * 60, "aud": "appstoreconnect-v1"},
                self._key,
                algorithm="ES256",
                headers={"kid": self.key_id, "typ": "JWT"},
            )
            self._token_exp = iat + 15 * 60
        return {"Authorization": f"Bearer {self._token}"}

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        for attempt in range(4):
            try:
                r = self.http.request(method, path, headers=self._auth(), **kwargs)
            except httpx.TransportError as e:
                if attempt == 3 or method != "GET":
                    raise AscError(f"{method} {path}: network error: {e}") from None
                time.sleep(2 * (attempt + 1))
                continue
            if r.status_code in (429, 500, 502, 503, 504) and method == "GET" and attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            if r.status_code >= 400:
                raise AscError(f"{method} {path}: HTTP {r.status_code}\n{describe_errors(r)}")
            return r
        raise AssertionError("unreachable")

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request("GET", path, params=params).json()

    def get_all(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        body = self.get(path, params)
        while True:
            out.extend(body.get("data") or [])
            nxt = (body.get("links") or {}).get("next")
            if not nxt:
                return out
            body = self._request("GET", nxt.removeprefix(API)).json()

    def write(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """POST / PATCH / DELETE. In a dry run nothing is sent and None comes back."""
        if self.dry_run:
            return None
        self.writes += 1
        r = self._request(method, path, json=body)
        return r.json() if r.content else {}


def describe_errors(r: httpx.Response) -> str:
    try:
        errors = r.json().get("errors") or []
    except ValueError:
        return r.text[:2000]
    lines = []
    for e in errors:
        src = e.get("source") or {}
        where = src.get("pointer") or src.get("parameter") or ""
        lines.append(f"  - {e.get('code', '')}: {e.get('title', '')}: {e.get('detail', '')} {where}".rstrip())
        for m in (e.get("meta") or {}).get("associatedErrors", {}).values():
            for sub in m:
                lines.append(f"      {sub.get('code', '')}: {sub.get('detail', '')}")
    return "\n".join(lines) or r.text[:2000]


# ---------------------------------------------------------------------------------------------- output


class Report:
    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.changes = 0
        self.warnings: list[str] = []

    def section(self, title: str) -> None:
        print(f"\n== {title}")

    def change(self, what: str, old: Any, new: Any, field: str = "") -> None:
        self.changes += 1
        verb = "would set" if self.dry_run else "set"
        print(f"  {verb} {what}: {show(old, field)} -> {show(new, field)}")

    def action(self, text: str) -> None:
        self.changes += 1
        print(f"  {'would ' if self.dry_run else ''}{text}")

    def same(self, text: str) -> None:
        print(f"  unchanged: {text}")

    def warn(self, text: str) -> None:
        self.warnings.append(text)
        print(f"  WARNING: {text}")


def show(value: Any, field: str = "") -> str:
    if value is None:
        return "(empty)"
    if field in SECRET_FIELDS:
        return "(hidden)"
    if isinstance(value, str):
        one_line = value.replace("\n", "⏎")
        if len(one_line) > 70:
            return f"{one_line[:60]!r}… ({len(value)} chars)"
        return repr(value)
    return json.dumps(value, ensure_ascii=False)


def diff_attributes(
    report: Report, label: str, current: dict[str, Any], desired: dict[str, Any]
) -> dict[str, Any]:
    """Return the attributes that differ (desired value None = keep what is there)."""
    changed: dict[str, Any] = {}
    for key, new in desired.items():
        if new is None:
            continue
        old = current.get(key)
        if old == new or (isinstance(old, str) and isinstance(new, str) and old.strip() == new.strip()):
            continue
        changed[key] = new
        report.change(f"{label}.{key}", old, new, key)
    if not changed:
        report.same(label)
    return changed


# ---------------------------------------------------------------------------------------------- config


def load_config(path: Path) -> dict[str, Any]:
    try:
        cfg = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise AscError(f"cannot read {path}: {e}") from None
    problems: list[str] = []
    for key in ("bundleId", "platform", "version", "localizations"):
        if not cfg.get(key):
            problems.append(f"missing '{key}'")
    for locale, loc in (cfg.get("localizations") or {}).items():
        for field, limit in LIMITS.items():
            value = loc.get(field)
            if isinstance(value, str) and len(value) > limit:
                problems.append(f"{locale}.{field} is {len(value)} characters (limit {limit})")
    notes = (cfg.get("review") or {}).get("notes")
    if isinstance(notes, str) and len(notes) > LIMITS["notes"]:
        problems.append(f"review.notes is {len(notes)} characters (limit {LIMITS['notes']})")
    if problems:
        raise AscError(f"{path}:\n  " + "\n  ".join(problems))
    return cfg


# ---------------------------------------------------------------------------------------------- steps


class Run:
    def __init__(self, asc: Asc, cfg: dict[str, Any], env: dict[str, str], report: Report, args: argparse.Namespace):
        self.asc = asc
        self.cfg = cfg
        self.env = env
        self.r = report
        self.args = args
        self.app_id = ""
        self.version: dict[str, Any] | None = None  # appStoreVersions resource (None in a dry run before creation)
        self.version_locs: dict[str, str] = {}  # locale -> appStoreVersionLocalizations id
        self.app_info_id = ""

    def enabled(self, step: str) -> bool:
        if self.args.only and step not in self.args.only:
            return False
        return step not in self.args.skip

    # -- app

    def find_app(self) -> None:
        apps = self.asc.get_all(
            "/v1/apps", {"filter[bundleId]": self.cfg["bundleId"], "fields[apps]": "name,bundleId,primaryLocale"}
        )
        apps = [a for a in apps if a["attributes"]["bundleId"] == self.cfg["bundleId"]]
        if not apps:
            raise AscError(f"no app with bundle id {self.cfg['bundleId']} (create it in App Store Connect first)")
        app = apps[0]
        self.app_id = app["id"]
        a = app["attributes"]
        print(f"app {self.app_id}: {a['name']} ({a['bundleId']}, primary locale {a['primaryLocale']})")

    # -- version

    def step_version(self) -> None:
        self.r.section("App Store version")
        want = self.cfg["version"]
        platform = self.cfg["platform"]
        versions = self.asc.get_all(
            f"/v1/apps/{self.app_id}/appStoreVersions",
            {"filter[platform]": platform, "fields[appStoreVersions]": "versionString,appVersionState,appStoreState,"
             "copyright,releaseType,platform", "limit": 200},
        )

        def state(v: dict[str, Any]) -> str:
            return v["attributes"].get("appVersionState") or v["attributes"].get("appStoreState") or ""

        editable = [v for v in versions if state(v) in EDITABLE_VERSION_STATES]
        exact = [v for v in editable if v["attributes"]["versionString"] == want]
        desired = {"copyright": self.cfg.get("copyright"), "releaseType": self.cfg.get("releaseType")}
        if exact or editable:
            self.version = (exact or editable)[0]
            a = self.version["attributes"]
            print(f"  version {a['versionString']} ({state(self.version)}), id {self.version['id']}")
            changed = diff_attributes(self.r, "version", a, {"versionString": want, **desired})
            if changed:
                self.asc.write(
                    "PATCH",
                    f"/v1/appStoreVersions/{self.version['id']}",
                    {"data": {"type": "appStoreVersions", "id": self.version["id"], "attributes": changed}},
                )
            return
        others = ", ".join(f"{v['attributes']['versionString']} ({state(v)})" for v in versions) or "none"
        self.r.action(f"create version {want} ({platform}); existing versions: {others}")
        attrs = {"platform": platform, "versionString": want, **{k: v for k, v in desired.items() if v is not None}}
        body = self.asc.write(
            "POST",
            "/v1/appStoreVersions",
            {"data": {"type": "appStoreVersions", "attributes": attrs,
                      "relationships": {"app": {"data": {"type": "apps", "id": self.app_id}}}}},
        )
        if body:
            self.version = body["data"]

    def load_version_localizations(self) -> None:
        if not self.version:
            return
        for loc in self.asc.get_all(f"/v1/appStoreVersions/{self.version['id']}/appStoreVersionLocalizations"):
            self.version_locs[loc["attributes"]["locale"]] = loc["id"]

    # -- build

    def step_build(self) -> None:
        self.r.section("Build")
        if self.args.no_build:
            print("  skipped (--no-build)")
            return
        builds = self.asc.get_all(
            "/v1/builds",
            {
                "filter[app]": self.app_id,
                "filter[preReleaseVersion.version]": self.cfg["version"],
                "filter[preReleaseVersion.platform]": self.cfg["platform"],
                "filter[processingState]": "VALID",
                "filter[expired]": "false",
                "fields[builds]": "version,uploadedDate,processingState",
                "limit": 200,
            },
        )
        if not builds:
            self.r.warn(f"no VALID build of version {self.cfg['version']} yet (upload one with release-ios.sh)")
            return
        builds.sort(key=lambda b: int(b["attributes"]["version"]) if b["attributes"]["version"].isdigit() else -1)
        if self.args.build is not None:
            chosen = [b for b in builds if b["attributes"]["version"] == str(self.args.build)]
            if not chosen:
                numbers = ", ".join(b["attributes"]["version"] for b in builds)
                raise AscError(f"build {self.args.build} is not a VALID build of {self.cfg['version']} ({numbers})")
            build = chosen[0]
        else:
            build = builds[-1]
        number = build["attributes"]["version"]
        if not self.version:
            self.r.action(f"attach build {number} to the new version")
            return
        current = self.asc.get(
            f"/v1/appStoreVersions/{self.version['id']}/build", {"fields[builds]": "version"}
        ).get("data")
        if current and current["id"] == build["id"]:
            self.r.same(f"build {number}")
            return
        self.r.change("build", current["attributes"]["version"] if current else None, number)
        self.asc.write(
            "PATCH",
            f"/v1/appStoreVersions/{self.version['id']}/relationships/build",
            {"data": {"type": "builds", "id": build["id"]}},
        )

    # -- version localizations (description, keywords, ...)

    def step_texts(self) -> None:
        self.r.section("Version texts (appStoreVersionLocalizations)")
        fields = ("description", "keywords", "promotionalText", "supportUrl", "marketingUrl")
        current_by_locale: dict[str, dict[str, Any]] = {}
        if self.version:
            for loc in self.asc.get_all(f"/v1/appStoreVersions/{self.version['id']}/appStoreVersionLocalizations"):
                current_by_locale[loc["attributes"]["locale"]] = loc
        for locale, texts in self.cfg["localizations"].items():
            desired = {f: texts.get(f) for f in fields}
            loc = current_by_locale.get(locale)
            if loc:
                changed = diff_attributes(self.r, locale, loc["attributes"], desired)
                if changed:
                    self.asc.write(
                        "PATCH",
                        f"/v1/appStoreVersionLocalizations/{loc['id']}",
                        {"data": {"type": "appStoreVersionLocalizations", "id": loc["id"], "attributes": changed}},
                    )
                continue
            self.r.action(f"add the {locale} localization of the version")
            diff_attributes(self.r, locale, {}, desired)
            if not self.version:
                continue
            body = self.asc.write(
                "POST",
                "/v1/appStoreVersionLocalizations",
                {"data": {"type": "appStoreVersionLocalizations",
                          "attributes": {"locale": locale, **{k: v for k, v in desired.items() if v is not None}},
                          "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions",
                                                                         "id": self.version["id"]}}}}},
            )
            if body:
                self.version_locs[locale] = body["data"]["id"]

    # -- app info (name, subtitle, privacy policy URL; categories; age rating)

    def find_app_info(self) -> None:
        infos = self.asc.get_all(f"/v1/apps/{self.app_id}/appInfos", {"fields[appInfos]": "state,appStoreState"})
        live = {"READY_FOR_DISTRIBUTION", "READY_FOR_SALE", "REPLACED_WITH_NEW_INFO"}
        editable = [i for i in infos if (i["attributes"].get("state") or i["attributes"].get("appStoreState")) not in live]
        if not editable:
            raise AscError("no editable appInfo (is a version being reviewed?)")
        self.app_info_id = editable[0]["id"]

    def step_appinfo(self) -> None:
        self.r.section("App information (appInfoLocalizations)")
        fields = ("name", "subtitle", "privacyPolicyUrl")
        current = {
            loc["attributes"]["locale"]: loc
            for loc in self.asc.get_all(f"/v1/appInfos/{self.app_info_id}/appInfoLocalizations")
        }
        for locale, texts in self.cfg["localizations"].items():
            desired = {f: texts.get(f) for f in fields}
            loc = current.get(locale)
            if loc:
                changed = diff_attributes(self.r, locale, loc["attributes"], desired)
                if changed:
                    self.asc.write(
                        "PATCH",
                        f"/v1/appInfoLocalizations/{loc['id']}",
                        {"data": {"type": "appInfoLocalizations", "id": loc["id"], "attributes": changed}},
                    )
                continue
            if not desired["name"]:
                raise AscError(f"localizations.{locale}.name is needed to add the {locale} localization")
            self.r.action(f"add the {locale} app information localization")
            diff_attributes(self.r, locale, {}, desired)
            self.asc.write(
                "POST",
                "/v1/appInfoLocalizations",
                {"data": {"type": "appInfoLocalizations",
                          "attributes": {"locale": locale, **{k: v for k, v in desired.items() if v is not None}},
                          "relationships": {"appInfo": {"data": {"type": "appInfos", "id": self.app_info_id}}}}},
            )

    def step_categories(self) -> None:
        self.r.section("Categories")
        rels: dict[str, Any] = {}
        for rel in ("primaryCategory", "secondaryCategory"):
            want = self.cfg.get(rel)
            if not want:
                continue
            have = self.asc.get(f"/v1/appInfos/{self.app_info_id}/{rel}").get("data")
            have_id = have["id"] if have else None
            if have_id == want:
                self.r.same(f"{rel} {want}")
                continue
            self.r.change(rel, have_id, want)
            rels[rel] = {"data": {"type": "appCategories", "id": want}}
        if rels:
            self.asc.write(
                "PATCH",
                f"/v1/appInfos/{self.app_info_id}",
                {"data": {"type": "appInfos", "id": self.app_info_id, "relationships": rels}},
            )

    def step_age(self) -> None:
        self.r.section("Age rating")
        want = self.cfg.get("ageRating") or {}
        if not want:
            print("  nothing in the JSON")
            return
        decl = self.asc.get(f"/v1/appInfos/{self.app_info_id}/ageRatingDeclaration")["data"]
        unknown = sorted(set(want) - set(decl["attributes"]))
        if unknown:
            raise AscError(f"ageRating fields App Store Connect does not have: {', '.join(unknown)}")
        changed = diff_attributes(self.r, "ageRating", decl["attributes"], want)
        missing = sorted(k for k, v in decl["attributes"].items() if v is None and k not in want
                         and k not in ("kidsAgeBand", "gracRatingClassificationNumber", "developerAgeRatingInfoUrl"))
        if missing:
            self.r.warn(f"age rating questions not answered in the JSON: {', '.join(missing)}")
        if changed:
            self.asc.write(
                "PATCH",
                f"/v1/ageRatingDeclarations/{decl['id']}",
                {"data": {"type": "ageRatingDeclarations", "id": decl["id"], "attributes": changed}},
            )

    # -- App Review information

    def step_review(self) -> None:
        self.r.section("App Review information")
        review = dict(self.cfg.get("review") or {})
        env = self.env
        for field, var in (
            ("contactFirstName", "ASC_REVIEW_FIRST"),
            ("contactLastName", "ASC_REVIEW_LAST"),
            ("contactEmail", "ASC_REVIEW_EMAIL"),
            ("contactPhone", "ASC_REVIEW_PHONE"),
            ("demoAccountName", "ASC_REVIEW_DEMO_USER"),
            ("demoAccountPassword", "ASC_REVIEW_DEMO_PASSWORD"),
        ):
            if env.get(var):
                review[field] = env[var]
            elif not review.get(field):
                self.r.warn(f"{var} is not set: {field} keeps what App Store Connect has")
                review[field] = None
        notes = review.get("notes")
        if isinstance(notes, str):
            fills = {"{server_url}": env.get("ASC_REVIEW_SERVER_URL"), "{demo_user}": review.get("demoAccountName")}
            for placeholder, value in fills.items():
                if placeholder in notes:
                    if value:
                        notes = notes.replace(placeholder, value)
                    else:
                        var = "ASC_REVIEW_SERVER_URL" if placeholder == "{server_url}" else "ASC_REVIEW_DEMO_USER"
                        self.r.warn(f"{var} is not set: the review notes ({placeholder}) are not written")
                        notes = None
                        break
            review["notes"] = notes
        if not self.version:
            self.r.action("create the App Review information of the new version")
            diff_attributes(self.r, "review", {}, review)
            return
        detail = self.asc.get(f"/v1/appStoreVersions/{self.version['id']}/appStoreReviewDetail").get("data")
        if detail:
            changed = diff_attributes(self.r, "review", detail["attributes"], review)
            if changed:
                self.asc.write(
                    "PATCH",
                    f"/v1/appStoreReviewDetails/{detail['id']}",
                    {"data": {"type": "appStoreReviewDetails", "id": detail["id"], "attributes": changed}},
                )
            return
        self.r.action("create the App Review information")
        diff_attributes(self.r, "review", {}, review)
        self.asc.write(
            "POST",
            "/v1/appStoreReviewDetails",
            {"data": {"type": "appStoreReviewDetails",
                      "attributes": {k: v for k, v in review.items() if v is not None},
                      "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions",
                                                                     "id": self.version["id"]}}}}},
        )

    # -- screenshots

    def step_screenshots(self) -> None:
        self.r.section("Screenshots")
        shots = self.cfg.get("screenshots") or {}
        files = shots.get("files") or []
        if not files:
            print("  nothing in the JSON")
            return
        display_type = shots.get("displayType", "APP_IPHONE_67")
        folder = Path(shots.get("dir", ".")).expanduser()
        if len(files) > 10:
            raise AscError(f"{len(files)} screenshots; a set holds at most 10")
        wanted: list[dict[str, Any]] = []
        for name in files:
            path = folder / name
            if not path.is_file():
                raise AscError(f"screenshot not found: {path}")
            data = path.read_bytes()
            size = png_size(data)
            if size is None:
                raise AscError(f"{path} is not a PNG")
            if display_type == "APP_IPHONE_67" and size not in IPHONE_67_SIZES and size[::-1] not in IPHONE_67_SIZES:
                raise AscError(f"{path} is {size[0]}x{size[1]}; {display_type} takes {sorted(IPHONE_67_SIZES)}")
            wanted.append({"name": name, "path": path, "data": data, "md5": hashlib.md5(data).hexdigest()})
        print(f"  {len(wanted)} files from {folder} for {display_type}")
        for locale in shots.get("locales") or ["ja"]:
            if locale not in self.cfg["localizations"]:
                raise AscError(f"screenshots.locales has {locale}, which is not in localizations")
            self.sync_screenshot_set(locale, display_type, wanted)

    def sync_screenshot_set(self, locale: str, display_type: str, wanted: list[dict[str, Any]]) -> None:
        loc_id = self.version_locs.get(locale)
        if not loc_id:
            self.r.action(f"[{locale}] upload {len(wanted)} screenshots once the localization exists")
            return
        sets = self.asc.get_all(
            f"/v1/appStoreVersionLocalizations/{loc_id}/appScreenshotSets",
            {"filter[screenshotDisplayType]": display_type},
        )
        if sets:
            set_id = sets[0]["id"]
            existing = self.asc.get_all(
                f"/v1/appScreenshotSets/{set_id}/appScreenshots",
                {"fields[appScreenshots]": "fileName,fileSize,sourceFileChecksum,assetDeliveryState", "limit": 50},
            )
        else:
            self.r.action(f"[{locale}] create the {display_type} screenshot set")
            body = self.asc.write(
                "POST",
                "/v1/appScreenshotSets",
                {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": display_type},
                          "relationships": {"appStoreVersionLocalization": {
                              "data": {"type": "appStoreVersionLocalizations", "id": loc_id}}}}},
            )
            set_id = body["data"]["id"] if body else ""
            existing = []

        # Keep a screenshot whose checksum is one of the wanted files (first match only, not failed).
        by_md5: dict[str, str] = {}  # md5 -> kept screenshot id
        to_delete: list[dict[str, Any]] = []
        for shot in existing:
            a = shot["attributes"]
            state = ((a.get("assetDeliveryState") or {}).get("state")) or ""
            md5 = a.get("sourceFileChecksum") or ""
            if md5 in {w["md5"] for w in wanted} and md5 not in by_md5 and state != "FAILED":
                by_md5[md5] = shot["id"]
            else:
                to_delete.append(shot)
        for shot in to_delete:
            a = shot["attributes"]
            self.r.action(f"[{locale}] delete screenshot {a.get('fileName')} ({shot['id']})")
            self.asc.write("DELETE", f"/v1/appScreenshots/{shot['id']}")
        uploaded: list[str] = []
        for w in wanted:
            if w["md5"] in by_md5:
                continue
            self.r.action(f"[{locale}] upload {w['name']} ({len(w['data'])} bytes)")
            if not set_id or self.asc.dry_run:
                continue
            shot_id = self.upload_screenshot(set_id, w)
            by_md5[w["md5"]] = shot_id
            uploaded.append(shot_id)
        if uploaded:
            self.wait_for_processing(locale, uploaded)

        if self.asc.dry_run or not set_id:
            kept = set(by_md5.values())
            current_kept = [s["id"] for s in existing if s["id"] in kept]
            desired_kept = [by_md5[w["md5"]] for w in wanted if w["md5"] in by_md5]
            if len(desired_kept) == len(wanted) and not to_delete and current_kept == desired_kept:
                self.r.same(f"[{locale}] {len(wanted)} screenshots in order")
            else:
                self.r.action(f"[{locale}] put the screenshots in the order of the JSON")
            return
        order = [by_md5[w["md5"]] for w in wanted]
        current = [s["id"] for s in self.asc.get_all(f"/v1/appScreenshotSets/{set_id}/appScreenshots")]
        if current == order:
            self.r.same(f"[{locale}] {len(wanted)} screenshots in order")
            return
        self.r.action(f"[{locale}] put the screenshots in the order of the JSON")
        self.asc.write(
            "PATCH",
            f"/v1/appScreenshotSets/{set_id}/relationships/appScreenshots",
            {"data": [{"type": "appScreenshots", "id": i} for i in order]},
        )

    def upload_screenshot(self, set_id: str, w: dict[str, Any]) -> str:
        body = self.asc.write(
            "POST",
            "/v1/appScreenshots",
            {"data": {"type": "appScreenshots", "attributes": {"fileName": w["name"], "fileSize": len(w["data"])},
                      "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": set_id}}}}},
        )
        assert body is not None
        shot = body["data"]
        for op in shot["attributes"].get("uploadOperations") or []:
            chunk = w["data"][op["offset"] : op["offset"] + op["length"]]
            headers = {h["name"]: h["value"] for h in op.get("requestHeaders") or []}
            r = httpx.request(op["method"], op["url"], content=chunk, headers=headers, timeout=300)
            if r.status_code >= 400:
                raise AscError(f"uploading {w['name']}: HTTP {r.status_code} from the upload server: {r.text[:500]}")
        self.asc.write(
            "PATCH",
            f"/v1/appScreenshots/{shot['id']}",
            {"data": {"type": "appScreenshots", "id": shot["id"],
                      "attributes": {"uploaded": True, "sourceFileChecksum": w["md5"]}}},
        )
        return shot["id"]

    def wait_for_processing(self, locale: str, ids: list[str], timeout: float = 300) -> None:
        pending = set(ids)
        deadline = time.time() + timeout
        while pending and time.time() < deadline:
            time.sleep(5)
            for shot_id in sorted(pending):
                a = self.asc.get(f"/v1/appScreenshots/{shot_id}",
                                 {"fields[appScreenshots]": "fileName,assetDeliveryState"})["data"]["attributes"]
                st = a.get("assetDeliveryState") or {}
                if st.get("state") == "COMPLETE":
                    pending.discard(shot_id)
                elif st.get("state") == "FAILED":
                    errs = "; ".join(f"{e.get('code')}: {e.get('description')}" for e in st.get("errors") or [])
                    raise AscError(f"[{locale}] App Store Connect rejected {a.get('fileName')}: {errs}")
        if pending:
            self.r.warn(f"[{locale}] {len(pending)} screenshots still processing; check App Store Connect later")
        else:
            print(f"  [{locale}] {len(ids)} uploaded screenshots processed")


def png_size(data: bytes) -> tuple[int, int] | None:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


REMINDERS = """
Still to do by hand in App Store Connect (not available in the API):
  - App Privacy (nutrition labels): answer as docs/store/PRIVACY_AND_RATINGS.md §1 (no tracking; name, email, user ID,
    messages, photos/videos, other user content, all linked to the user, purpose App Functionality).
  - Pricing and Availability: free, the countries/regions to sell in.
  - App information → Content Rights (third-party content), if App Store Connect asks for it.
  - Check the age rating result, then "Add for Review" / "Submit for Review" on the version page."""


def parse_steps(value: str) -> set[str]:
    steps = {s.strip() for s in value.split(",") if s.strip()}
    unknown = steps - set(STEPS)
    if unknown:
        raise argparse.ArgumentTypeError(f"unknown step(s) {', '.join(sorted(unknown))}; steps: {', '.join(STEPS)}")
    return steps


def main() -> int:
    p = argparse.ArgumentParser(description="Fill the App Store Connect record from docs/store/appstore.json.")
    p.add_argument("--dry-run", action="store_true", help="GET only; print what would change")
    p.add_argument("--build", type=int, help="build number to attach (default: the highest VALID one)")
    p.add_argument("--no-build", action="store_true", help="do not change the attached build")
    p.add_argument("--only", type=parse_steps, default=set(), help=f"comma-separated steps: {','.join(STEPS)}")
    p.add_argument("--skip", type=parse_steps, default=set(), help="comma-separated steps to skip")
    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = p.parse_args()

    try:
        cfg = load_config(args.config)
        env = settings()
        missing = [k for k in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH") if not env.get(k)]
        if missing:
            raise AscError(f"{', '.join(missing)} not set (~/.config/taylis/release.env or the environment)")
        asc = Asc(env["ASC_KEY_ID"], env["ASC_ISSUER_ID"], Path(env["ASC_KEY_PATH"]).expanduser(), args.dry_run)
        report = Report(args.dry_run)
        if args.dry_run:
            print("DRY RUN: only GET requests; nothing is changed in App Store Connect.")
        run = Run(asc, cfg, env, report, args)
        run.find_app()
        # The version is needed by build/texts/review/screenshots even when its own step is skipped.
        if run.enabled("version"):
            run.step_version()
        else:
            versions = asc.get_all(f"/v1/apps/{run.app_id}/appStoreVersions",
                                   {"filter[platform]": cfg["platform"], "limit": 200})
            editable = [v for v in versions if v["attributes"].get("appVersionState") in EDITABLE_VERSION_STATES]
            run.version = editable[0] if editable else None
        run.load_version_localizations()
        if run.enabled("build"):
            run.step_build()
        if run.enabled("texts"):
            run.step_texts()
        if any(run.enabled(s) for s in ("appinfo", "categories", "age")):
            run.find_app_info()
        if run.enabled("appinfo"):
            run.step_appinfo()
        if run.enabled("categories"):
            run.step_categories()
        if run.enabled("age"):
            run.step_age()
        if run.enabled("review"):
            run.step_review()
        if run.enabled("screenshots"):
            run.step_screenshots()
    except AscError as e:
        print(f"\nasc-metadata: {e}", file=sys.stderr)
        return 1

    print()
    if args.dry_run:
        print(f"Dry run: {report.changes} change(s) would be made.")
    else:
        print(f"Done: {report.changes} change(s), {asc.writes} write request(s).")
    if report.warnings:
        print(f"{len(report.warnings)} warning(s):")
        for w in report.warnings:
            print(f"  - {w}")
    print(REMINDERS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
