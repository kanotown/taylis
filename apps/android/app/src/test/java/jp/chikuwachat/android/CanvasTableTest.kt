package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.CanvasTable
import jp.chikuwachat.android.ui.CanvasTable.Align
import jp.chikuwachat.android.ui.CanvasTable.Range
import jp.chikuwachat.android.ui.CanvasTable.Table
import jp.chikuwachat.android.ui.CanvasTable.WriteBack
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * M57 (CANVAS.md §17): every case in apps/shared/canvas_table.json (parse, serialize, round trip, find, insert, ops), as
 * the desktop's and iOS's tests read them; then Android's write-back and cancel against a body that changed meanwhile.
 */
class CanvasTableTest {
    private val fixture: JsonObject by lazy {
        val file = File("../../shared/canvas_table.json")
        check(file.isFile) { "apps/shared/canvas_table.json not found from ${File("").absolutePath}" }
        Codec.plain.parseToJsonElement(file.readText()).jsonObject
    }

    private fun strings(e: JsonElement): List<String> = e.jsonArray.map { it.jsonPrimitive.content }

    private fun table(e: JsonElement): Table {
        val o = e.jsonObject
        return Table(
            align = o["align"]!!.jsonArray.map { a -> if (a is JsonNull) null else Align.entries.single { it.wire == a.jsonPrimitive.content } },
            header = strings(o["header"]!!),
            rows = o["rows"]!!.jsonArray.map { strings(it) },
        )
    }

    private fun range(e: JsonElement?): Range? = if (e == null || e is JsonNull) null else e.jsonArray.let { Range(it[0].jsonPrimitive.int, it[1].jsonPrimitive.int) }

    @Test
    fun parsesTheSharedCases() {
        val cases = fixture["parse"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val lines = strings(case.jsonObject["lines"]!!)
            assertEquals(lines.toString(), table(case.jsonObject["table"]!!), CanvasTable.parse(lines))
        }
    }

    @Test
    fun serializesTheSharedCases() {
        val cases = fixture["serialize"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            assertEquals(strings(case.jsonObject["lines"]!!), CanvasTable.serialize(table(case.jsonObject["table"]!!)))
        }
    }

    @Test
    fun roundTripsTheSharedCases() {
        for (case in fixture["round_trip"]!!.jsonArray) {
            val lines = strings(case.jsonObject["lines"]!!)
            assertEquals(lines.toString(), strings(case.jsonObject["lines_out"]!!), CanvasTable.serialize(CanvasTable.parse(lines)))
        }
    }

    @Test
    fun findsTheTableAtTheCaret() {
        val find = fixture["find"]!!.jsonObject
        val text = find["text"]!!.jsonPrimitive.content
        for (case in find["cases"]!!.jsonArray) {
            val caret = case.jsonObject["caret_line"]!!.jsonPrimitive.int
            assertEquals("caret line $caret", range(case.jsonObject["range"]), CanvasTable.findTable(text, caret))
        }
    }

    @Test
    fun insertsANewTable() {
        // Each case is {"text": input, "caret_line", "text_out": output, "range"}.
        val cases = fixture["insert"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val o = case.jsonObject
            val caret = o["caret_line"]!!.jsonPrimitive.int
            val text = o["text"]!!.jsonPrimitive.content
            val expected = o["text_out"]!!.jsonPrimitive.content
            val result = CanvasTable.insertTable(text, caret)
            assertEquals(text, expected, result.text)
            assertEquals(text, range(o["range"]), result.range)
            // The editor's 「完了」 on an untouched new table puts in exactly that.
            val session = CanvasTable.openNew(text, caret)
            assertEquals(text, WriteBack.Replaced(expected, range(o["range"])!!), CanvasTable.writeBack(text, session, session.table))
        }
    }

    @Test
    fun appliesTheSharedOps() {
        val ops = fixture["ops"]!!.jsonObject
        val base = table(ops["base"]!!)
        for (case in ops["cases"]!!.jsonArray) {
            val o = case.jsonObject
            val start = o["base"]?.let { table(it) } ?: base
            val args = o["args"]!!.jsonArray
            fun int(i: Int) = args[i].jsonPrimitive.int
            val name = o["op"]!!.jsonPrimitive.content
            val result = when (name) {
                "add_row" -> CanvasTable.addRow(start, int(0))
                "delete_row" -> CanvasTable.deleteRow(start, int(0))
                "move_row" -> CanvasTable.moveRow(start, int(0), int(1))
                "add_column" -> CanvasTable.addColumn(start, int(0))
                "delete_column" -> CanvasTable.deleteColumn(start, int(0))
                "set_align" -> CanvasTable.setAlign(start, int(0), args[1].let { a -> if (a is JsonNull) null else Align.entries.single { it.wire == a.jsonPrimitive.content } })
                else -> error("unknown op $name")
            }
            assertEquals("$name $args", table(o["table"]!!), result)
        }
        assertTrue((ops["cases"] as JsonArray).size >= 9)
    }

