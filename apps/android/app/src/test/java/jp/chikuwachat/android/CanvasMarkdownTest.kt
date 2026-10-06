package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.CanvasSections
import jp.chikuwachat.android.ui.CanvasText
import jp.chikuwachat.android.ui.parseBlocks
import jp.chikuwachat.android.ui.visibleText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * M46 (CANVAS.md §4.2 / §5 「3 端末で共通にするもの」): the shared cases in apps/shared/canvas_markdown.json — the canvas
 * dialect's blocks, ticking a task line and keeping the caret — as the desktop's canvasMarkdown.test.ts reads them.
 */
class CanvasMarkdownTest {
    private val fixture: JsonObject by lazy {
        val file = File("../../shared/canvas_markdown.json")
        check(file.isFile) { "apps/shared/canvas_markdown.json not found from ${File("").absolutePath}" }
        Codec.plain.parseToJsonElement(file.readText()).jsonObject
    }

    /** A block as the fixture describes it (`text` is what the reader sees of the inline tokens). */
    private fun describe(block: BodyBlock): JsonObject = when (block) {
        is BodyBlock.Heading -> buildJsonObject { put("kind", "heading"); put("level", block.level); put("text", visibleText(block.tokens)) }
        is BodyBlock.Paragraph -> buildJsonObject { put("kind", "paragraph"); put("lines", buildJsonArray { block.lines.forEach { add(kotlinx.serialization.json.JsonPrimitive(visibleText(it))) } }) }
        is BodyBlock.ListBlock -> buildJsonObject {
            put("kind", "list"); put("ordered", block.ordered)
            put("items", buildJsonArray { block.items.forEach { add(kotlinx.serialization.json.JsonPrimitive(visibleText(it.tokens))) } })
        }
        is BodyBlock.Tasks -> buildJsonObject {
            put("kind", "task")
            put("items", buildJsonArray {
                block.items.forEach { item -> add(buildJsonObject { put("level", item.level); put("done", item.done); put("text", visibleText(item.tokens)); put("line", item.line) }) }
            })
        }
        is BodyBlock.Image -> buildJsonObject { put("kind", "image"); put("alt", block.alt); put("attachment_id", block.attachmentId); put("line", block.line) }
        BodyBlock.Rule -> buildJsonObject { put("kind", "hr") }
        is BodyBlock.Math -> buildJsonObject { put("kind", "math"); put("tex", block.tex) }
        is BodyBlock.CodeBlock -> buildJsonObject { put("kind", "codeblock"); put("text", block.text) }
        is BodyBlock.Quote -> buildJsonObject { put("kind", "quote") }
        is BodyBlock.Table -> buildJsonObject { put("kind", "table") }
    }

    @Test
    fun theDialectsBlocksAreTheSharedOnes() {
        val cases = fixture["blocks"]!!.jsonArray
        check(cases.size >= 10)
        for (case in cases.map { it.jsonObject }) {
            val name = case["name"]!!.jsonPrimitive.content
            val canvas = case["canvas"]?.jsonPrimitive?.boolean ?: true
            val got = JsonArray(parseBlocks(case["body"]!!.jsonPrimitive.content, canvas = canvas).map(::describe))
            assertEquals(name, case["blocks"]!!, got)
        }
    }

    @Test
    fun tickingATaskChangesOnlyItsBox() {
        for (case in fixture["toggle"]!!.jsonArray.map { it.jsonObject }) {
            val expected: JsonElement = case["expected"]!!
            val got = CanvasText.toggleTaskLine(case["body"]!!.jsonPrimitive.content, case["line"]!!.jsonPrimitive.int)
            if (expected is JsonNull) assertNull(case.toString(), got) else assertEquals(case.toString(), expected.jsonPrimitive.content, got)
        }
    }

    @Test
    fun theCaretStaysWhereItWasWhenTheBodyIsReplaced() {
        for (case in fixture["caret"]!!.jsonArray.map { it.jsonObject }) {
            val got = CanvasText.preserveCaret(case["before"]!!.jsonPrimitive.content, case["after"]!!.jsonPrimitive.content, case["caret"]!!.jsonPrimitive.int)
            assertEquals(case["name"]!!.jsonPrimitive.content, case["expected"]!!.jsonPrimitive.int, got)
        }
    }

    @Test
    fun tickingWithAnExplicitStateAndMessagesStayUntouched() {
        assertEquals("- [x] a", CanvasText.toggleTaskLine("- [ ] a", 0, done = true))
        assertEquals("- [ ] a", CanvasText.toggleTaskLine("- [ ] a", 0, done = false)) // already so: the same body
        // Messages (canvas = false) keep images and rules as text.
        assertEquals(listOf(BodyBlock.Paragraph::class), parseBlocks("前\n\n---\n\n後").map { it::class })
    }

    @Test
    fun theOutlineListsHeadingsOutsideCodeFences() {
        val body = "# 議事録\n```\n# コード\n```\n## 決定事項 **重要**\n本文\n### TODO"
        assertEquals(
            listOf(CanvasText.OutlineEntry(1, "議事録", 0), CanvasText.OutlineEntry(2, "決定事項 重要", 4), CanvasText.OutlineEntry(3, "TODO", 6)),
            CanvasText.outline(body),
        )
    }

