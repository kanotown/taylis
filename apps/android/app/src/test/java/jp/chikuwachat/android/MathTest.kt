package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.BodyToken
import jp.chikuwachat.android.ui.MATH_MAX_LENGTH
import jp.chikuwachat.android.ui.parseBlocks
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
 * TeX math (apps/shared/math.json, as the desktop's math.test.ts and the iPhone's MathFixtureTests read it): `$…$` inline
 * and `$$…$$` display, prices, escapes and code left alone; one-line text keeps the source.
 */
class MathTest {
    private fun simple(tokens: List<BodyToken>): JsonArray = JsonArray(
        tokens.map { token ->
            val parts = when (token) {
                is BodyToken.Math -> if (token.display) listOf("math", token.tex, "display") else listOf("math", token.tex)
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

    private fun kind(block: BodyBlock): JsonArray = JsonArray(
        when (block) {
            is BodyBlock.Math -> listOf("math", block.tex)
            is BodyBlock.Heading -> listOf("heading")
            is BodyBlock.Paragraph -> listOf("paragraph")
            is BodyBlock.Quote -> listOf("quote")
            is BodyBlock.ListBlock -> listOf("list")
            is BodyBlock.CodeBlock -> listOf("codeblock")
            is BodyBlock.Table -> listOf("table")
            is BodyBlock.Tasks -> listOf("task")
            is BodyBlock.Image -> listOf("image")
            BodyBlock.Rule -> listOf("hr")
        }.map { JsonPrimitive(it) },
    )

    @Test
    fun theSharedCases() {
        val file = File("../../shared/math.json")
        check(file.isFile) { "apps/shared/math.json not found from ${File("").absolutePath}" }
        val root = Codec.plain.parseToJsonElement(file.readText()).jsonObject
        val inline = root["inline"]!!.jsonArray
        val blocks = root["blocks"]!!.jsonArray
        assertTrue(inline.size > 20)
        assertTrue(blocks.size > 10)
        for (case in inline) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val line = c["line"]!!.jsonPrimitive.content
            assertEquals(name, c["tokens"], simple(tokenizeInline(line)))
            assertEquals("$name (whole body)", c["tokens"], simple(tokenizeBody(line)))
            assertEquals("$name (plain)", c["plain"]!!.jsonPrimitive.content, plainText(line))
        }
        for (case in blocks) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val body = c["body"]!!.jsonPrimitive.content
            assertEquals(name, c["blocks"], JsonArray(parseBlocks(body).map(::kind)))
            assertEquals("$name (canvas)", c["blocks"], JsonArray(parseBlocks(body, canvas = true).map(::kind)))
        }
    }

    @Test
    fun aFormulaOverTheLimitStaysText() {
        val long = "x".repeat(MATH_MAX_LENGTH + 1)
        assertEquals(listOf(BodyToken.Text("$" + long + "$")), tokenizeInline("$" + long + "$"))
        assertEquals(1, parseBlocks("$$" + long + "$$").size)
        assertTrue(parseBlocks("$$" + long + "$$")[0] is BodyBlock.Paragraph)
    }
}
