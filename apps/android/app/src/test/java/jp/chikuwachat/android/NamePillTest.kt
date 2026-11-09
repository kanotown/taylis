package jp.chikuwachat.android

import jp.chikuwachat.android.ui.NamePill
import org.junit.Assert.assertEquals
import org.junit.Test

/** docs/PRESENCE.md §9.2: the name keeps its width, the 在室状況 chip gives way (cut, then under the name). */
class NamePillTest {
    private val gap = 6
    private val min = 80
    private val least = 36

    private fun place(width: Int, title: Int, subtitle: Int, pill: Int) =
        NamePill.place(width = width, title = title, subtitle = subtitle, pill = pill, pillMin = min, pillLeast = least, gap = gap)

    @Test
    fun `a pill that fits sits beside the name at its own width`() {
        assertEquals(NamePill.Placement(secondLine = false, pillWidth = 110, subtitleWidth = 300), place(width = 300, title = 120, subtitle = 70, pill = 110))
    }

    @Test
    fun `a pill that does not fit is cut beside the name while its minimum fits`() {
        // 300 - 200 - 6 = 94 left: more than the minimum, less than the pill.
        assertEquals(NamePill.Placement(secondLine = false, pillWidth = 94, subtitleWidth = 300), place(width = 300, title = 200, subtitle = 70, pill = 110))
    }

    @Test
    fun `the name is never cut for the pill - the pill moves under it beside the username`() {
        // User report 2026-11-09: 「オネンネiOS27」 at a larger font left 40 px; the pill went first, the name was cut to 「オネ…」.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 110, subtitleWidth = 70), place(width = 300, title = 254, subtitle = 70, pill = 110))
    }

    @Test
    fun `a name too long for the column takes it all and the pill goes under it`() {
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 110, subtitleWidth = 90), place(width = 300, title = 300, subtitle = 90, pill = 110))
    }

    @Test
    fun `under the name the pill gives way to the username too, down to its icon`() {
        // 300 - 230 - 6 = 64 left: below the 4-character minimum, the pill is cut there rather than the username.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 64, subtitleWidth = 230), place(width = 300, title = 300, subtitle = 230, pill = 110))
    }

    @Test
    fun `a username that would leave not even the icon is cut for it`() {
        // The username keeps 300 - 6 - 36 = 258; the pill its icon.
        assertEquals(NamePill.Placement(secondLine = true, pillWidth = 36, subtitleWidth = 258), place(width = 300, title = 300, subtitle = 280, pill = 110))
    }

    @Test
    fun `a short pill needs only its own width beside the name`() {
        // 「在室」 (50 px) fits in the 54 px left although the minimum is 80.
        assertEquals(NamePill.Placement(secondLine = false, pillWidth = 50, subtitleWidth = 300), place(width = 300, title = 240, subtitle = 70, pill = 50))
    }

    @Test
    fun `a column narrower than the pill's icon still shows what fits under the name`() {
        val placement = place(width = 30, title = 30, subtitle = 50, pill = 110)
        assertEquals(true, placement.secondLine)
        assertEquals(0, placement.subtitleWidth)
        assertEquals(24, placement.pillWidth)
    }
}
