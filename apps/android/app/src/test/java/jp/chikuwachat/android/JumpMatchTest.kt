package jp.chikuwachat.android

import jp.chikuwachat.android.ui.JumpMatch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** M37 (MOBILE_UI.md §6.2): the jump screen's matching rule against apps/shared/jump-match.json (the other clients' too). */
class JumpMatchTest {
    /** The file the other clients test against: from the module (apps/android/app), ../../shared. */
    private val vectors: JsonObject by lazy {
        val file = File("../../shared/jump-match.json")
        check(file.isFile) { "apps/shared/jump-match.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.text(key: String) = this[key]!!.jsonPrimitive.content
    private fun JsonObject.list(key: String) = this[key]!!.jsonArray.map { it.jsonPrimitive.content }

    @Test fun sharedNormalizeVectors() {
        val cases = vectors["normalize"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case -> assertEquals(case.text("input"), case.text("output"), JumpMatch.normalize(case.text("input"))) }
    }

    @Test fun sharedScoreVectors() {
        val cases = vectors["score"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val expected = case["score"].let { if (it == null || it is JsonNull) null else it.jsonPrimitive.int }
            assertEquals("${case.text("query")} in ${case.list("names")}", expected, JumpMatch.score(case.text("query"), case.list("names")))
        }
    }

    @Test fun sharedRankVectors() {
        val rank = vectors["rank"]!!.jsonObject
        val items = rank["items"]!!.jsonArray.map { it.jsonObject }.map { item ->
            JumpMatch.Item(item.text("id"), item.text("title"), item.list("names"), unread = item["unread"]?.jsonPrimitive?.booleanOrNull ?: false)
        }
        val cases = rank["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            assertEquals(case.text("query"), case.list("ids"), JumpMatch.rank(case.text("query"), items) { it }.map { it.id })
        }
    }
}
