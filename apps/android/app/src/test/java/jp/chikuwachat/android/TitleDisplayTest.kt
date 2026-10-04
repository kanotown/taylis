package jp.chikuwachat.android

import jp.chikuwachat.android.api.LabProfileOut
import jp.chikuwachat.android.ui.Roster
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * LAB.md 「肩書と名簿」: the roster label is shown as the title, once; the cases the desktop and iOS share
 * (apps/shared/title-display.json).
 */
class TitleDisplayTest {
    private val cases: List<JsonObject> by lazy {
        val file = File("../../shared/title-display.json")
        check(file.isFile) { "apps/shared/title-display.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }
    }

    private fun JsonObject.text(key: String): String? = this[key]?.let { if (it is JsonNull) null else it.jsonPrimitive.content }

    @Test fun sharedCases() {
        assertTrue(cases.size > 10)
        cases.forEach { case ->
            val name = case.text("name")
            val line = (case["roster"] as? JsonObject)?.let {
                LabProfileOut(userId = "u", affiliation = it.text("affiliation")!!, rank = it.text("rank"), grade = it.text("grade"), updatedAt = "")
            }
            assertEquals(name, case.text("display"), Roster.displayTitle(case.text("title"), line))
            assertEquals(name, case.text("extra"), Roster.titleExtra(case.text("title"), line))
        }
    }
}
