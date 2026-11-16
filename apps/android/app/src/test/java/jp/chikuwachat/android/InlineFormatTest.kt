package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.BodyToken
import jp.chikuwachat.android.ui.TopicText
import jp.chikuwachat.android.ui.TopicToken
import jp.chikuwachat.android.ui.emphasisPieces
import jp.chikuwachat.android.ui.plainText
import jp.chikuwachat.android.ui.tokenizeBody
import jp.chikuwachat.android.ui.tokenizeInline
import jp.chikuwachat.android.ui.visibleText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * M107: inline markup — `_` emphasis never inside a word, URLs and e-mail addresses never read for emphasis, backslash
 * escapes — against the cases every client and the server share (apps/shared/inline-format.json).
 */
class InlineFormatTest {
    private fun simple(tokens: List<BodyToken>): JsonArray = JsonArray(
        tokens.map { token ->
            val parts = when (token) {
                is BodyToken.Text -> listOf("text", token.text)
                is BodyToken.Bold -> listOf("bold", token.text)
                is BodyToken.Italic -> listOf("italic", token.text)
                is BodyToken.Strike -> listOf("strike", token.text)
                is BodyToken.Code -> listOf("code", token.text)
                is BodyToken.CodeBlock -> listOf("codeblock", token.text)
                is BodyToken.Link -> if (token.label != null) listOf("link", token.url, token.label) else listOf("link", token.url)
                is BodyToken.Mention -> listOf("mention", token.userId)
                is BodyToken.MentionGroup -> listOf("mention_group", token.groupId)
                is BodyToken.MentionAll -> listOf("mention_all", token.target)
                is BodyToken.Math -> if (token.display) listOf("math", token.tex, "display") else listOf("math", token.tex)
                BodyToken.Newline -> listOf("newline")
            }
            JsonArray(parts.map { JsonPrimitive(it) })
        },
    )

    @Test
    fun theSharedCases() {
        val file = File("../../shared/inline-format.json")
        check(file.isFile) { "apps/shared/inline-format.json not found from ${File("").absolutePath}" }
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.size > 20)
        for (case in cases) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val line = c["line"]!!.jsonPrimitive.content
            assertEquals(name, c["tokens"], simple(tokenizeInline(line)))
            assertEquals("$name (whole body)", c["tokens"], simple(tokenizeBody(line)))
            assertEquals("$name (plain)", c["plain"]!!.jsonPrimitive.content, plainText(line))
        }
    }

    /** M188: a mention inside bold, italic or strike is a piece of its own, drawn as the mention. */
    @Test
    fun theSharedEmphasisMentions() {
        val file = File("../../shared/inline-format.json")
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["emphasis_mentions"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val c = case.jsonObject
            assertEquals(c["name"]!!.jsonPrimitive.content, c["pieces"], simple(emphasisPieces(c["text"]!!.jsonPrimitive.content)))
        }
        // The outline's text and a channel topic name them too.
        val id = "01a0f811-c836-755b-925c-0d71f4c5cd22"
        assertEquals("確認 @ さん", visibleText(tokenizeInline("**確認 <@$id> さん**")))
        assertEquals(listOf(TopicToken.Bold("確認 @山田 太郎")), TopicText.tokens("**確認 <@$id>**") { "山田 太郎" })
    }

    /**
     * 2026-11-16 (a hostile-server review): the italic rule runs in linear time. Each shared `timing` body tokenizes (as a
     * line, as a whole body and as a notification's plain text) within its `max_ms`; `_a ` repeated took seconds before.
     */
    @Test
    fun theSharedTimings() {
        val file = File("../../shared/inline-format.json")
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["timing"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        // Class loading and the patterns' compilation are not what is measured.
        tokenizeBody("_a_ **b** `c`")
        plainText("_a_ **b** `c`")
        for (case in cases) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val body = c["unit"]!!.jsonPrimitive.content.repeat(c["repeat"]!!.jsonPrimitive.content.toInt())
            val maxMs = c["max_ms"]!!.jsonPrimitive.content.toLong()
            for ((what, run) in listOf<Pair<String, () -> Unit>>(
                "line" to { tokenizeInline(body) },
                "body" to { tokenizeBody(body) },
                "plain" to { plainText(body) },
            )) {
                val started = System.nanoTime()
                run()
                val ms = (System.nanoTime() - started) / 1_000_000
                assertTrue("$name ($what): $ms ms > $maxMs ms", ms <= maxMs)
            }
        }
    }
}
