package jp.chikuwachat.android.widget

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import jp.chikuwachat.android.ChikuwaApp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A widget button's change of my state, in the app process: the app's own client for that workspace (its stored session,
 * token refresh and sign-out; AppController.widgetSetAttendance), then the widget's snapshot from the answer. Expedited
 * work, so it starts at once and finishes even when the receiver that took the tap is gone; presses run one after
 * another (APPEND_OR_REPLACE, one chain per workspace), so the last tap wins. A press carries the person who pressed
 * (the snapshot's meId) and is sent only while that person is the one signed in there (REVIEW-v0.1.62 #1). A failure (offline, signed out, the server refused) leaves the last
 * known state with 「更新できません」; nothing is retried behind the user's back.
 */
class AttendanceWidgetWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val serverUrl = inputData.getString(KEY_SERVER) ?: return Result.success()
        val meId = inputData.getString(KEY_ME) ?: return Result.success()
        val stateId = inputData.getString(KEY_STATE) ?: return Result.success()
        val controller = (applicationContext as ChikuwaApp).controller
        try {
            val fresh = withContext(Dispatchers.Main) { controller.widgetSetAttendance(serverUrl, meId, stateId) }
            val now = System.currentTimeMillis()
            AttendanceWidgetData.store.update(applicationContext, serverUrl) { old -> AttendanceWidgetRules.answered(old, fresh, stateId, now) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("AttendanceWidget", "could not set the attendance state", e)
            AttendanceWidgetData.store.update(applicationContext, serverUrl) { old -> AttendanceWidgetRules.failedPress(old, stateId, meId) }
        }
        AttendanceWidgetData.redraw(applicationContext)
        // Always success: the next press in the chain still runs (a failed one would cancel it).
        return Result.success()
    }

    /** Before Android 12 expedited work runs as a short foreground job, which needs a (silent) notification. */
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, L10n.str(R.string.attendance_widget_channel), NotificationManager.IMPORTANCE_MIN),
        )
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(L10n.str(R.string.attendance_widget_updating))
            .setSilent(true)
            .setOngoing(true)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(NOTIFICATION_ID, notification)
    }

    companion object {
        private const val KEY_SERVER = "server"
        private const val KEY_ME = "me"
        private const val KEY_STATE = "state"
        private const val WORK_NAME = "attendance-widget-press:"
        private const val CHANNEL = "attendance_widget"
        private const val NOTIFICATION_ID = 0x6100

        fun enqueue(context: Context, serverUrl: String, meId: String, stateId: String) {
            val request = OneTimeWorkRequestBuilder<AttendanceWidgetWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setInputData(workDataOf(KEY_SERVER to serverUrl, KEY_ME to meId, KEY_STATE to stateId))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME + serverUrl, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }

        /**
         * REVIEW-v0.1.62 #1: [serverUrl]'s account signed out or was replaced: its presses still waiting go (one that
         * runs anyway is refused, AppController.widgetSetAttendance checks the person).
         */
        fun cancel(context: Context, serverUrl: String) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME + serverUrl)
        }
    }
}
