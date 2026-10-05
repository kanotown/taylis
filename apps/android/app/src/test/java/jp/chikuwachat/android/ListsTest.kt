package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.parseBlocks
import jp.chikuwachat.android.ui.tokenizeBody
import jp.chikuwachat.android.ui.BodyToken
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
 * 2026-10-06: list levels, numbers and markers (apps/shared/lists.json, as the desktop's lists.test.tsx and iOS's
 * ListsFixtureTests read it): nested numbers are 1. a. i., each nested list counts from its own start. And code blocks
 * show curled quotes straight (apps/shared/inline-format.json `code_blocks`).
 */
class ListsTest {
    private fun kind(block: BodyBlock): String = when (block) {
        is BodyBlock.Heading -> "heading"
        is BodyBlock.Paragraph -> "paragraph"
        is BodyBlock.Quote -> "quote"
        is BodyBlock.ListBlock -> "list"
        is BodyBlock.CodeBlock -> "codeblock"
        is BodyBlock.Table -> "table"
        is BodyBlock.Tasks -> "task"
        is BodyBlock.Image -> "image"
        BodyBlock.Rule -> "hr"
    }

    @Test
    fun theSharedCases() {
        val file = File("../../shared/lists.json")
        check(file.isFile) { "apps/shared/lists.json not found from ${File("").absolutePath}" }
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.size > 20)
        for (case in cases) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val blocks = parseBlocks(c["body"]!!.jsonPrimitive.content)
            assertEquals(name, c["blocks"], JsonArray(blocks.map { JsonPrimitive(kind(it)) }))
            val lists = JsonArray(
                blocks.filterIsInstance<BodyBlock.ListBlock>().map { list ->
                    JsonArray(list.items.map { JsonArray(listOf(JsonPrimitive(it.level), JsonPrimitive(it.marker), JsonPrimitive(visibleText(it.tokens)))) })
                },
            )
            assertEquals(name, c["lists"], lists)
        }
    }

    @Test
    fun theSharedCodeBlocks() {
        val file = File("../../shared/inline-format.json")
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["code_blocks"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val body = c["body"]!!.jsonPrimitive.content
            val expected = c["text"]!!.jsonPrimitive.content
            assertEquals(name, expected, parseBlocks(body).filterIsInstance<BodyBlock.CodeBlock>().first().text)
            assertEquals("$name (whole body)", expected, tokenizeBody(body).filterIsInstance<BodyToken.CodeBlock>().first().text)
        }
    }
}
