package jp.chikuwachat.android

import jp.chikuwachat.android.ui.BodyToken
import jp.chikuwachat.android.ui.tokenizeBody
import org.junit.Assert.assertEquals
import org.junit.Test

class BodyTokenizerTest {
    @Test fun inlineSubsetMentionsLinksAndNewlines() {
        val body = "hi *bold* and _it_ `code` <@00000000-0000-7000-8000-000000000001> <!channel>\nhttps://example.com/x?y=1 done"
        assertEquals(listOf(
            BodyToken.Text("hi "), BodyToken.Bold("bold"), BodyToken.Text(" and "), BodyToken.Italic("it"), BodyToken.Text(" "),
            BodyToken.Code("code"), BodyToken.Text(" "), BodyToken.Mention("00000000-0000-7000-8000-000000000001"), BodyToken.Text(" "),
            BodyToken.MentionAll("channel"), BodyToken.Newline, BodyToken.Link("https://example.com/x?y=1"), BodyToken.Text(" done"),
        ), tokenizeBody(body))
    }

    @Test fun codeBlocksAndUnmatchedMarkers() {
        assertEquals(listOf(BodyToken.CodeBlock("let *x* = 1")), tokenizeBody("```\nlet *x* = 1\n```"))
        assertEquals(listOf(BodyToken.Text("<script>alert(1)</script>")), tokenizeBody("<script>alert(1)</script>"))
    }
}
