"""「AI に聞く」 (docs/AI.md §13): the words of a question, and the numbered messages sent with it.

The messages are found by the search (app/modules/search: the same scope rules, indexes and
limits as the search box); this module only turns the question into words, adds each hit's
context (its thread's parent, the message before and after it) and numbers what is sent.
"""

import unicodedata
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.ai import prompts
from app.modules.ai import repository as repo
from app.modules.channels.schemas import ChannelOut
from app.modules.messages.models import Message
from app.modules.search.snippet import make_snippet

MAX_TERMS = 8
# Words a question is made of rather than about (kanji / katakana runs and English).
_STOP_JA = {
    "方法",
    "内容",
    "最近",
    "以前",
    "今回",
    "前回",
    "場合",
    "質問",
    "回答",
    "具体的",
    "一体",
    "全部",
    "結局",
    "本当",
    "何時",
    "何人",
    "何回",
    "何処",
}
_STOP_EN = {
    "a",
    "an",
    "and",
    "are",
    "about",
    "as",
    "at",
    "be",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "for",
    "from",
    "has",
    "have",
    "how",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "our",
    "please",
    "so",
    "tell",
    "that",
    "the",
    "there",
    "this",
    "to",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "will",
    "with",
    "would",
    "you",
}
# Inside an English word or a version (v0.1.18, gpt-6, file_name), between letters or digits.
_JOINERS = {".", "-", "_"}


def _kind(ch: str) -> str:
    code = ord(ch)
    if ch in "\u3005\u3006\u30f6" or 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
        return "kanji"
    if 0x30A1 <= code <= 0x30FF:  # katakana and the long vowel mark
        return "katakana"
    if 0x3041 <= code <= 0x309F:
        return "hiragana"
    if ch.isalnum():
        return "latin"
    return "other"


def _runs(text: str) -> list[tuple[str, str]]:
    """(kind, run) of the same kind of characters, in order; separators dropped."""
    out: list[tuple[str, str]] = []
    kind, run = "", ""
    for i, ch in enumerate(text):
        k = _kind(ch)
        if (
            k == "other"
            and ch in _JOINERS
            and kind == "latin"
            and i + 1 < len(text)
            and _kind(text[i + 1]) == "latin"
        ):
            k = "latin"
        if k == kind:
            run += ch
            continue
        if run and kind != "other":
            out.append((kind, run))
        kind, run = k, ch
    if run and kind != "other":
        out.append((kind, run))
    return out


def question_terms(question: str) -> list[str]:
    """docs/AI.md §13.2: the search words of a question (its modifiers already removed). Runs of
    kanji, katakana or letters and digits of two characters or more; hiragana (particles,
    endings) and common question words are dropped. At most MAX_TERMS, in order."""
    text = unicodedata.normalize("NFKC", question)
    terms: list[str] = []
    stopped: list[str] = []
    singles: list[str] = []
    for kind, run in _runs(text):
        if kind == "hiragana":
            continue
        if len(run) < 2:
            if kind == "kanji":
                singles.append(run)
            continue
        word = run.lower() if kind == "latin" else run
        if word in _STOP_JA or word in _STOP_EN:
            stopped.append(word)
            continue
        terms.append(word)
    chosen = terms or stopped or singles
    return list(dict.fromkeys(chosen))[:MAX_TERMS]


def groonga_query(terms: list[str]) -> str:
    """Any of the words (Groonga query syntax): the more of them a message has, the higher it
    ranks. Each word quoted, so none is read as an operator."""
    quoted = []
    for term in terms:
        escaped = term.replace("\\", "\\\\").replace('"', '\\"')
        quoted.append(f'"{escaped}"')
    return " OR ".join(quoted)


def channel_label(channel: ChannelOut | None) -> str:
    if channel is None:
        return "会話"
    if channel.type == "dm":
        return "ダイレクトメッセージ"
    if channel.type == "group_dm":
        return "グループ DM"
    return f"#{channel.name}"


@dataclass
class Gathered:
    """What is sent: blocks of numbered lines, and the sources by number."""

    blocks: list[list[str]] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.sources


async def _block(db: AsyncSession, hit: Message) -> list[Message]:
    """A hit with its context, oldest first: its thread's parent (for a reply), and the
    messages just before and after it in its stream."""
    rows: dict[uuid.UUID, Message] = {hit.id: hit}
    if hit.parent_id is not None:
        parent = await repo.live_message(db, hit.parent_id)
        if parent is not None:
            rows[parent.id] = parent
    prev, nxt = await repo.neighbours(db, hit)
    for row in (prev, nxt):
        if row is not None:
            rows[row.id] = row
    return sorted(rows.values(), key=lambda m: m.seq)


async def gather(
    db: AsyncSession,
    hits: list[Message],
    *,
    keywords: list[str],
    channels: dict[uuid.UUID, ChannelOut],
    tz_offset_minutes: int,
    visible: set[uuid.UUID] | None,
) -> Gathered:
    """docs/AI.md §13.2 3-4: each hit (most relevant first) with its context as a block;
    numbers [1]..[n] in the order sent, a message only once; each message clipped to
    ASK_LINE_CHARS, and a block that would pass ASK_CHARS in all left out."""
    blocks = [await _block(db, hit) for hit in hits]
    unique: dict[uuid.UUID, Message] = {}
    for block in blocks:
        for m in block:
            unique.setdefault(m.id, m)
    rows = list(unique.values())
    parts = await prompts.render_parts(
        db, rows, tz_offset_minutes=tz_offset_minutes, visible=visible
    )
    rendered = {m.id: p for m, p in zip(rows, parts, strict=True)}
    out = Gathered()
    numbered: set[uuid.UUID] = set()
    used = 0
    for block in blocks:
        fresh = [m for m in block if m.id not in numbered]
        if not fresh:
            continue
        lines: list[tuple[Message, str, str]] = []
        for m in fresh:
            part = rendered[m.id]
            body = part.body
            if len(body) > prompts.ASK_LINE_CHARS:
                body = body[: prompts.ASK_LINE_CHARS - 1] + "…"
            reply = "↳ " if m.parent_id is not None else ""
            where = channel_label(channels.get(m.channel_id))
            lines.append((m, body, f"{where} / {reply}{part.sender} ({part.when}): {body}"))
        size = sum(len(line) + 8 for _, _, line in lines)
        if used + size > prompts.ASK_CHARS:
            continue
        used += size
        block_lines: list[str] = []
        for m, body, line in lines:
            n = len(out.sources) + 1
            numbered.add(m.id)
            block_lines.append(f"[{n}] {line}")
            out.sources.append(
                {
                    "n": n,
                    "message_id": str(m.id),
                    "channel_id": str(m.channel_id),
                    "parent_id": str(m.parent_id) if m.parent_id else None,
                    "sender_id": str(m.sender_id),
                    "created_at": m.created_at.isoformat(),
                    "excerpt": make_snippet(body, keywords),
                }
            )
        out.blocks.append(block_lines)
    return out
