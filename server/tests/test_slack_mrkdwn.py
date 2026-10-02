"""Slack mrkdwn → ChikuwaChat markdown (M87): the pure conversions."""

import uuid

import pytest

from app.modules.importer.core import standard_glyph
from app.modules.importer.slack_import import fallback_text, slug, ts_to_us
from app.modules.importer.slack_mrkdwn import Resolver, to_markdown, unescape, with_skin_tone

TARO = uuid.UUID("0192a000-0000-7000-8000-000000000001")
NAMES = {"U1": "taro", "U2": "hanako"}


def _user(uid: str, label: str | None) -> str:
    return f"<@{TARO}>" if uid == "U1" else "@" + (label or NAMES.get(uid, uid))


def _text(uid: str, label: str | None) -> str:
    return "@" + (label or NAMES.get(uid, uid))


def _channel(cid: str, label: str | None) -> str:
    return "#slack-general" if cid == "C1" else "#" + (label or cid)


def _emoji(name: str, tone: str | None) -> str | None:
    glyph = standard_glyph(name)
    return with_skin_tone(glyph, tone) if glyph else None


R = Resolver(user=_user, user_text=_text, channel=_channel, emoji=_emoji)


def md(text: str) -> str:
    return to_markdown(text, R)


@pytest.mark.parametrize(
    ("slack", "chikuwa"),
    [
        # people: a mapped one becomes a mention token, others their name as text
        ("hi <@U1>", f"hi <@{TARO}>"),
        ("hi <@U1|taro>!", f"hi <@{TARO}>!"),
        ("<@U2> と <@U9|ghost>", "@hanako と @ghost"),
        # channels: the imported name, else the label
        ("see <#C1|general>", "see #slack-general"),
        ("see <#C7|elsewhere> and <#C8>", "see #elsewhere and #C8"),
        # group mentions
        ("<!here> <!channel> <!everyone>", "<!here> <!channel> <!channel>"),
        ("<!here|here> now", "<!here> now"),
        ("<!subteam^S1|@devs> look", "@devs look"),
        ("<!date^1700000000^{date}|Nov 14> ok", "Nov 14 ok"),
        # links
        ("<https://example.com|Example>", "[Example](https://example.com)"),
        ("<https://example.com>", "https://example.com"),
        ("<https://example.com|example.com>", "https://example.com"),
        ("<https://x.io/a_b_c*d*>", "https://x.io/a_b_c*d*"),
        ("<https://x.io/?a=1&amp;b=2|q>", "[q](https://x.io/?a=1&b=2)"),
        ("<https://x.io/(paren)|label>", "label (https://x.io/(paren))"),
        ("<mailto:a@b.jp|a@b.jp>", "a@b.jp"),
        ("<mailto:a@b.jp|メール>", "メール (a@b.jp)"),
        ("<tel:0123|電話>", "電話"),
        # formatting
        ("*bold* and _it_ and ~gone~", "**bold** and _it_ and ~~gone~~"),
        ("これは*重要*です", "これは**重要**です"),
        ("2*3*4 and a * b * c", "2*3*4 and a * b * c"),
        ("*see <https://x.io|here>*", "**see [here](https://x.io)**"),
        ("*<@U1>*", f"**<@{TARO}>**"),
        # entities, decoded once
        ("a &amp; b &lt;tag&gt;", "a & b <tag>"),
        ("&amp;lt; stays", "&lt; stays"),
        # quotes
        ("&gt; quoted\nnot", "> quoted\nnot"),
        ("&gt;tight", "> tight"),
        ("intro\n&gt;&gt;&gt; a\nb", "intro\n> a\n> b"),
        # emoji
        (":smile: :wave::skin-tone-3: :custom_x:", "😄 👋🏼 :custom_x:"),
        ("at 10:30:00", "at 10:30:00"),
        # code: nothing formatted, tokens as plain text, entities decoded
        ("`*x* <@U1> &lt;b&gt;`", "`*x* @taro <b>`"),
        ("run ```a *b*\n&lt;c&gt;``` done", "run\n```\na *b*\n<c>\n```\ndone"),
        ("```\nline1\nline2\n```", "```\nline1\nline2\n```"),
        ("```python\nprint(1)```", "```\npython\nprint(1)\n```"),
        ("``` <!here> ```", "```\n @here \n```"),
        ("unclosed ``` *b*", "unclosed ``` **b**"),
    ],
)
def test_mrkdwn(slack: str, chikuwa: str) -> None:
    assert md(slack) == chikuwa


def test_unescape_and_skin_tones() -> None:
    assert unescape("&amp;gt;") == "&gt;"
    thumbs = standard_glyph("+1")
    assert thumbs is not None
    assert with_skin_tone(thumbs, "2") == "👍🏻"
    assert with_skin_tone(thumbs, None) == thumbs
    raising = standard_glyph("woman-raising-hand")
    assert raising is not None and "\u200d" in raising
    toned = with_skin_tone(raising, "5")
    assert toned.startswith("🙋🏾\u200d") and "\ufe0f\U0001f3fe" not in toned


def test_ts_and_slugs() -> None:
    assert ts_to_us("1714521600.000200") == 1_714_521_600_000_200
    assert ts_to_us("1714521600.5") == 1_714_521_600_500_000
    assert ts_to_us("1714521600") == 1_714_521_600_000_000
    assert ts_to_us(None) == 0
    assert slug("CI Bot") == "ci-bot"
    assert slug("  日本語ボット ") == ""


def test_fallback_text_from_attachments_and_blocks() -> None:
    assert fallback_text({"attachments": [{"fallback": "Build #3 passed"}]}) == "Build #3 passed"
    assert (
        fallback_text(
            {"attachments": [{"pretext": "Deploy", "title": "v1", "title_link": "https://x.io"}]}
        )
        == "Deploy\n<https://x.io|v1>"
    )
    blocks = {
        "blocks": [
            {
                "type": "rich_text",
                "elements": [
                    {
                        "type": "rich_text_section",
                        "elements": [
                            {"type": "text", "text": "Hi "},
                            {"type": "user", "user_id": "U1"},
                            {"type": "text", "text": " a<b", "style": {"bold": True}},
                            {"type": "emoji", "name": "wave", "skin_tone": 2},
                            {"type": "link", "url": "https://x.io", "text": "x"},
                        ],
                    },
                    {
                        "type": "rich_text_list",
                        "style": "bullet",
                        "elements": [
                            {
                                "type": "rich_text_section",
                                "elements": [{"type": "text", "text": "one"}],
                            }
                        ],
                    },
                ],
            },
            {"type": "section", "text": {"type": "mrkdwn", "text": "*done*"}},
        ]
    }
    text = fallback_text(blocks)
    assert md(text) == f"Hi <@{TARO}> **a<b**👋🏻[x](https://x.io)\n- one\n**done**"
    assert fallback_text({"text": ""}) == ""
