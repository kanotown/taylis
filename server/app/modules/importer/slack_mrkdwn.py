"""Slack mrkdwn → the ChikuwaChat body format (M87; DATA_MODEL.md "本文の形式").

Slack stores a message's text with ``&amp; &lt; &gt;`` escaped and everything special between
``<`` and ``>``: ``<@U123>`` people, ``<#C123|name>`` channels, ``<!here>`` the group mentions,
``<https://…|label>`` links. Formatting is ``*bold*``, ``_italic_``, ``~strike~``, `` `code` ``,
```` ```blocks``` ```` and ``>`` / ``>>>`` quotes. ChikuwaChat keeps plain text with
``<@uuid>`` / ``<!channel>`` / ``<!here>`` tokens and a light markdown its clients render.

Pure functions: the importer passes in how people, channels and emoji names resolve.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass

# Code first (Slack formats nothing inside it), then the <…> tokens.
_CODE = re.compile(r"```(.*?)```|`([^`\n]+)`", re.DOTALL)
_TOKEN = re.compile(r"<([^<>\n]+)>")
_SHORTCODE = re.compile(r"(?<![\w:]):([a-z0-9_+'-]{1,64}):(?::skin-tone-([2-6]):)?")
# Bold / strike need a non-space just inside the markers and no ASCII word character just
# outside them (Japanese text around them is fine: people do not always leave a space there).
_BOLD = re.compile(r"(?<![A-Za-z0-9*])\*(?![\s*])([^*\n]*?[^\s*])\*(?![A-Za-z0-9*])")
_STRIKE = re.compile(r"(?<![A-Za-z0-9~])~(?![\s~])([^~\n]*?[^\s~])~(?![A-Za-z0-9~])")
_QUOTE_ALL = re.compile(r"^&gt;&gt;&gt;[ \t]?", re.MULTILINE)
_QUOTE_LINE = re.compile(r"^&gt;[ \t]?", re.MULTILINE)
_SLOT = re.compile("\ue000(\\d+)\ue001")
_PADDED_SLOT = re.compile("[ \t]*\ue000(\\d+)\ue001[ \t]*")
_SAFE_LABEL = re.compile(r"^[^\[\]\n]+$")
_SAFE_URL = re.compile(r"^https?://[^\s()<>]+$", re.IGNORECASE)
SKIN_TONES = {
    "2": "\U0001f3fb",
    "3": "\U0001f3fc",
    "4": "\U0001f3fd",
    "5": "\U0001f3fe",
    "6": "\U0001f3ff",
}
_ZWJ = "\u200d"
_VS16 = "\ufe0f"


def unescape(text: str) -> str:
    """Slack escapes exactly these three (``&amp;`` last, so ``&amp;lt;`` stays ``&lt;``)."""
    return text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def with_skin_tone(glyph: str, tone: str | None) -> str:
    """``:wave::skin-tone-3:``: the modifier goes after the first person in the sequence."""
    modifier = SKIN_TONES.get(tone or "")
    if modifier is None:
        return glyph
    head, sep, rest = glyph.partition(_ZWJ)
    return head.replace(_VS16, "") + modifier + sep + rest


@dataclass
class Resolver:
    """How the importer's data answers a token: each returns the text to put in the body."""

    user: Callable[[str, str | None], str]  # (Slack user id, label) → "<@uuid>" or "@name"
    user_text: Callable[[str, str | None], str]  # the same person as plain "@name" (in code)
    channel: Callable[[str, str | None], str]  # (Slack channel id, label) → "#name"
    emoji: Callable[[str, str | None], str | None]  # (name, skin tone "2".."6") → glyph or None


