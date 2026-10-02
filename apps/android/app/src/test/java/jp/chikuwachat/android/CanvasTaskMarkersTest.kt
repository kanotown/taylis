package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.CanvasMarkers
import jp.chikuwachat.android.ui.CanvasTasks
import jp.chikuwachat.android.ui.CanvasText
import jp.chikuwachat.android.ui.parseBlocks
import jp.chikuwachat.android.ui.revisionKindLabel
import jp.chikuwachat.android.ui.visibleText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * M83 (CANVAS.md §22.7 / §22.9): the shared cases in apps/shared/canvas_task_markers.json — what a reader sees (`strip`),
 * the canvas dialect (`blocks`), the editor's stand-ins (`editor`) and a deletion beside one (`delete`) — as the desktop's
 * canvasTaskMarkers.test.tsx reads them, plus the editor's onValueChange fix against Compose's own deletions.
 */
class CanvasTaskMarkersTest {
    private val fixture: JsonObject by lazy {
        val file = File("../../shared/canvas_task_markers.json")
        check(file.isFile) { "apps/shared/canvas_task_markers.json not found from ${File("").absolutePath}" }
        Codec.plain.parseToJsonElement(file.readText()).jsonObject
    }

    /** The fixture's ⟦n⟧ as the stand-in it stands for (U+E0020 + n). */
    private fun standIns(text: String): String =
        Regex("⟦(\\d+)⟧").replace(text) { String(Character.toChars(0xE0020 + it.groupValues[1].toInt())) }

    /** A text with `|` as the caret: the text and the caret (UTF-16). */
    private fun caretOf(text: String): Pair<String, Int> {
        val real = standIns(text)
        val at = real.indexOf('|')
        return real.removeRange(at, at + 1) to at
    }

    private fun describe(block: BodyBlock): JsonObject = when (block) {
        is BodyBlock.Heading -> buildJsonObject { put("kind", "heading"); put("level", block.level); put("text", visibleText(block.tokens)) }
        is BodyBlock.Paragraph -> buildJsonObject { put("kind", "paragraph"); put("lines", buildJsonArray { block.lines.forEach { add(JsonPrimitive(visibleText(it))) } }) }
        is BodyBlock.ListBlock -> buildJsonObject {
            put("kind", "list"); put("ordered", block.ordered)
            put("items", buildJsonArray { block.items.forEach { add(JsonPrimitive(visibleText(it.tokens))) } })
        }
        is BodyBlock.Tasks -> buildJsonObject {
            put("kind", "task")
            put("items", buildJsonArray {
                block.items.forEach { item -> add(buildJsonObject { put("level", item.level); put("done", item.done); put("text", visibleText(item.tokens)); put("line", item.line) }) }
            })
        }
        else -> buildJsonObject { put("kind", block::class.simpleName ?: "?") }
    }

    @Test
    fun aReaderSeesNoMarkers() {
        val cases = fixture["strip"]!!.jsonArray
        check(cases.size >= 5)
        for (case in cases.map { it.jsonObject }) {
            assertEquals(case.toString(), case["expected"]!!.jsonPrimitive.content, CanvasMarkers.strip(case["text"]!!.jsonPrimitive.content))
        }
    }

    @Test
    fun theDialectLeavesMarkersOut() {
        for (case in fixture["blocks"]!!.jsonArray.map { it.jsonObject }) {
            val got = JsonArray(parseBlocks(case["body"]!!.jsonPrimitive.content, canvas = true).map(::describe))
            assertEquals(case["name"]!!.jsonPrimitive.content, case["blocks"]!!, got)
        }
        // Messages keep showing what was written.
        assertTrue(visibleText((parseBlocks("a <!--task:0190a2b4-0000-7000-8000-000000000001-->")[0] as BodyBlock.Paragraph).lines[0]).contains("<!--task:"))
    }

    @Test
    fun theEditorShowsStandInsAndStoresMarkersAtTheirLinesEnd() {
        for (case in fixture["editor"]!!.jsonArray.map { it.jsonObject }) {
            val name = case["name"]!!.jsonPrimitive.content
            val table = CanvasMarkers.Table()
            val wire = case["wire"]!!.jsonPrimitive.content
            val shown = table.hide(wire)
            assertEquals(name, standIns(case["shown"]!!.jsonPrimitive.content), shown)
            assertFalse(name, shown.contains("<!--task:"))
            assertEquals(name, case["expected"]!!.jsonPrimitive.content, table.show(standIns(case["edited"]!!.jsonPrimitive.content)))
            assertEquals(name, CanvasMarkers.strip(wire), CanvasMarkers.stripStandIns(shown)) // what a copy takes
        }
    }

    @Test
    fun theSameIdKeepsItsStandIn() {
        val table = CanvasMarkers.Table()
        val a = table.hide("x <!--task:0190a2b4-0000-7000-8000-000000000001-->")
        table.hide("y <!--task:0190a2b4-0000-7000-8000-000000000002-->")
        assertEquals(a, table.hide("x <!--task:0190a2b4-0000-7000-8000-000000000001-->"))
        assertEquals(3, a.length) // "x" and one surrogate pair (UTF-16)
    }

