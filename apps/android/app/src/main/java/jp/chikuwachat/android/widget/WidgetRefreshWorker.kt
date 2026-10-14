package jp.chikuwachat.android.widget

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import jp.chikuwachat.android.ChikuwaApp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * The 在室状況 and 未読・メンション widgets of a workspace the app does not have on screen (a widget's own choice,
 * [WidgetWorkspaces]): nothing live writes their snapshots, so this reads them through that workspace's own client
 * (AppController.widgetRefresh: GET /attendance with the people, GET /sync/summary). The workspace on screen needs none
 * of it (the app writes its snapshots); the 今日 widget reads every workspace it shows itself ([TodayWidgetWorker]).
 *
 * When: at once after a widget chooses such a workspace, and every [PERIOD_MIN] minutes (ordinary inexact work that
 * waits for a network) only while some placed widget shows one; with none, the periodic work is cancelled.
 */
/**
 * REVIEW-v0.1.62 #1: a widget's read or press found that its workspace's account changed meanwhile (a sign-out, another
 * person signing in on the same server): what it read or was to send belongs to the session before, so it is dropped.
 */
class WidgetAccountChanged : Exception("the workspace's account changed")

class WidgetRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val context = applicationContext
        val asked = inputData.getString(KEY_SERVER)
        val servers = asked?.let { listOf(it) } ?: elsewhere(context)
        if (asked == null && servers.isEmpty()) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
            return Result.success()
        }
        val controller = (context as ChikuwaApp).controller
        for (server in servers) {
            try {
                withContext(Dispatchers.Main) { controller.widgetRefresh(server) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: WidgetAccountChanged) {
                // Read in a session that ended meantime: nothing of it is written (the sign-out cleared the widgets).
            } catch (e: Exception) {
                Log.w(TAG, "could not refresh a workspace's widgets", e)
                AttendanceWidgetData.store.write(context, server) { old -> old?.copy(failed = true) }
            }
        }
        return Result.success()
    }

    companion object {
        private const val TAG = "WidgetRefresh"
        private const val KEY_SERVER = "server"
        private const val PERIODIC = "widget-refresh"
        private const val NOW = "widget-refresh-now:"
        const val PERIOD_MIN = 30L

        /** The workspaces placed 在室状況 / 未読 widgets chose that are not the one on screen. */
        suspend fun elsewhere(context: Context): List<String> {
            val ids = WidgetWorkspaces.ids(context, AttendanceWidget::class.java) + WidgetWorkspaces.ids(context, UnreadWidget::class.java)
            return WidgetWorkspaceRules.elsewhere(ids, WidgetWorkspaces.read(context))
        }

        private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Reads [serverUrl]'s widgets now (a widget just chose it). */
        fun refreshNow(context: Context, serverUrl: String) {
            val request = OneTimeWorkRequestBuilder<WidgetRefreshWorker>()
                .setConstraints(network)
                .setInputData(workDataOf(KEY_SERVER to serverUrl))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW + serverUrl, ExistingWorkPolicy.REPLACE, request)
        }

        /** The periodic read while some widget shows a workspace other than the one on screen; none otherwise. */
        suspend fun ensure(context: Context) {
            val manager = WorkManager.getInstance(context)
            if (elsewhere(context).isEmpty()) {
                manager.cancelUniqueWork(PERIODIC)
                return
            }
            val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(PERIOD_MIN, TimeUnit.MINUTES).setConstraints(network).build()
            manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
