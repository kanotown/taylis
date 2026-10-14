package jp.chikuwachat.android.widget

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import jp.chikuwachat.android.BuildConfig
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import kotlinx.coroutines.CancellationException
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.Locale

/**
 * The widget picker's previews: the widgets themselves drawn with sample data (names in the app's language), so the
 * picker shows what a widget looks like instead of the app icon. Android 15+ takes them as generated previews
 * ([publish], from GlanceAppWidget.providePreview); older versions show the `previewImage` pictures in the provider
 * info (screenshots of these same previews).
 */
object WidgetPreviews {
    /** The sample's workspace key (taps on a preview do nothing). */
    const val SERVER = "preview"

    /** 2×1, 4×1, 2×2 and 4×2 as the picker draws them. */
    val SIZES: Set<DpSize> = setOf(DpSize(180.dp, 110.dp), DpSize(360.dp, 110.dp), DpSize(180.dp, 230.dp), DpSize(360.dp, 230.dp))

    private fun name() = L10n.str(R.string.app_name)

    private fun person(index: Int) = when (index) {
        1 -> L10n.str(R.string.widget_preview_person_1)
        2 -> L10n.str(R.string.widget_preview_person_2)
        else -> L10n.str(R.string.widget_preview_person_3)
    }

    fun attendance(): AttendanceWidgetSnapshot {
        val states = listOf(
            WidgetState("in", L10n.str(R.string.widget_preview_state_in), icon = "in_room", color = "green", kind = "in_room"),
            WidgetState("on", L10n.str(R.string.widget_preview_state_on), icon = "on_site", color = "blue", kind = "on_site"),
            WidgetState("off", L10n.str(R.string.widget_preview_state_off), icon = "off_site", color = "purple", kind = "off_site"),
            WidgetState("gone", L10n.str(R.string.widget_preview_state_gone), icon = "gone", color = "red", kind = "gone"),
        )
        return AttendanceWidgetSnapshot(
            serverUrl = SERVER, workspaceName = name(), meId = "preview-me", enabled = true, states = states, myState = states[0],
            // Three others in the room, two of them known by name here: the faces end with 「+1」.
            inRoomOthers = 3, present = listOf(WidgetPerson("preview-b", person(2)), WidgetPerson("preview-c", person(3))),
            meName = person(1),
        )
    }

    fun unread(): UnreadWidgetSnapshot = UnreadWidgetSnapshot(
        serverUrl = SERVER, workspaceName = name(), meId = "preview-me", mentions = 3, dms = 4,
        rows = listOf(
            UnreadRow("p1", person(1), 3, dm = true, userId = "preview-b"),
            UnreadRow("p2", L10n.str(R.string.widget_preview_channel_1), 2, dm = false),
            UnreadRow("p3", person(2) + ", " + person(3), 1, dm = true, group = true),
            UnreadRow("p4", L10n.str(R.string.widget_preview_channel_2), 1, dm = false),
        ),
        conversations = 4,
    )

    /** Today with two events and a task due, drawn as at 9:00 ([morning]). */
    fun today(zone: ZoneId = ZoneId.systemDefault()): TodayWidgetSnapshot {
        val day = LocalDate.now(zone)
        fun at(hour: Int, minute: Int = 0) = day.atTime(LocalTime.of(hour, minute)).atZone(zone).toInstant().toString()
        return TodayWidgetSnapshot(
            serverUrl = SERVER, workspaceName = name(), meId = "preview-me", day = day.toString(),
            events = listOf(
                TodayEvent("e1", L10n.str(R.string.widget_preview_event_1), channelId = "preview-seminar", channelName = null, startsAt = at(10), endsAt = at(11, 30)),
                TodayEvent("e2", L10n.str(R.string.widget_preview_event_2), channelId = "preview-lab", channelName = null, startsAt = at(13), endsAt = at(14)),
            ),
            tasks = listOf(TodayTask("t1", L10n.str(R.string.widget_preview_task_1), dueOn = day.toString(), dueAt = at(17))),
        )
    }

    /** The moment the preview is drawn for: 9:00 today. */
    fun morning(zone: ZoneId = ZoneId.systemDefault()): Long =
        LocalDate.now(zone).atTime(9, 0).atZone(zone).toInstant().toEpochMilli()

    private const val PREFS = "widget_previews"
    private const val KEY = "published"

    /**
     * Android 15+: hands the launcher the three generated previews, once per app version and language (the system
     * limits how often an app may do this; a refused call is tried again at the next start).
     */
    suspend fun publish(context: Context) {
        if (Build.VERSION.SDK_INT < 35) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val stamp = BuildConfig.VERSION_CODE.toString() + "|" + Locale.getDefault().toLanguageTag() + "|" + L10n.str(R.string.widget_preview_state_in)
        if (prefs.getString(KEY, null) == stamp) return
        try {
            val manager = GlanceAppWidgetManager(context)
            val results = listOf(
                manager.setWidgetPreviews(AttendanceWidgetReceiver::class),
                manager.setWidgetPreviews(UnreadWidgetReceiver::class),
                manager.setWidgetPreviews(TodayWidgetReceiver::class),
            )
            if (results.all { it == GlanceAppWidgetManager.SET_WIDGET_PREVIEWS_RESULT_SUCCESS }) prefs.edit().putString(KEY, stamp).apply()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("WidgetPreviews", "could not set the widget previews", e)
        }
    }
}
