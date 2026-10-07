package jp.chikuwachat.android

import java.io.File
import jp.chikuwachat.android.api.AttendanceBoardOut
import jp.chikuwachat.android.api.AttendanceEntryOut
import jp.chikuwachat.android.api.AttendanceStateOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.AttendanceIcons
import jp.chikuwachat.android.ui.AttendanceIcons.Glyph
import jp.chikuwachat.android.ui.AttendanceRules
import jp.chikuwachat.android.ui.AttendanceRules.ChipMode
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M140 (docs/PRESENCE.md §2.1, §9.1): the states' icons and the quick switch on Android — the catalogue against
 * apps/shared/attendance-icons.json, the icon / emoji fallback, when the chip shows, how it fits, and the sheet's presses.
 */
class AttendanceIconsTest {
    private val shared = run {
        val file = File("../../shared/attendance-icons.json")
        check(file.isFile) { "apps/shared/attendance-icons.json not found from ${File("").absolutePath}" }
        Codec.snake.parseToJsonElement(file.readText()).jsonObject
    }
    private val sharedIcons = shared.getValue("icons").jsonArray.map { it.jsonObject }

    @Test fun catalogueMatchesTheSharedFile() {
        assertEquals(sharedIcons.map { it.getValue("key").jsonPrimitive.content }, AttendanceIcons.CATALOGUE.map { it.key })
        assertEquals(sharedIcons.map { it.getValue("material").jsonPrimitive.content }, AttendanceIcons.CATALOGUE.map { it.material })
        // The vector drawn is Icons.Outlined.<material> itself (its name is "Outlined.<Name>").
        AttendanceIcons.CATALOGUE.forEach { assertEquals(it.key, "Outlined.${it.material}", it.vector.name) }
        val defaults = shared.getValue("defaults").jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(defaults, AttendanceIcons.DEFAULT_OF_KIND)
        assertEquals(AttendanceRules.KINDS.toSet(), AttendanceIcons.DEFAULT_OF_KIND.keys)
    }

    @Test fun labelsMatchTheSharedFileInEveryLanguage() {
        mapOf("ja" to "values", "en" to "values-en", "zh-Hans" to "values-b+zh+Hans").forEach { (lang, dir) ->
            val strings = XmlStrings.load(dir).strings
            sharedIcons.forEach { icon ->
                val key = icon.getValue("key").jsonPrimitive.content
                val expected = icon.getValue("label").jsonObject.getValue(lang).jsonPrimitive.content
                assertEquals("$lang $key", expected, strings["attendance_icon_$key"])
            }
        }
        // The resource each entry points at is the one named after its key (the default resolver reads values/).
        AttendanceIcons.CATALOGUE.forEach { entry ->
            assertEquals(sharedIcons.first { it.getValue("key").jsonPrimitive.content == entry.key }.getValue("label").jsonObject.getValue("ja").jsonPrimitive.content, AttendanceIcons.label(entry.key))
        }
    }

    @Test fun iconElseEmojiElseNothing() {
        assertEquals(Glyph.Icon("meeting"), AttendanceIcons.glyph("meeting", "🗣️"))
        assertEquals(Glyph.Icon("in_room"), AttendanceIcons.glyph("in_room", null))
        // A key this app does not know (added later): the emoji stands in.
        assertEquals(Glyph.Emoji("🗣️"), AttendanceIcons.glyph("hologram", "🗣️"))
        assertEquals(Glyph.Emoji(":party:"), AttendanceIcons.glyph(null, ":party:"))
        assertEquals(Glyph.None, AttendanceIcons.glyph("hologram", null))
        assertEquals(Glyph.None, AttendanceIcons.glyph(null, "  "))
        assertNull(AttendanceIcons.vector("hologram"))
        assertNull(AttendanceIcons.vector(null))
    }

    @Test fun plainTextShowsTheEmojiOnlyWithoutAnIcon() {
        assertEquals("在室", AttendanceRules.stateText(state("s", icon = "in_room", emoji = "🟢")))
        assertEquals("🟢 在室", AttendanceRules.stateText(state("s", icon = "hologram", emoji = "🟢")))
        assertEquals("🟢 在室", AttendanceRules.stateText(state("s", icon = null, emoji = "🟢")))
        assertEquals("在室", AttendanceRules.stateText(state("s")))
    }

    @Test fun decodesTheIcon() {
        val json = """{"id": "s1", "owner_id": null, "label": "学外", "icon": "off_site", "emoji": "🚶", "color": "purple", "kind": "off_site", "position": 2, "archived": false}"""
        assertEquals("off_site", Codec.snake.decodeFromString(AttendanceStateOut.serializer(), json).icon)
        // A server before migration 0101 sends none.
        val old = """{"id": "s1", "label": "学外", "color": "purple", "kind": "off_site"}"""
        assertNull(Codec.snake.decodeFromString(AttendanceStateOut.serializer(), old).icon)
    }