    // --- Android's write-back -----------------------------------------------------------------------------------

    private val body = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n本文"

    @Test
    fun opensTheTableAtTheCaretAndWritesItBack() {
        val session = CanvasTable.open(body, 3)!!
        assertEquals(Range(2, 4), session.at)
        assertEquals(WriteBack.Unchanged, CanvasTable.writeBack(body, session, session.table))
        val edited = CanvasTable.setCell(CanvasTable.addRow(session.table, 1), 1, 0, "旅費")
        val result = CanvasTable.writeBack(body, session, edited) as WriteBack.Replaced
        assertEquals("# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n| 旅費 |  |\n\n本文", result.text)
        assertEquals(Range(2, 5), result.range)
        assertNull(CanvasTable.open(body, 0))
    }

    @Test
    fun findsTheTableAgainAfterLinesAboveItChanged() {
        val session = CanvasTable.open(body, 2)!!
        val edited = CanvasTable.setHeader(session.table, 1, "期限")
        val now = "前置き\n\n" + body
        val result = CanvasTable.writeBack(now, session, edited) as WriteBack.Replaced
        assertEquals("前置き\n\n# 学会\n\n| 名前 | 期限 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n本文", result.text)
        assertEquals(Range(4, 6), result.range)
    }

    @Test
    fun aTableChangedMeanwhileIsNotOverwritten() {
        val session = CanvasTable.open(body, 2)!!
        val edited = CanvasTable.setCell(session.table, 0, 1, "10/5")
        // Someone else added a row to the same table while the editor was open.
        val now = body.replace("| 予稿 | 10/3 |", "| 予稿 | 10/3 |\n| 旅費 | 10/10 |")
        val result = CanvasTable.writeBack(now, session, edited) as WriteBack.Added
        assertEquals(
            "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n| 旅費 | 10/10 |\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/5 |\n\n本文",
            result.text,
        )
        assertEquals(Range(7, 9), result.range)
        // Removed altogether: it goes in where it was.
        val gone = "# 学会\n\n本文"
        val added = CanvasTable.writeBack(gone, session, edited) as WriteBack.Added
        assertEquals("# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/5 |\n\n本文", added.text)
    }

    @Test
    fun aNewTableGoesInOnlyAtDoneAfterItsLine() {
        val session = CanvasTable.openNew("一行目\n二行目", 0)
        assertTrue(session.isNew)
        val edited = CanvasTable.setCell(session.table, 0, 0, "a")
        val block = "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| a |  |  |\n|  |  |  |"
        // Lines added above meanwhile: it still goes after 「一行目」.
        val result = CanvasTable.writeBack("前\n一行目\n二行目", session, edited) as WriteBack.Replaced
        assertEquals("前\n一行目\n\n$block\n\n二行目", result.text)
        assertEquals(Range(3, 6), result.range)
        // Its line gone: the same line number.
        val moved = CanvasTable.writeBack("別\n二行目", session, edited) as WriteBack.Replaced
        assertEquals("別\n\n$block\n\n二行目", moved.text)
        // That place is now inside a table: after the table, not splitting it.
        val inTable = CanvasTable.writeBack("| x |\n| --- |\n| 1 |", CanvasTable.openNew("あ\nい", 0), edited) as WriteBack.Replaced
        assertEquals("| x |\n| --- |\n| 1 |\n\n$block", inTable.text)
    }

    @Test
    fun linesAndOffsets() {
        val text = "ab\ncd\n\nef"
        assertEquals(0, CanvasTable.lineOf(text, 0))
        assertEquals(1, CanvasTable.lineOf(text, 3))
        assertEquals(3, CanvasTable.lineOf(text, text.length))
        assertEquals(2, CanvasTable.endOfLine(text, 0))
        assertEquals(5, CanvasTable.endOfLine(text, 1))
        assertEquals(6, CanvasTable.endOfLine(text, 2))
        assertEquals(text.length, CanvasTable.endOfLine(text, 3))
    }

    @Test
    fun separatorsAsTheReferenceReadsThem() {
        for (yes in listOf("| --- | --- |", "|:--|:-:|--:|", "--- | ---", "| --- |", "---", "  | :---: |  ")) assertTrue(yes, CanvasTable.isSeparator(yes))
        for (no in listOf("|", "| |", "| --- | |", "||---", "---||", "| -- - |", "| a |", "")) assertTrue(no, !CanvasTable.isSeparator(no))
    }
}
