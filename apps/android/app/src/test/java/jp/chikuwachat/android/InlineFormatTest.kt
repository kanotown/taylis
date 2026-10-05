package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.BodyToken
import jp.chikuwachat.android.ui.plainText
import jp.chikuwachat.android.ui.tokenizeBody
import jp.chikuwachat.android.ui.tokenizeInline
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
}
