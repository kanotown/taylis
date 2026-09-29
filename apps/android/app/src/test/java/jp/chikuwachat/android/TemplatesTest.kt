package jp.chikuwachat.android

import jp.chikuwachat.android.api.BootstrapOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.TemplateOut
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.Templates
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDate

/** M30 (DATA_MODEL.md message_templates): the shared vectors in apps/shared/templates.json, and the order and lookup. */
class TemplatesTest {
    /** The file the other clients test against: from the module (apps/android/app), ../../shared. */
    private val vectors: JsonObject by lazy {
        val file = File("../../shared/templates.json")
        check(file.isFile) { "apps/shared/templates.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun cases(key: String) = vectors[key]!!.jsonArray.map { it.jsonObject }
    private fun JsonObject.text(key: String) = this[key]!!.jsonPrimitive.content
    private fun JsonObject.today() = LocalDate.parse(text("today"))
    private fun JsonObject.list(key: String) = this[key]!!.jsonArray.map { it.jsonPrimitive.content }

    @Test fun sharedExpandVectors() {
        val all = cases("expand")
        assertTrue(all.isNotEmpty())
        all.forEach { case ->
            assertEquals(case.text("name"), case.text("output"), Templates.expand(case.text("input"), case.today()))
        }
    }

    @Test fun sharedScheduleVectors() {
        val all = cases("schedule")
        assertTrue(all.isNotEmpty())
        all.forEach { case ->
            val poll = Templates.parseSchedule(case.text("args"), case.today())
            assertEquals(case.text("name"), Templates.SchedulePoll(case.text("question"), case.list("options")), poll)
        }
    }

    @Test fun sharedScheduleErrorVectors() {
        val all = cases("schedule_errors")
        assertTrue(all.isNotEmpty())
        all.forEach { case -> assertNull(case.text("name"), Templates.parseSchedule(case.text("args"), case.today())) }
    }

    @Test fun sharedWeekdayVectors() {
        val all = cases("weekdays")
        assertTrue(all.isNotEmpty())
        all.forEach { case -> assertEquals(case.text("name"), case.list("options"), Templates.nextWeekdays(case.today(), 5)) }
    }

    @Test fun scheduleExtras() {
        val today = LocalDate.of(2026, 9, 29)
        // A full-width space separates words too; 〜 between times.
        assertEquals(
            Templates.SchedulePoll("ゼミ", listOf("10/1 (木) 13:00〜14:30", "10/2 (金)")),
            Templates.parseSchedule("ゼミ　10/1 13:00〜14:30 10/2", today),
        )
        assertNull(Templates.parseSchedule("", today))
        assertNull(Templates.parseSchedule("10/1 10/2 10/3 13:00 14:00", today))  // two times in a row
        assertNull(Templates.parseSchedule("10/5-3 10/6", today))  // a range to an earlier day of the month
    }

    private fun template(id: String, name: String, scope: String = "workspace", position: Int = 0, suggestIn: String = "any") =
        TemplateOut(id, scope, if (scope == "user") "me" else null, name, "$name body", suggestIn, position, "2026-09-29T00:00:00Z", "2026-09-29T00:00:00Z")

    @Test fun orderAndLookup() {
        val rows = listOf(
            template("1", "週報", position = 1),
            template("2", "日報", position = 0, suggestIn = "times"),
            template("3", "memo", scope = "user", position = 0),
            template("4", "Agenda", scope = "user", position = 0),
            template("5", "日報", scope = "user", position = 5),
            template("6", "議事録", position = 1),
        )
        assertEquals(listOf("2", "6", "1", "4", "3", "5"), Templates.ordered(rows, inTimes = false).map { it.id })
        assertEquals(listOf("2", "5", "6", "1", "4", "3"), Templates.ordered(rows.map { if (it.id == "5") it.copy(suggestIn = "times") else it }, inTimes = true).map { it.id })
        assertEquals("5", Templates.find(rows, "日報")?.id)  // mine wins
        assertEquals("4", Templates.find(rows, "agenda")?.id)
        assertEquals("1", Templates.find(rows, "週報")?.id)
        assertNull(Templates.find(rows, "nothing"))
        assertEquals(listOf("4"), Templates.candidates(Templates.ordered(rows, false), "ag").map { it.id })
        assertEquals(rows.size, Templates.candidates(rows, "").size)
    }

    @Test fun insertion() {
        val today = LocalDate.of(2026, 9, 28)
        assertEquals("日報 2026/09/28 (月)", Templates.insertCommand("日報 {date}", "", today))
        assertEquals("日報 2026/09/28 (月)\n追記", Templates.insertCommand("日報 {date}", " 追記 ", today))
        assertEquals("日報 月", Templates.insertButton("  ", "日報 {weekday}", today))
        assertEquals("書きかけ\n\n日報 月", Templates.insertButton("書きかけ\n", "日報 {weekday}", today))
        assertEquals("- \n\n日報 月", Templates.insertButton("- ", "日報 {weekday}", today))
    }

    @Test fun bootstrapAndEventKeepTheTemplates() {
        val bootstrap = Codec.snake.decodeFromString(
            BootstrapOut.serializer(),
            """{"server_time":"2026-09-29T00:00:00Z","me":${ME},"users":[],"channels":[],
               "limits":{"max_message_length":20000,"max_attachment_bytes":1,"max_attachments_per_message":10},
               "templates":[{"id":"t1","scope":"workspace","owner_id":null,"name":"日報","body":"{date}","suggest_in":"times","position":0,
                 "created_at":"2026-09-29T00:00:00Z","updated_at":"2026-09-29T00:00:00Z"}]}""",
        )
        val store = Store()
        store.replaceTemplates(bootstrap.templates)
        assertEquals("times", store.templates["t1"]?.suggestIn)
        store.applyTemplate(store.templates["t1"]!!.copy(body = "changed"), deleted = false)
        assertEquals("changed", store.templates["t1"]?.body)
        store.applyTemplate(store.templates["t1"]!!, deleted = true)
        assertTrue(store.templates.isEmpty())
    }

    private companion object {
        const val ME = """{"id":"me","username":"me","display_name":"Me","role":"member","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","must_change_password":false}"""
    }
}
