package jp.chikuwachat.android

import jp.chikuwachat.android.ui.NamePill
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * docs/PRESENCE.md §9.2 (the same rule as iOS's `AttendanceRules.nameChipPlacement`): the name keeps its width, the
 * 在室状況 chip goes beside it only whole, else after the @username, cut there down to its minimum before the username is.
 */
class NamePillTest {
    private val gap = 6
    private val min = 80

    private fun place(width: Int, title: Int, subtitle: Int, pill: Int) =
        NamePill.place(width = width, title = title, subtitle = subtitle, pill = pill, pillMin = min, gap = gap)

    @Test
    fun `a pill that fits whole sits beside the name`() {
        assertEquals(NamePill.Placement(secondLine = false, pillWidth = 110, subtitleWidth = 300), place(width = 300, title = 120, subtitle = 70, pill = 110))
        // Exactly the room left.
        assertEquals(NamePill.Placement(secondLine = false, pillWidth = 110, subtitleWidth = 300), place(width = 300, title = 184, subtitle = 70, pill = 110))
    }

    @Test
    fun `a pill that does not fit whole beside the name moves under it - it is never cut on the name's line`() {
        // 300 - 200 - 6 = 94 left beside the name: less than the pill.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 110, subtitleWidth = 70), place(width = 300, title = 200, subtitle = 70, pill = 110))
    }

    @Test
    fun `the name is never cut for the pill`() {
        // User report 2026-11-09: 「オネンネiOS27」 at a larger font; the pill went first, the name was cut to 「オネ…」.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 110, subtitleWidth = 70), place(width = 300, title = 254, subtitle = 70, pill = 110))
        // A name too long for the column takes it all.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 110, subtitleWidth = 90), place(width = 300, title = 300, subtitle = 90, pill = 110))
    }

    @Test
    fun `under the name the pill is cut first, after the whole username`() {
        // 300 - 200 - 6 = 94 left after the username: more than the minimum.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 94, subtitleWidth = 200), place(width = 300, title = 300, subtitle = 200, pill = 110))
    }

    @Test
    fun `the username is cut only when the pill's minimum does not fit after it`() {
        // 300 - 230 - 6 = 64 < 80: the pill keeps 80, the username 300 - 80 - 6 = 214.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 80, subtitleWidth = 214), place(width = 300, title = 300, subtitle = 230, pill = 110))
    }

    @Test
    fun `a short pill keeps its own width`() {
        // 「在室」 (50 px) fits beside the name in the 54 px left.
        assertEquals(NamePill.Placement(secondLine = false, pillWidth = 50, subtitleWidth = 300), place(width = 300, title = 244, subtitle = 70, pill = 50))
        // Under the name it is never widened to the minimum.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 50, subtitleWidth = 244), place(width = 300, title = 300, subtitle = 280, pill = 50))
    }

    @Test
    fun `without a username line the pill starts the second line`() {
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 110, subtitleWidth = 0), place(width = 300, title = 300, subtitle = 0, pill = 110))
    }

    @Test
    fun `a column narrower than the minimum gives the pill all of it`() {
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 60, subtitleWidth = 0), place(width = 60, title = 60, subtitle = 50, pill = 110))
    }
}