    @Test
    fun deletingBesideAStandInKeepsIt() {
        for (case in fixture["delete"]!!.jsonArray.map { it.jsonObject }) {
            val (text, caret) = caretOf(case["text"]!!.jsonPrimitive.content)
            val got = CanvasMarkers.deleteBeside(text, caret, case["backward"]!!.jsonPrimitive.boolean)
            val expected = case["expected"]!!
            if (expected is JsonNull) assertNull(case.toString(), got)
            else assertEquals(case.toString(), caretOf(expected.jsonPrimitive.content), got!!.text to got.caret)
        }
    }

    /**
     * Compose's own Backspace / Delete, as onValueChange sees it: a grapheme goes, and the tag characters extend the
     * character before them (Grapheme_Cluster_Break=Extend; never a line break).
     */
    private fun platformDelete(text: String, caret: Int, backward: Boolean): Pair<String, Int> {
        if (backward) {
            var start = caret
            while (CanvasMarkers.standInAt(text, start - 2)) start -= 2
            if (start > 0 && text[start - 1] != '\n') start -= if (Character.isLowSurrogate(text[start - 1])) 2 else 1
            else if (start == caret && start > 0) start -= 1
            return text.removeRange(start, caret) to start
        }
        if (caret >= text.length) return text to caret
        var end = caret + if (Character.isHighSurrogate(text[caret])) 2 else 1
        if (text[caret] != '\n') while (CanvasMarkers.standInAt(text, end)) end += 2
        return text.removeRange(caret, end) to caret
    }

    @Test
    fun theFieldsOwnDeletionIsRedoneBesideAStandIn() {
        for (case in fixture["delete"]!!.jsonArray.map { it.jsonObject }) {
            val (text, caret) = caretOf(case["text"]!!.jsonPrimitive.content)
            val backward = case["backward"]!!.jsonPrimitive.boolean
            val (after, afterCaret) = platformDelete(text, caret, backward)
            val got = CanvasMarkers.fixDeletion(text, caret, after, afterCaret)
            val expected = case["expected"]!!
            if (expected is JsonNull) assertNull(case.toString(), got)
            else assertEquals(case.toString(), caretOf(expected.jsonPrimitive.content), (got?.text ?: after) to (got?.caret ?: afterCaret))
        }
    }

    @Test
    fun anImeTakingOnlyTheInvisibleCharacterOrHalfOfIt() {
        val (text, caret) = caretOf("- [ ] foo⟦0⟧|")
        val expected = caretOf("- [ ] fo⟦0⟧|")
        val whole = CanvasMarkers.fixDeletion(text, caret, text.dropLast(2), caret - 2)!!
        assertEquals(expected, whole.text to whole.caret)
        val half = CanvasMarkers.fixDeletion(text, caret, text.dropLast(1), caret - 1)!!
        assertEquals(expected, half.text to half.caret)
        // Half of it gone and the caret not where a Backspace leaves it (an IME's own idea of it): still a Backspace.
        val stale = CanvasMarkers.fixDeletion(text, caret, text.dropLast(1), caret)!!
        assertEquals(expected, stale.text to stale.caret)
        val elsewhere = CanvasMarkers.fixDeletion(text, caret, text.dropLast(1), 0)!!
        assertEquals(expected, elsewhere.text to elsewhere.caret)
        // An emoji before the stand-in goes whole (Compose's grapheme), the marker stays.
        val (emoji, at) = caretOf("a👍🏽⟦0⟧|")
        val fixed = CanvasMarkers.fixDeletion(emoji, at, "a", 1)!!
        assertEquals(caretOf("a⟦0⟧|"), fixed.text to fixed.caret)
        // Typing and deletions away from stand-ins are the field's own.
        assertNull(CanvasMarkers.fixDeletion(text, caret, "$text!", caret + 1))
        assertNull(CanvasMarkers.fixDeletion("ab⟦0⟧".let(::standIns), 1, "b⟦0⟧".let(::standIns), 0))
    }

    @Test
    fun aTaskFromAnItemHasNoMarkerButItsLineIsKept() {
        val line = "- [ ] 資料を集める <!--task:0190a2b4-0000-7000-8000-000000000001-->"
        val init = CanvasTasks.taskInit("c1", "# x\n$line", 1, null, emptyMap(), emptyMap(), isAdmin = false)!!
        assertEquals("資料を集める", init.title)
        assertEquals("資料を集める", init.sourceCanvasExcerpt)
        assertEquals(line, init.sourceCanvasLine)
    }

    @Test
    fun theHistoryNamesTheKindAndTheOutlineHasNoMarker() {
        assertEquals("タスクと連動", revisionKindLabel("task"))
        val table = CanvasMarkers.Table()
        val shown = table.hide("## 見出し <!--task:0190a2b4-0000-7000-8000-000000000001-->")
        assertEquals("見出し", CanvasText.outline(shown).single().text)
        assertEquals("見出し", CanvasText.outline("## 見出し <!--task:0190a2b4-0000-7000-8000-000000000001-->").single().text)
    }
}
