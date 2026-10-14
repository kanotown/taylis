package jp.chikuwachat.android.widget

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import jp.chikuwachat.android.ChikuwaApp
import jp.chikuwachat.android.ui.CalendarDates
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * The 今日の予定・締切 widget's work, in the app process (nothing runs while no such widget is placed):
 *
 * - **read** ([requestRead]): GET /calendar/events for today and tomorrow and GET /tasks/mine through the workspace's own
 *   client (AppController.widgetReadToday: its token refresh and sign-out), then the snapshot. Asked for by the app
 *   after it connects and when a calendar or task event arrives (a few seconds later, so a burst reads once), after a
 *   calendar or task push while the app is not live, and when a widget is placed. Waits for a network.
 * - **tick** ([schedule]): the next moment the widget looks different without new data — an event's end, a task's due
 *   time, midnight ([TodayWidgetRules.nextRefresh]). It only redraws, except on a new day, when it reads as well.
 *
 * Battery: one ordinary (inexact, Doze-respecting) WorkManager job at a time per kind — typically a handful of wake-ups
 * a day (midnight plus the ends of the day's timed events), each a redraw from the saved snapshot with no network,
 * except the one read a day at midnight. No exact alarms (no SCHEDULE_EXACT_ALARM), no periodic polling.
 */
class TodayWidgetWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val context = applicationContext
        if (!TodayWidgetData.store.placed(context)) {
            cancel(context)
            return Result.success()
        }
        val today = CalendarDates.today()
        val forced = inputData.getBoolean(KEY_READ, false)
        // Every workspace a placed widget shows (its own choice, or the one on screen in the app), each with its client.
        val shown = TodayWidgetData.store.shown(context)
        val controller = (context as ChikuwaApp).controller
        for (server in shown) {
            if (!forced && !TodayWidgetRules.needsRead(TodayWidgetData.store.read(context, server), today)) continue
            try {
                val snapshot = withContext(Dispatchers.Main) { controller.widgetReadToday(server) }
                if (snapshot != null) TodayWidgetData.publish(context, snapshot) else TodayWidgetData.store.write(context, server) { null }
            } catch (e: CancellationException) {
                throw e
            } catch (_: WidgetAccountChanged) {
                // Read in a session that ended meantime: dropped (the next read is the new account's).
            } catch (e: Exception) {
                Log.w("TodayWidget", "could not read today's events and tasks", e)
                TodayWidgetData.failed(context, server)
            }
        }
        TodayWidgetData.redrawNow(context)
        // Last: replacing the planned tick cancels this very job when it is that tick (nothing is left to do here).
        val held = shown.mapNotNull { TodayWidgetData.store.read(context, it) }
        schedule(context, TodayWidgetRules.nextRefresh(held, Instant.now()))
        return Result.success()
    }

    companion object {
        private const val KEY_READ = "read"
        private const val READ_WORK = "today-widget-read"
        private const val TICK_WORK = "today-widget-tick"
        /** A burst of calendar / task events reads once. */
        const val READ_DELAY_MS = 3_000L

        /** Reads today's events and tasks again ([delayMs] later; a newer request replaces a waiting one). */
        fun requestRead(context: Context, delayMs: Long = READ_DELAY_MS) {
            val request = OneTimeWorkRequestBuilder<TodayWidgetWorker>()
                .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(workDataOf(KEY_READ to true))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(READ_WORK, ExistingWorkPolicy.REPLACE, request)
        }

        /** The next redraw at [at] (replacing the one planned). */
        fun schedule(context: Context, at: Instant) {
            val delay = (at.toEpochMilli() - System.currentTimeMillis()).coerceAtLeast(0L)
            val request = OneTimeWorkRequestBuilder<TodayWidgetWorker>()
                .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                .setInputData(workDataOf(KEY_READ to false))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(TICK_WORK, ExistingWorkPolicy.REPLACE, request)
        }

        /** The last widget left the home screen: nothing more to draw. */
        fun cancel(context: Context) {
            val manager = WorkManager.getInstance(context)
            manager.cancelUniqueWork(READ_WORK)
            manager.cancelUniqueWork(TICK_WORK)
        }
    }
}
