package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.GeneralReportAck
import jp.chikuwachat.android.ui.Reports
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M119 (MODERATION.md §3.1): 「問題を報告・ご意見」's categories, validation, request body and retry key. */
class ReportsTest {
    @Test fun categoriesStartWithChildSafety() {
        assertEquals(listOf("child_safety", "harassment", "inappropriate", "spam", "feedback", "other"), Reports.categoryCodes)
        assertEquals(Reports.categoryCodes, Reports.categories.map { it.first })
    }

    @Test fun aCategoryAndANonBlankNoteAreRequired() {
        assertEquals(Reports.Problem.NO_CATEGORY, Reports.problem(null, "something"))
        assertEquals(Reports.Problem.NO_CATEGORY, Reports.problem("nonsense", "something"))
        assertEquals(Reports.Problem.EMPTY_NOTE, Reports.problem("spam", ""))
        assertEquals(Reports.Problem.EMPTY_NOTE, Reports.problem("spam", "  \n\t "))
        assertNull(Reports.problem("child_safety", "x"))
        assertNull(Reports.problem("feedback", "a".repeat(Reports.MAX_NOTE)))
        // The limit is on the trimmed note, as the server counts it.
        assertNull(Reports.problem("other", "  " + "a".repeat(Reports.MAX_NOTE) + "  "))
        assertEquals(Reports.Problem.NOTE_TOO_LONG, Reports.problem("other", "a".repeat(Reports.MAX_NOTE + 1)))
    }

    @Test fun bodyTrimsTheNoteAndCarriesTheKey() {
        val general = Reports.body("feedback", "  more dark mode  \n", null, "k-1")
        assertEquals("feedback", general["category"]!!.jsonPrimitive.content)
        assertEquals("more dark mode", general["note"]!!.jsonPrimitive.content)
        assertEquals("k-1", general["client_report_id"]!!.jsonPrimitive.content)
        assertFalse("user_id" in general)

        val person = Reports.body("harassment", "rude", "u-2", "k-2")
        assertEquals("u-2", person["user_id"]!!.jsonPrimitive.content)
        assertEquals(setOf("category", "note", "user_id", "client_report_id"), person.keys)
    }

    @Test fun theRetryKeyIsKeptUntilCleared() {
        var made = 0
        val make = { made += 1; "id-$made" }
        val first = Reports.key(null, make)
        assertEquals("id-1", first)
        // A failure keeps it: the resend uses the same id, so a lost response does not make a second report.
        assertEquals(first, Reports.key(first, make))
        assertEquals(1, made)
        // Cleared on success: the next report gets a new one.
        assertNotEquals(first, Reports.key(null, make))
        // The default makes a uuid.
        assertTrue(Reports.key(null).matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")))
    }

    @Test fun theAckDecodesWithAndWithoutAPerson() {
        val person = Codec.snake.decodeFromString(GeneralReportAck.serializer(), """{"id":"r","category":"spam","user_id":"u","created_at":"2026-10-06T00:00:00Z"}""")
        assertEquals("u", person.userId)
        val general = Codec.snake.decodeFromString(GeneralReportAck.serializer(), """{"id":"r","category":"feedback","user_id":null,"created_at":"2026-10-06T00:00:00Z"}""")
        assertNull(general.userId)
    }
}
