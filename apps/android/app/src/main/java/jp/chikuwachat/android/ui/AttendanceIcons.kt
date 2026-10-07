package jp.chikuwachat.android.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BeachAccess
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.CoPresent
import androidx.compose.material.icons.outlined.Flight
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.LocalLibrary
import androidx.compose.material.icons.outlined.MeetingRoom
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Science
import androidx.compose.material.icons.outlined.Thermostat
import androidx.compose.ui.graphics.vector.ImageVector
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.AttendanceStateOut

/**
 * 在室状況 (docs/PRESENCE.md §2.1, §9.1): the states' icons. A copy of apps/shared/attendance-icons.json — its keys in the
 * picker's order, the `material` name and the `Icons.Outlined.*` vector drawn for it (written out, no reflection: R8 keeps
 * only what is referenced) and the meaning's name (strings_attendance.xml `attendance_icon_<key>`, ja / en / zh-Hans from
 * the file's `label`). AttendanceIconsTest compares all of it with the file.
 *
 * A state whose `icon` this app does not know (a key added later) or that has none shows its emoji instead, or no picture.
 */
object AttendanceIcons {
    class Entry(val key: String, val material: String, val vector: ImageVector, val labelRes: Int)

    val CATALOGUE: List<Entry> = listOf(
        Entry("in_room", "MeetingRoom", Icons.Outlined.MeetingRoom, R.string.attendance_icon_in_room),
        Entry("on_site", "Business", Icons.Outlined.Business, R.string.attendance_icon_on_site),
        Entry("off_site", "Place", Icons.Outlined.Place, R.string.attendance_icon_off_site),
        Entry("gone", "Home", Icons.Outlined.Home, R.string.attendance_icon_gone),
        Entry("meeting", "Groups", Icons.Outlined.Groups, R.string.attendance_icon_meeting),
        Entry("class", "CoPresent", Icons.Outlined.CoPresent, R.string.attendance_icon_class),
        Entry("remote", "Laptop", Icons.Outlined.Laptop, R.string.attendance_icon_remote),
        Entry("lunch", "Restaurant", Icons.Outlined.Restaurant, R.string.attendance_icon_lunch),
        Entry("trip", "Flight", Icons.Outlined.Flight, R.string.attendance_icon_trip),
        Entry("away", "Schedule", Icons.Outlined.Schedule, R.string.attendance_icon_away),
        Entry("busy", "RemoveCircleOutline", Icons.Outlined.RemoveCircleOutline, R.string.attendance_icon_busy),
        Entry("sick", "Thermostat", Icons.Outlined.Thermostat, R.string.attendance_icon_sick),
        Entry("vacation", "BeachAccess", Icons.Outlined.BeachAccess, R.string.attendance_icon_vacation),
        Entry("lab", "Science", Icons.Outlined.Science, R.string.attendance_icon_lab),
        Entry("library", "LocalLibrary", Icons.Outlined.LocalLibrary, R.string.attendance_icon_library),
        Entry("other", "Circle", Icons.Outlined.Circle, R.string.attendance_icon_other),
    )

    private val BY_KEY: Map<String, Entry> = CATALOGUE.associateBy { it.key }

    /** The file's `defaults`: a new state's icon follows its kind's until one is picked. */
    val DEFAULT_OF_KIND: Map<String, String> = mapOf("in_room" to "in_room", "on_site" to "on_site", "off_site" to "off_site", "gone" to "gone")

    fun entry(key: String?): Entry? = key?.let { BY_KEY[it] }

    /** The vector of a key, or null (none, or a key this app does not know). */
    fun vector(key: String?): ImageVector? = entry(key)?.vector

    /** The meaning in the UI language (the picker's TalkBack name). */
    fun label(key: String): String = entry(key)?.let { L10n.str(it.labelRes) } ?: key

    /** What a state is drawn with: its icon, else its emoji (a custom emoji `:name:` too), else nothing. */
    sealed interface Glyph {
        data class Icon(val key: String) : Glyph
        data class Emoji(val text: String) : Glyph
        data object None : Glyph
    }

    fun glyph(icon: String?, emoji: String?): Glyph = when {
        entry(icon) != null -> Glyph.Icon(icon!!)
        !emoji.isNullOrBlank() -> Glyph.Emoji(emoji)
        else -> Glyph.None
    }

    fun glyph(state: AttendanceStateOut): Glyph = glyph(state.icon, state.emoji)
}