    @Test
    fun toolbarEdits() {
        // Heading: the caret's line becomes one; the same level again makes it text.
        val h = CanvasText.setHeading(CanvasText.Edit("議題\n本文", 1), 2)
        assertEquals("## 議題\n本文", h.text)
        assertEquals("議題\n本文", CanvasText.setHeading(CanvasText.Edit(h.text, 4), 2).text)
        // Checklist: bullets become open boxes; all boxes again become text.
        val t = CanvasText.toggleTasks(CanvasText.Edit("- 資料\n発表", 0, 7))
        assertEquals("- [ ] 資料\n- [ ] 発表", t.text)
        assertEquals("資料\n発表", CanvasText.toggleTasks(CanvasText.Edit(t.text, 0, t.text.length)).text)
        // Bold wraps and unwraps.
        val b = CanvasText.toggleWrap(CanvasText.Edit("重要な点", 0, 2), "**")
        assertEquals("**重要**な点", b.text)
        assertEquals("重要な点", CanvasText.toggleWrap(b, "**").text)
        // Link selects its url; mention adds a space after a word.
        val l = CanvasText.insertLink(CanvasText.Edit("資料", 0, 2))
        assertEquals("[資料](https://)", l.text)
        assertEquals("https://", l.text.substring(l.start, l.end))
        assertEquals("担当 @", CanvasText.insertMention(CanvasText.Edit("担当", 2)).text)
        // A rule between blank lines.
        assertEquals("前\n\n---\n\n後", CanvasText.insertRule(CanvasText.Edit("前\n後", 0)).text)
        // Enter goes on with a checklist, a list and a quote; an empty item ends it.
        assertEquals(CanvasText.Edit("- [x] a\n- [ ] ", 14), CanvasText.continueStructure(CanvasText.Edit("- [x] a", 7)))
        assertEquals(CanvasText.Edit("", 0), CanvasText.continueStructure(CanvasText.Edit("- [ ] ", 6)))
        assertEquals(CanvasText.Edit("1. a\n2. ", 8), CanvasText.continueStructure(CanvasText.Edit("1. a", 4)))
        assertNull(CanvasText.continueStructure(CanvasText.Edit("本文", 2)))
    }

    @Test
    fun mentionsSurviveTheEditorsRoundTripEvenRightAfterJapaneseText() {
        val bob = jp.chikuwachat.android.api.UserPublic(id = "01a0dcff-b3d8-7c1d-9080-c3f4ec737b45", username = "android2", displayName = "Android android2", role = "member", createdAt = "", updatedAt = "")
        val stored = "まとめます。<@${bob.id}> さん\n(<@${bob.id}>) と <!here>\n連絡先 foo@android2.example"
        val shown = jp.chikuwachat.android.ui.Mentions.decode(stored, mapOf(bob.id to bob))
        assertEquals("まとめます。@android2 さん\n(@android2) と @here\n連絡先 foo@android2.example", shown)
        assertEquals(stored, CanvasText.encodeMentions(shown, listOf(bob)))
        assertEquals("@unknown はそのまま", CanvasText.encodeMentions("@unknown はそのまま", listOf(bob)))
    }

    @Test
    fun aSectionIsTheLinesUnderItsHeading() {
        val body = "前文\n# 議事録\n## 出席\nalice\n\n## 決定事項\n- 予算\n```\n# コード\n```\n## 出席\n二度目"
        assertEquals(listOf(1, 2, 5, 10), CanvasSections.headingLines(body))
        val key = CanvasSections.keyAt(body, 2)!!
        assertEquals(CanvasSections.Key("## 出席", 0), key)
        val range = CanvasSections.find(body, key)!!
        assertEquals(3 until 5, range)
        assertEquals("alice\n", CanvasSections.text(body, range))
        assertEquals(CanvasSections.Key("## 出席", 1), CanvasSections.keyAt(body, 10))
        assertEquals("二度目", CanvasSections.text(body, CanvasSections.find(body, CanvasSections.Key("## 出席", 1))!!))
        // A code fence is not a heading: the section runs through it.
        assertEquals("- 予算\n```\n# コード\n```", CanvasSections.text(body, CanvasSections.find(body, CanvasSections.keyAt(body, 5)!!)!!))
        assertNull(CanvasSections.keyAt(body, 3))
        // Put back: only its lines change; an emptied section takes them away; an empty one takes new lines.
        assertEquals(body.replace("alice\n", "alice\nbob\n"), CanvasSections.replace(body, range, "alice\nbob\n"))
        assertEquals(body.replace("alice\n\n", ""), CanvasSections.replace(body, range, ""))
        val bare = "# A\n# B"
        val empty = CanvasSections.find(bare, CanvasSections.Key("# A", 0))!!
        assertEquals("", CanvasSections.text(bare, empty))
        assertEquals("# A\n新しい行\n# B", CanvasSections.replace(bare, empty, "新しい行"))
    }

    @Test
    fun aSectionIsFoundAgainAfterOthersChangedTheBody() {
        val before = "# A\na\n# B\nb"
        val key = CanvasSections.keyAt(before, 2)!!
        // Someone added lines above and a section of the same name further down.
        val after = "# 新\nx\n# A\na\n# B\nb2\n# C"
        assertEquals("b2", CanvasSections.text(after, CanvasSections.find(after, key)!!))
        // Its heading is gone: nothing (the editor closes).
        assertNull(CanvasSections.find("# A\na", key))
    }
}
