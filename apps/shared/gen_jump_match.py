"""Writes jump-match.json: the rule the phones' 「移動・検索」 and the desktop's ⌘K use to find a conversation or a
person by name (MOBILE_UI.md §6.2, M37), and the cases every client is tested against.

Run from this directory: python3 gen_jump_match.py
"""

import json
import unicodedata


def normalize(text: str) -> str:
    """NFKC (full-width / half-width forms), lower case, katakana as hiragana, no leading # or @, trimmed."""
    folded = unicodedata.normalize("NFKC", text).lower().strip()
    folded = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in folded)
    return folded.lstrip("#@").strip()


SEPARATORS = " -_./・　"


def score(query: str, names: list[str]) -> int | None:
    """0: a name starts with the query; 1: a word in a name does (after a space, - _ . / ・);
    2: a name contains it; None: no match. The best of the names (a DM: the people's names and usernames)."""
    q = normalize(query)
    if not q:
        return None
    best = None
    for name in names:
        n = normalize(name)
        if n.startswith(q):
            s = 0
        elif any(n[i - 1] in SEPARATORS and n[i:].startswith(q) for i in range(1, len(n))):
            s = 1
        elif q in n:
            s = 2
        else:
            continue
        best = s if best is None else min(best, s)
    return best


def rank(query: str, items: list[dict]) -> list[str]:
    """Matches only, by score, then unread first, then the normalized title in code-point order (the same on every
    platform: a locale's collation orders kanji differently from one to another)."""
    hits = [(score(query, it["names"]), not it.get("unread", False), normalize(it["title"]), it["id"]) for it in items]
    return [h[3] for h in sorted(h for h in hits if h[0] is not None)]


NORMALIZE = ["#General", "ＡＢＣ", "ｶﾀｶﾅ", "カタカナ", "@kano", "  m2-進捗 ", "ｾﾞﾐ", "ﾊﾟｰﾃｨ"]
SCORES = [
    ("gen", ["general"]),
    ("GEN", ["general"]),
    ("進捗", ["m2-進捗"]),
    ("m2", ["m2-進捗"]),
    ("era", ["general"]),
    ("かの", ["カノウ トオル", "kano"]),
    ("toru", ["加納 透", "toru"]),
    ("ol", ["tool-dev"]),
    ("dev", ["tool-dev"]),
    ("zzz", ["general"]),
    ("", ["general"]),
    ("#ran", ["random"]),
    # A half-width voiced kana is one letter after NFKC (Foundation splits it unless composed again: NFC after NFKC).
    ("ｾﾞﾐ", ["ゼミ連絡"]),
    ("ぜみ", ["ｾﾞﾐ連絡"]),
]
ITEMS = [
    {"id": "general", "title": "general", "names": ["general"]},
    {"id": "gen-z", "title": "gen-z", "names": ["gen-z"], "unread": True},
    {"id": "m2", "title": "m2-進捗", "names": ["m2-進捗"]},
    {"id": "agenda", "title": "agenda", "names": ["agenda"], "unread": True},
    {"id": "dm-kano", "title": "加納 透", "names": ["加納 透", "kano"]},
    {"id": "dm-gen", "title": "源 さん", "names": ["源 さん", "gen_minamoto"]},
]
RANKS = ["gen", "進捗", "kano", "a", "zzz"]


def pick(query: str, users: list[dict]) -> dict:
    """Who a new DM can go to (the ✏️ picker, the new-DM dialog, 移動・検索's 「人」): not deactivated; a bot (role
    "bot": a webhook, a channel's feed, the reservation bot, …) only when it is an AI bot (GET /ai/status's agents),
    and then in a 「ボット」 group after the people. Each group by the rank with a query; without one by the normalized
    display name, then the id (me is the caller's own row, never in `users`)."""

    def order(group: list[dict]) -> list[str]:
        if normalize(query):
            items = [{"id": u["id"], "title": u["display_name"], "names": [u["display_name"], u["username"]]} for u in group]
            return rank(query, items)
        return [u["id"] for u in sorted(group, key=lambda u: (normalize(u["display_name"]), u["id"]))]

    live = [u for u in users if not u.get("deactivated")]
    return {
        "people": order([u for u in live if u["role"] != "bot"]),
        "bots": order([u for u in live if u["role"] == "bot" and u.get("ai")]),
    }


# Names in lower-case ASCII so that a client's own sort without a query (a locale's collation) agrees.
PICK_USERS = [
    {"id": "sato", "display_name": "sato hanako", "username": "sato", "role": "member"},
    {"id": "gen", "display_name": "gen", "username": "gen_minamoto", "role": "admin"},
    {"id": "guest", "display_name": "guest-ken", "username": "ken", "role": "guest"},
    {"id": "old", "display_name": "old member", "username": "old", "role": "member", "deactivated": True},
    {"id": "hook", "display_name": "github", "username": "github-hook", "role": "bot"},
    {"id": "feed", "display_name": "news feed", "username": "feed-news", "role": "bot"},
    {"id": "rsv", "display_name": "reservations", "username": "reservation-bot", "role": "bot"},
    {"id": "ai", "display_name": "chikuwa ai", "username": "ai-chikuwa", "role": "bot", "ai": True},
    {"id": "ai2", "display_name": "agent smith", "username": "ai-smith", "role": "bot", "ai": True},
    {"id": "ai-off", "display_name": "ai retired", "username": "ai-old", "role": "bot", "ai": True, "deactivated": True},
]
PICKS = ["", "a", "git", "ai", "news", "ken", "zzz"]


def main() -> None:
    doc = {
        "_comment": (
            "MOBILE_UI.md §6.2 (M37): matching a conversation or person by name in the phones' 移動・検索 and the "
            "desktop's ⌘K. normalize: NFKC, lower case, katakana as hiragana, no leading # / @, trimmed. score: 0 a "
            "name starts with the query, 1 a word in it does (after space - _ . / ・ or an ideographic space), 2 it "
            "contains it, null no match; the best over the item's names (a DM: display names and usernames). rank: "
            "matches only, by score, then unread first, then the normalized title in code-point order (UTF-16 code units; "
            "no locale collation). pick: who a new DM can go to (✏️, the new-DM dialog, 移動・検索's people): not deactivated; a "
            "bot (role bot) only when it is an AI bot (ai: in GET /ai/status's agents), in its own group after the people; "
            "each group ranked with a query, by the normalized display name then the id without. Generated by "
            "gen_jump_match.py."
        ),
        "normalize": [{"input": s, "output": normalize(s)} for s in NORMALIZE],
        "score": [{"query": q, "names": n, "score": score(q, n)} for q, n in SCORES],
        "rank": {"items": ITEMS, "cases": [{"query": q, "ids": rank(q, ITEMS)} for q in RANKS]},
        "pick": {"users": PICK_USERS, "cases": [{"query": q, **pick(q, PICK_USERS)} for q in PICKS]},
    }
    with open("jump-match.json", "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
