package jp.chikuwachat.android

import jp.chikuwachat.android.ui.SlashCommands
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CommandsTest {
    @Test fun parsesACommandAndItsArguments() {
        assertEquals(SlashCommands.Parsed("status", "🏖 休暇中", true), SlashCommands.parse("/status 🏖 休暇中"))
        assertEquals(SlashCommands.Parsed("leave", "", true), SlashCommands.parse("  /LEAVE "))
        assertEquals(SlashCommands.Parsed("foo", "bar", false), SlashCommands.parse("/foo bar"))
        assertNull(SlashCommands.parse("hello /me"))
        assertNull(SlashCommands.parse("/"))
        assertNull(SlashCommands.parse("/path/to/file"))
        // M30: names in any script (a template's /日報, the built-in /日程).
        assertEquals(SlashCommands.Parsed("日報", "", false), SlashCommands.parse("/日報"))
        assertEquals(SlashCommands.Parsed("日報", "追記", false), SlashCommands.parse("/日報 追記"))
        assertEquals(SlashCommands.Parsed("日程", "ゼミ 10/3 10/4", true), SlashCommands.parse("/日程 ゼミ 10/3 10/4"))
        assertEquals(SlashCommands.Parsed("weekly_2-a", "", false), SlashCommands.parse("/Weekly_2-a"))
    }

    @Test fun suggestsCommandsWhileTheNameIsTyped() {
        assertEquals(14, SlashCommands.candidates("/").size)
        assertEquals(listOf("日程"), SlashCommands.candidates("/日").map { it.name })
        assertEquals("日", SlashCommands.prefix("/日"))
        assertNull(SlashCommands.prefix("/日報 "))
        assertEquals(listOf("status", "shrug"), SlashCommands.candidates("/s").map { it.name })
        assertEquals(emptyList<SlashCommands.Command>(), SlashCommands.candidates("/status "))
        assertEquals(emptyList<SlashCommands.Command>(), SlashCommands.candidates("text /s"))
    }

    @Test fun readsDurationsAndStatusEmoji() {
        val now = ZonedDateTime.of(2026, 9, 27, 10, 0, 0, 0, ZoneId.of("Asia/Tokyo"))
        assertEquals(now.plusMinutes(30), SlashCommands.duration("30m", now))
        assertEquals(now.plusHours(2), SlashCommands.duration("2h", now))
        assertEquals(SlashCommands.tomorrowMorning(now), SlashCommands.duration("tomorrow", now))
        assertEquals(8, SlashCommands.tomorrowMorning(now).hour)
        assertNull(SlashCommands.duration("soon", now))
        assertEquals("🏖" to "休暇中", SlashCommands.splitStatus("🏖 休暇中"))
        assertEquals("☕" to "休憩", SlashCommands.splitStatus(":coffee: 休憩"))
        assertEquals(null to "会議中", SlashCommands.splitStatus("会議中"))
        assertEquals("👩‍💻" to "", SlashCommands.splitStatus("👩‍💻"))
    }
}
