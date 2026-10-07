package jp.chikuwachat.android

import androidx.compose.ui.text.style.TextOverflow
import jp.chikuwachat.android.ui.FileNameEllipsis
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** A long file name keeps its extension visible; the cases the desktop and iOS share (apps/shared/file-name-ellipsis.json). */
class FileNameEllipsisTest {
    private val cases: List<JsonObject> by lazy {
        val file = File("../../shared/file-name-ellipsis.json")
        check(file.isFile) { "apps/shared/file-name-ellipsis.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }
    }

    private fun JsonObject.text(key: String): String = this[key]!!.jsonPrimitive.content

    @Test fun sharedCases() {
        assertTrue(cases.size > 20)
        cases.forEach { case ->
            val name = case.text("name")
            val input = case.text("input")
            val parts = FileNameEllipsis.split(input)
            assertEquals(name, FileNameEllipsis.Parts(case.text("head"), case.text("tail"), case.text("ext")), parts)
            assertEquals(name, input, parts.head + parts.tail + parts.ext)
        }
    }

    @Test fun overflowIsInTheMiddleOnlyWithAnExtension() {
        assertEquals(TextOverflow.MiddleEllipsis, FileNameEllipsis.overflow("研究報告書_最終版_修正済み_2026年度.pdf"))
        assertEquals(TextOverflow.Ellipsis, FileNameEllipsis.overflow(".env"))
        assertEquals(TextOverflow.Ellipsis, FileNameEllipsis.overflow("README"))
    }
}
