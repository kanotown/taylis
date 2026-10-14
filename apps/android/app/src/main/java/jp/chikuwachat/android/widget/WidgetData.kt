package jp.chikuwachat.android.widget

import android.content.Context
import jp.chikuwachat.android.platform.PushMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The 未読・メンション widget's snapshots ([UnreadWidgetSnapshot]), one per workspace: written by the app for the workspace
 * on screen (AppController, from its store), bumped by a push for a workspace the app is not live in, corrected by
 * GET /sync/summary for one that is not on screen, cleared on sign-out.
 */
object UnreadWidgetData {
    val store = WidgetSnapshotStore(
        "unread_widget", UnreadWidget::class.java, ::UnreadWidget,
        UnreadWidgetRules::encode, UnreadWidgetRules::decode, UnreadWidgetRules::same, { it.serverUrl },
    )

    fun flow(context: Context): StateFlow<Map<String, UnreadWidgetSnapshot>> = store.flow(context)

    /** The app's numbers for the workspace on screen (they replace whatever a push or a summary guessed). */
    suspend fun publish(context: Context, snapshot: UnreadWidgetSnapshot) = store.write(context, snapshot.serverUrl) { snapshot }

    /** A push for [serverUrl] while the app is not live there (PUSH_NOTIFICATIONS.md §9): the server's number, its conversation on top. */
    suspend fun pushed(context: Context, serverUrl: String, push: PushMessage) {
        val now = System.currentTimeMillis()
        store.write(context, serverUrl) { old -> if (old == null) null else UnreadWidgetRules.pushed(old, push, now) ?: old }
    }

    /** GET /sync/summary of a workspace that is not on screen ([UnreadWidgetRules.summarized]). */
    suspend fun summarized(context: Context, serverUrl: String, workspaceName: String, meId: String, badge: Int) {
        val now = System.currentTimeMillis()
        store.write(context, serverUrl) { old -> UnreadWidgetRules.summarized(old, serverUrl, workspaceName, meId, badge, now) }
    }

    /** The workspace signed out or left this device: its widgets ask to open the app. */
    suspend fun forget(context: Context, serverUrl: String) = store.write(context, serverUrl) { null }
}

/**
 * The 今日の予定・締切 widget's snapshots ([TodayWidgetSnapshot]), one per workspace, and their clock: the widget picks
 * what to show for the time it is drawn at, so a scheduled redraw ([TodayWidgetWorker]) only moves [clock] (a new day
 * reads the server too).
 */
object TodayWidgetData {
    val store = WidgetSnapshotStore(
        "today_widget", TodayWidget::class.java, ::TodayWidget,
        TodayWidgetRules::encode, TodayWidgetRules::decode, TodayWidgetRules::same, { it.serverUrl },
    )

    private val tick = MutableStateFlow(System.currentTimeMillis())

    /** The time the widget is drawn for; moved by every scheduled redraw (the composition follows it). */
    val clock: StateFlow<Long> = tick

    fun flow(context: Context): StateFlow<Map<String, TodayWidgetSnapshot>> = store.flow(context)

    /** A new read replaces the workspace's snapshot (the worker then plans the next redraw from all of them). */
    suspend fun publish(context: Context, snapshot: TodayWidgetSnapshot) {
        tick.value = System.currentTimeMillis()
        store.write(context, snapshot.serverUrl) { snapshot }
    }

    /** A read failed: what is held stays, with 「更新できません」. */
    suspend fun failed(context: Context, serverUrl: String) = store.write(context, serverUrl) { old -> old?.copy(failed = true) }

    /** Draws the widget again for now (a new event's end, midnight). */
    suspend fun redrawNow(context: Context) {
        tick.value = System.currentTimeMillis()
        store.redraw(context)
    }

    suspend fun forget(context: Context, serverUrl: String) = store.write(context, serverUrl) { null }
}
