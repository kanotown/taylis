package jp.chikuwachat.android.widget

import android.content.Context
import kotlinx.coroutines.flow.StateFlow

/**
 * Where the 在室状況 widget's snapshots live ([WidgetSnapshotStore], file `attendance_widget`): one per workspace, written
 * by the app for the workspace on screen (and by [WidgetRefreshWorker] for one a widget chose that is not on screen),
 * changed by the widget's own presses. Each widget draws its workspace's ([WidgetWorkspaces]).
 */
object AttendanceWidgetData {
    val store = WidgetSnapshotStore(
        "attendance_widget", AttendanceWidget::class.java, ::AttendanceWidget,
        AttendanceWidgetRules::encode, AttendanceWidgetRules::decode, AttendanceWidgetRules::same, { it.serverUrl },
    )

    fun flow(context: Context): StateFlow<Map<String, AttendanceWidgetSnapshot>> = store.flow(context)

    fun read(context: Context, serverUrl: String): AttendanceWidgetSnapshot? = store.read(context, serverUrl)

    /** A workspace's snapshot from the app (a widget press still waiting keeps its look, [AttendanceWidgetRules.merge]). */
    suspend fun publish(context: Context, snapshot: AttendanceWidgetSnapshot) {
        val now = System.currentTimeMillis()
        store.write(context, snapshot.serverUrl) { old -> AttendanceWidgetRules.merge(old, snapshot, now) }
    }

    /** The workspace left this device: its widgets ask to open the app (or follow the app again, [WidgetWorkspaces]). */
    suspend fun forget(context: Context, serverUrl: String) = store.write(context, serverUrl) { null }

    /** Its session ended (signed out elsewhere, refused refresh): the last state stays with 「更新できません」. */
    suspend fun signedOut(context: Context, serverUrl: String) =
        store.write(context, serverUrl) { old -> old?.let(AttendanceWidgetRules::failed) }

    suspend fun redraw(context: Context) = store.redraw(context)
}
