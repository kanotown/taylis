package jp.chikuwachat.android

import jp.chikuwachat.android.ui.TopicInternalLink
import jp.chikuwachat.android.ui.TopicText
import jp.chikuwachat.android.ui.TopicToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 2026-10-28: a channel's topic with its links (as the desktop's topicText.test.tsx). */
class TopicTextTest {
    @Test
    fun markdownLinksAndBareUrlsAreLinks() {
        assertEquals(
            listOf(TopicToken.Text("議事録: "), TopicToken.Link("https://example.com/notes", "ノート"), TopicToken.Text(" と "), TopicToken.Link("http://lab.example.org/x?y=1")),
            TopicText.tokens("議事録: [ノート](https://example.com/notes) と http://lab.example.org/x?y=1"),
        )
        assertTrue(TopicText.hasLink("see https://example.com"))
        assertFalse(TopicText.hasLink("no links here"))
    }

    @Test
    fun mailtoLinksAreLinks() {
        assertEquals(
            listOf(TopicToken.Text("連絡: "), TopicToken.Link("mailto:lab@example.com", "事務")),
            TopicText.tokens("連絡: [事務](mailto:lab@example.com)"),
        )
    }

    @Test
    fun otherSchemesStayText() {
        for (topic in listOf("[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](intent://scan#Intent;end)", "javascript:alert(1)", "[x](file:///etc/passwd)")) {
            assertTrue(topic, TopicText.tokens(topic).none { it is TopicToken.Link })
        }
        assertTrue(TopicText.allowed("https://example.com"))
        assertTrue(TopicText.allowed("HTTP://example.com"))
        assertTrue(TopicText.allowed("mailto:a@b.jp"))
        assertFalse(TopicText.allowed("javascript:alert(1)"))
        assertFalse(TopicText.allowed("data:text/html,x"))
        assertFalse(TopicText.allowed("intent://x"))
        assertFalse(TopicText.allowed("https:example.com"))
        assertFalse(TopicText.allowed("mailto:"))
        assertFalse(TopicText.allowed("example.com"))
    }

    @Test
    fun inlineStylesKeepTheirLookAndLinesJoin() {
        assertEquals(
            listOf(TopicToken.Bold("重要"), TopicToken.Text(" "), TopicToken.Code("make"), TopicToken.Text(" "), TopicToken.Italic("note"), TopicToken.Text(" "), TopicToken.Strike("old"), TopicToken.Text(" a b")),
            TopicText.tokens("**重要** `make` _note_ ~~old~~ a\n b"),
        )
    }

    @Test
    fun mentionsReadAsNames() {
        val id = "11111111-2222-3333-4444-555555555555"
        assertEquals(listOf(TopicToken.Text("担当 @加納")), TopicText.tokens("担当 <@$id>") { if (it == id) "加納" else null })
        assertEquals(listOf(TopicToken.Text("@unknown")), TopicText.tokens("<@$id>"))
    }

    @Test
    fun thisServersPermalinksOpenInTheApp() {
        val base = "https://chat.example.jp"
        val id = "0b6f6c1e-8f5e-4b8a-9d55-2f4f1c7f3a10"
        assertEquals(TopicInternalLink.Message(id), TopicText.internal(base, "$base/m/$id"))
        assertEquals(TopicInternalLink.Canvas(id), TopicText.internal(base, "$base/c/$id"))
        assertEquals(TopicInternalLink.Page(id), TopicText.internal(base, "$base/p/$id"))
        assertEquals(TopicInternalLink.Event(id), TopicText.internal(base, "$base/e/$id"))
        assertEquals(TopicInternalLink.Drive(id), TopicText.internal(base, "$base/d/$id"))
        assertEquals(TopicInternalLink.Equipment(id), TopicText.internal(base, "$base/eq/$id"))
        // Another server, another path, a mail address, or no server: the system opens it.
        assertNull(TopicText.internal(base, "https://other.example.jp/m/$id"))
        assertNull(TopicText.internal(base, "$base/x/$id"))
        assertNull(TopicText.internal(base, "mailto:a@chat.example.jp"))
        assertNull(TopicText.internal(null, "$base/m/$id"))
    }
}
