package jp.chikuwachat.android.widget

import android.content.Context
import jp.chikuwachat.android.platform.PushMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The 未読・メンション widget's snapshot ([UnreadWidgetSnapshot]): written by the app for the workspace on screen
 * (AppController, from its store), bumped by a push while the app is not live there, cleared on sign-out.
 */
object UnreadWidgetData {
    val store = WidgetSnapshotStore(
        "unread_widget", UnreadWidget::class.java, ::UnreadWidget,
        UnreadWidgetRules::encode, UnreadWidgetRules::decode, UnreadWidgetRules::same,
    )

    fun flow(context: Context): StateFlow<UnreadWidgetSnapshot?> = store.flow(context)

    /** The app's numbers for the workspace on screen (they replace whatever a push guessed). */
    suspend fun publish(context: Context, snapshot: UnreadWidgetSnapshot) = store.write(context) { snapshot }

    /** A push for [serverUrl] while the app is not live there (PUSH_NOTIFICATIONS.md §9): the server's number, its conversation on top. */
    suspend fun pushed(context: Context, serverUrl: String, push: PushMessage) {
        val now = System.currentTimeMillis()
        store.write(context) { old -> if (old == null || old.serverUrl != serverUrl) old else UnreadWidgetRules.pushed(old, push, now) ?: old }
    }

    /** The workspace signed out or left this device: the widget asks to open the app until a workspace writes its own. */
    suspend fun forget(context: Context, serverUrl: String) = store.write(context) { old -> old?.takeIf { it.serverUrl != serverUrl } }
}

/**
 * The 今日の予定・締切 widget's snapshot ([TodayWidgetSnapshot]) and its clock: the widget picks what to show for the
 * time it is drawn at, so a scheduled redraw ([TodayWidgetWorker]) only moves [clock] (a new day reads the server too).
 */
object TodayWidgetData {
    val store = WidgetSnapshotStore(
        "today_widget", TodayWidget::class.java, ::TodayWidget,
        TodayWidgetRules::encode, TodayWidgetRules::decode, TodayWidgetRules::same,
    )

    private val tick = MutableStateFlow(System.currentTimeMillis())

    /** The time the widget is drawn for; moved by every scheduled redraw (the composition follows it). */
    val clock: StateFlow<Long> = tick

    fun flow(context: Context): StateFlow<TodayWidgetSnapshot?> = store.flow(context)

    /** A new read replaces the snapshot (the worker then plans the next redraw from its events and due times). */
    suspend fun publish(context: Context, snapshot: TodayWidgetSnapshot) {
        tick.value = System.currentTimeMillis()
        store.write(context) { snapshot }
    }

    /** A read failed: what is held stays, with 「更新できません」. */
    suspend fun failed(context: Context) = store.write(context) { old -> old?.copy(failed = true) }

    /** Draws the widget again for now (a new event's end, midnight). */
    suspend fun redrawNow(context: Context) {
        tick.value = System.currentTimeMillis()
        store.redraw(context)
    }

    suspend fun forget(context: Context, serverUrl: String) = store.write(context) { old -> old?.takeIf { it.serverUrl != serverUrl } }
}
