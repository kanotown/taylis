package jp.chikuwachat.android.widget

import android.content.Context
import android.content.Intent
import jp.chikuwachat.android.MainActivity
import jp.chikuwachat.android.platform.Notifier

/** A screen a widget's body opens (its workspace on screen first). */
enum class WidgetScreen(val key: String) {
    /** The home tab at its root (the conversation list, unread first with 「未読をまとめる」). */
    HOME("home"),
    /** The calendar over the home tab. */
    CALENDAR("calendar"),
    /** 「タスク」 (自分の担当) over the home tab. */
    TASKS("tasks"),
}

/**
 * What a tap on a home-screen widget opens, in the widget's workspace (switching to it first, as a notification's tap
 * does, WORKSPACES.md §7). The ids travel in the notifications' own extras (Notifier.EXTRA_*), so a widget's row lands
 * exactly where the same notification would: a conversation, an event (its channel's 「予定」 tab, or the calendar for
 * my own calendar), a task (its channel's 「タスク」 tab, or 「タスク」 for a personal one or a DM's).
 */
sealed interface WidgetLink {
    val workspace: String?

    data class Conversation(override val workspace: String?, val channelId: String) : WidgetLink

    /**
     * An event. For one occurrence of a series, [seriesId] and [occurrenceStart] name it and [day] (the local date it is
     * on, "YYYY-MM-DD") says which range to read it from: the server has no route for one occurrence (CALENDAR.md §10.11).
     */
    data class Event(
        override val workspace: String?, val channelId: String?, val eventId: String,
        val seriesId: String? = null, val occurrenceStart: String? = null, val day: String? = null,
    ) : WidgetLink

    data class Task(override val workspace: String?, val channelId: String?, val taskId: String) : WidgetLink

    data class Screen(override val workspace: String?, val screen: WidgetScreen) : WidgetLink
}

object WidgetLinks {
    /** Marks a widget's intent and says what it opens: "conversation", "event", "task" or "screen". */
    const val EXTRA_LINK = "jp.chikuwachat.android.extra.WIDGET_LINK"
    const val EXTRA_SCREEN = "jp.chikuwachat.android.extra.WIDGET_SCREEN"
    const val EXTRA_SERIES = "jp.chikuwachat.android.extra.WIDGET_SERIES"
    const val EXTRA_OCCURRENCE = "jp.chikuwachat.android.extra.WIDGET_OCCURRENCE"
    const val EXTRA_DAY = "jp.chikuwachat.android.extra.WIDGET_DAY"
    private const val ACTION = "jp.chikuwachat.android.action.OPEN_FROM_WIDGET"

    /** Every extra a widget's intent may carry (taken off the intent once read, so a rotation does not open it again). */
    val KEYS: List<String> = listOf(
        EXTRA_LINK, EXTRA_SCREEN, EXTRA_SERIES, EXTRA_OCCURRENCE, EXTRA_DAY,
        Notifier.EXTRA_WORKSPACE, Notifier.EXTRA_CHANNEL_ID, Notifier.EXTRA_EVENT_ID, Notifier.EXTRA_TASK_ID,
    )

    /** The intent's extras for [link] (string values only). */
    fun extras(link: WidgetLink): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        fun put(key: String, value: String?) { if (value != null) out[key] = value }
        put(Notifier.EXTRA_WORKSPACE, link.workspace)
        when (link) {
            is WidgetLink.Conversation -> {
                put(EXTRA_LINK, "conversation")
                put(Notifier.EXTRA_CHANNEL_ID, link.channelId)
            }
            is WidgetLink.Event -> {
                put(EXTRA_LINK, "event")
                put(Notifier.EXTRA_CHANNEL_ID, link.channelId)
                put(Notifier.EXTRA_EVENT_ID, link.eventId)
                put(EXTRA_SERIES, link.seriesId)
                put(EXTRA_OCCURRENCE, link.occurrenceStart)
                put(EXTRA_DAY, link.day)
            }
            is WidgetLink.Task -> {
                put(EXTRA_LINK, "task")
                put(Notifier.EXTRA_CHANNEL_ID, link.channelId)
                put(Notifier.EXTRA_TASK_ID, link.taskId)
            }
            is WidgetLink.Screen -> {
                put(EXTRA_LINK, "screen")
                put(EXTRA_SCREEN, link.screen.key)
            }
        }
        return out
    }

    /** The link an intent's extras carry ([get] reads one string extra); null when it is not a widget's (or incomplete). */
    fun parse(get: (String) -> String?): WidgetLink? {
        val workspace = get(Notifier.EXTRA_WORKSPACE)
        return when (get(EXTRA_LINK)) {
            "conversation" -> get(Notifier.EXTRA_CHANNEL_ID)?.let { WidgetLink.Conversation(workspace, it) }
            "event" -> get(Notifier.EXTRA_EVENT_ID)?.let {
                WidgetLink.Event(workspace, get(Notifier.EXTRA_CHANNEL_ID), it, get(EXTRA_SERIES), get(EXTRA_OCCURRENCE), get(EXTRA_DAY))
            }
            "task" -> get(Notifier.EXTRA_TASK_ID)?.let { WidgetLink.Task(workspace, get(Notifier.EXTRA_CHANNEL_ID), it) }
            "screen" -> WidgetScreen.entries.firstOrNull { it.key == get(EXTRA_SCREEN) }?.let { WidgetLink.Screen(workspace, it) }
            else -> null
        }
    }

    /** MainActivity's intent for [link] (brought forward, not stacked; Glance gives each row's tap its own PendingIntent). */
    fun intent(context: Context, link: WidgetLink): Intent = Intent(context, MainActivity::class.java).apply {
        action = ACTION
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        extras(link).forEach { (key, value) -> putExtra(key, value) }
    }
}
