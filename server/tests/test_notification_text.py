"""One-line push text (PUSH_NOTIFICATIONS.md): markdown flattened like the clients' previews."""

from app.modules.messages.mentions import notification_text


def test_tables_flatten_to_their_cells() -> None:  # M15g
    body = "担当表\n| 項目 | 担当 |\n| :--- | :-: |\n| API | 田中 |\n| a \\| b | **UI** |\n以上"
    assert notification_text(body, {}) == "担当表 項目 担当 API 田中 a | b UI 以上"


def test_other_markdown_still_flattens() -> None:
    assert (
        notification_text("# 見出し\n- **太字** と `code`\n> 引用", {})
        == "見出し 太字 と code 引用"
    )