    @Test fun aNewStatesIconFollowsItsKindUntilPicked() {
        assertEquals("off_site", AttendanceRules.formIcon(picked = null, pickedYet = false, kind = "off_site"))
        assertEquals("gone", AttendanceRules.formIcon(picked = null, pickedYet = false, kind = "gone"))
        assertEquals("lab", AttendanceRules.formIcon(picked = "lab", pickedYet = true, kind = "gone"))
        // 「なし」 picked stays none.
        assertNull(AttendanceRules.formIcon(picked = null, pickedYet = true, kind = "in_room"))
    }

    // --- the quick switch ------------------------------------------------------------------------

    private fun state(id: String, label: String = "在室", icon: String? = null, emoji: String? = null, owner: String? = null, kind: String = "in_room") =
        AttendanceStateOut(id = id, ownerId = owner, label = label, icon = icon, emoji = emoji, color = "purple", kind = kind)

    private val board = AttendanceBoardOut(
        enabled = true,
        states = listOf(
            state("room", "在室", icon = "in_room"),
            state("out", "学外", icon = "off_site", kind = "off_site"),
            state("mine", "実験", icon = "lab", owner = "me", kind = "on_site"),
        ),
        entries = listOf(AttendanceEntryOut(userId = "me", stateId = "out", since = "2026-10-07T00:15:00Z", note = "15 時に戻ります")),
    )

    @Test fun theChipShowsOnlyWhileOnAndNotForGuests() {
        assertTrue(AttendanceRules.quickSwitchShown(board, "member", "me"))
        assertTrue(AttendanceRules.quickSwitchShown(board, "admin", "me"))
        assertFalse(AttendanceRules.quickSwitchShown(board, "guest", "me"))
        assertFalse(AttendanceRules.quickSwitchShown(board.copy(enabled = false), "member", "me"))
        assertFalse(AttendanceRules.quickSwitchShown(null, "member", "me"))
        assertFalse(AttendanceRules.quickSwitchShown(board, "member", null))
    }

    @Test fun theChipSaysMyState() {
        assertEquals("学外", AttendanceRules.myState(board, "me")?.label)
        assertNull(AttendanceRules.myState(board, "someone"))
        assertNull(AttendanceRules.myState(null, "me"))
        assertEquals("在室状況：学外", AttendanceRules.chipLabel(AttendanceRules.myState(board, "me")))
        assertEquals("在室状況", AttendanceRules.chipLabel(null))
        assertEquals("学外", AttendanceRules.chipText("学外"))
        assertEquals("12345678", AttendanceRules.chipText("12345678"))
        assertEquals("1234567…", AttendanceRules.chipText("123456789"))
        // Code points, not UTF-16 units: an emoji is not cut in half.
        assertEquals("😀😀😀😀😀😀😀…", AttendanceRules.chipText("😀".repeat(9)))
    }

    @Test fun theChipGivesWayIconFirstThenHides() {
        // name 100 dp (40 dp at 4 characters), chip 90 dp whole, 48 dp icon only, 2 dp apart.
        fun mode(room: Float) = AttendanceRules.chipMode(room, nameNatural = 100f, nameMin = 40f, full = 90f, iconOnly = 48f, gap = 2f)
        assertEquals(ChipMode.FULL, mode(192f))
        assertEquals(ChipMode.ICON, mode(191f))
        // The name gives up its tail for the icon down to 4 characters.
        assertEquals(ChipMode.ICON, mode(90f))
        assertEquals(ChipMode.HIDDEN, mode(89f))
        // A short name: never cut below itself.
        assertEquals(ChipMode.ICON, AttendanceRules.chipMode(70f, nameNatural = 20f, nameMin = 40f, full = 90f, iconOnly = 48f, gap = 2f))
    }

    @Test fun theSheetSwitchesAndKeepsTheNoteOnlyForTheSameState() {
        // Another state: the note is cleared (「15 時に戻ります」 is wrong once back).
        assertEquals(AttendanceRules.Press("room", null), AttendanceRules.sheetPress(board, "me", "room"))
        assertEquals(AttendanceRules.Press("mine", null), AttendanceRules.sheetPress(board, "me", "mine"))
        // The same state again keeps it.
        assertEquals(AttendanceRules.Press("out", "15 時に戻ります"), AttendanceRules.sheetPress(board, "me", "out"))
        // Nobody yet: no note.
        assertEquals(AttendanceRules.Press("room", null), AttendanceRules.sheetPress(board, "new", "room"))
        // The sheet's rows are my choices: the workspace's, then mine.
        assertEquals(listOf("room", "out", "mine"), AttendanceRules.choices(board, "me").map { it.state.id })
        assertEquals(listOf("out"), AttendanceRules.choices(board, "me").filter { it.selected }.map { it.state.id })
    }

    @Test fun theSheetSavesTheNoteOnMyState() {
        assertEquals(AttendanceRules.Press("out", "会議室 B"), AttendanceRules.sheetNote(board, "me", "  会議室   B "))
        assertEquals(AttendanceRules.Press("out", null), AttendanceRules.sheetNote(board, "me", "   "))
        // Unchanged: nothing to send (the sheet just closes).
        assertNull(AttendanceRules.sheetNote(board, "me", "15 時に戻ります"))
        // No state yet: no note field, nothing to send.
        assertNull(AttendanceRules.sheetNote(board, "new", "x"))
    }
}
