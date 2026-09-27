package jp.chikuwachat.android

import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.BodyListItem
import jp.chikuwachat.android.ui.BodyToken
import jp.chikuwachat.android.ui.parseBlocks
import jp.chikuwachat.android.ui.tokenizeBody
import jp.chikuwachat.android.ui.tokenizeInline
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
        assertEquals(listOf(BodyToken.CodeBlock("print(1)", "py")), tokenizeBody("```py\nprint(1)\n```"))
        assertEquals(listOf(BodyToken.Text("<script>alert(1)</script>")), tokenizeBody("<script>alert(1)</script>"))
        assertEquals(
            listOf(BodyToken.Bold("both"), BodyToken.Text(" "), BodyToken.Strike("gone"), BodyToken.Text(" "), BodyToken.Link("https://example.com/d", "docs"), BodyToken.Text(" 2 * 3")),
            tokenizeInline("**both** ~~gone~~ [docs](https://example.com/d) 2 * 3"),
        )
    }

    @Test fun blocksQuotesListsAndFences() {
        val body = listOf("plan:", "- one **strong**", "- two", "  - nested", "1. first", "2. second", "> quoted _q_", "> more", "```ts", "const x = 1;", "```", "tail").joinToString("\n")
        val blocks = parseBlocks(body)
        assertEquals(6, blocks.size)
        assertEquals(BodyBlock.Paragraph(listOf(listOf(BodyToken.Text("plan:")))), blocks[0])
        assertEquals(
            BodyBlock.ListBlock(false, 1, listOf(
                BodyListItem(0, listOf(BodyToken.Text("one "), BodyToken.Bold("strong"))),
                BodyListItem(0, listOf(BodyToken.Text("two"))),
                BodyListItem(1, listOf(BodyToken.Text("nested"))),
            )),
            blocks[1],
        )
        assertEquals(BodyBlock.ListBlock(true, 1, listOf(BodyListItem(0, listOf(BodyToken.Text("first"))), BodyListItem(0, listOf(BodyToken.Text("second"))))), blocks[2])
        assertEquals(BodyBlock.Quote(listOf(listOf(BodyToken.Text("quoted "), BodyToken.Italic("q")), listOf(BodyToken.Text("more")))), blocks[3])
        assertEquals(BodyBlock.CodeBlock("const x = 1;", "ts"), blocks[4])
        assertEquals(BodyBlock.Paragraph(listOf(listOf(BodyToken.Text("tail")))), blocks[5])
        assertEquals(listOf(BodyBlock.Paragraph(listOf(listOf(BodyToken.Text("```")), listOf(BodyToken.Text("open"))))), parseBlocks("```\nopen"))
        assertEquals(
            listOf(BodyBlock.Heading(1, listOf(BodyToken.Text("Title"))), BodyBlock.Heading(2, listOf(BodyToken.Text("Sub "), BodyToken.Bold("b"))), BodyBlock.Paragraph(listOf(listOf(BodyToken.Text("#### not"))))),
            parseBlocks("# Title\n## Sub **b**\n#### not"),
        )
    }

    @Test fun plainTextForNotifications() {
        assertEquals("今日 太字 と code 引用 docs let x = 1;", jp.chikuwachat.android.ui.plainText("# 今日\n- **太字** と `code`\n> 引用 [docs](https://example.com/d)\n```ts\nlet x = 1;\n```"))
        assertEquals(200, jp.chikuwachat.android.ui.plainText("a".repeat(300)).length)
    }

    @Test fun groupMentionTokens() {
        assertEquals(
            listOf(BodyToken.MentionGroup("00000000-0000-7000-8000-00000000000a"), BodyToken.Text(" and "), BodyToken.Mention("00000000-0000-7000-8000-000000000001")),
            tokenizeBody("<@group:00000000-0000-7000-8000-00000000000a> and <@00000000-0000-7000-8000-000000000001>"),
        )
    }
}