def _link(target: str, label: str | None) -> str:
    label = unescape(label).strip() if label else None
    target = unescape(target)
    if target.lower().startswith("mailto:"):
        address = target[7:]
        return address if not label or label == address else f"{label} ({address})"
    if not re.match(r"^https?://", target, re.IGNORECASE):
        return label or target
    bare = re.sub(r"^https?://", "", target, flags=re.IGNORECASE).rstrip("/")
    if not label or label in (target, bare, bare + "/"):
        return target
    if _SAFE_LABEL.match(label) and _SAFE_URL.match(target):
        return f"[{label}]({target})"
    return f"{label} ({target})"


def _token(inner: str, resolver: Resolver, *, in_code: bool) -> str:
    """One ``<…>`` token. Inside code a mention reads as plain ``@name`` (clients do not turn
    tokens inside code into mentions)."""
    target, _, label = inner.partition("|")
    label_or_none = label or None
    if target.startswith("@"):
        if in_code:
            return resolver.user_text(target[1:], label_or_none)
        return resolver.user(target[1:], label_or_none)
    if target.startswith("#"):
        return resolver.channel(target[1:], label_or_none)
    if target.startswith("!"):
        command = target[1:]
        name = command.split("^", 1)[0]
        if name in ("here", "channel", "everyone"):
            group = "here" if name == "here" else "channel"
            return f"@{group}" if in_code else f"<!{group}>"
        if name == "subteam":  # a user group: its handle, as text
            return unescape(label) if label else "@group"
        return unescape(label) if label else name  # <!date^…|fallback> and the like
    return _link(target, label_or_none)


def _flatten(text: str, resolver: Resolver) -> str:
    """Code: tokens become their plain text, entities are decoded, nothing else changes."""
    return unescape(_TOKEN.sub(lambda m: _token(m.group(1), resolver, in_code=True), text))


def to_markdown(text: str, resolver: Resolver) -> str:
    slots: list[str] = []
    fences: set[int] = set()

    def slot(value: str, *, fence: bool = False) -> str:
        slots.append(value)
        if fence:
            fences.add(len(slots) - 1)
        return f"\ue000{len(slots) - 1}\ue001"

    def code(match: re.Match[str]) -> str:
        if match.group(1) is not None:
            body = match.group(1)
            body = body.removeprefix("\n").removesuffix("\n")
            return slot("```\n" + _flatten(body, resolver) + "\n```", fence=True)
        return slot("`" + _flatten(match.group(2), resolver) + "`")

    def emoji(match: re.Match[str]) -> str:
        glyph = resolver.emoji(match.group(1), match.group(2))
        return slot(glyph) if glyph is not None else match.group(0)

    plain = _CODE.sub(code, text.replace("\r\n", "\n"))
    plain = _TOKEN.sub(lambda m: slot(_token(m.group(1), resolver, in_code=False)), plain)
    plain = _SHORTCODE.sub(emoji, plain)
    plain = _quotes(plain)
    plain = _BOLD.sub(r"**\1**", plain)
    plain = _STRIKE.sub(r"~~\1~~", plain)
    plain = unescape(plain)

    def restore(match: re.Match[str]) -> str:
        index = int(match.group(1))
        value = slots[index]
        if index in fences:  # a block needs its fences on lines of their own
            before = match.string[: match.start()]
            after = match.string[match.end() :]
            if before and not before.endswith("\n"):
                value = "\n" + value
            if after and not after.startswith("\n"):
                value += "\n"
        return value

    # Spaces next to a block's fences would only trail or lead its lines.
    plain = _PADDED_SLOT.sub(
        lambda m: m.group(0).strip(" \t") if int(m.group(1)) in fences else m.group(0), plain
    )
    return _SLOT.sub(restore, plain)


def _quotes(text: str) -> str:
    """``>>>`` quotes the rest of the message; ``>`` one line (kept as ChikuwaChat's ``> ``)."""
    match = _QUOTE_ALL.search(text)
    if match is not None:
        head, rest = text[: match.start()], text[match.end() :]
        text = head + "\n".join("> " + line for line in rest.split("\n"))
    return _QUOTE_LINE.sub("> ", text)
