package jp.chikuwachat.android.share

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import jp.chikuwachat.android.ChikuwaApp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.MainActivity
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.platform.ConversationStyle
import jp.chikuwachat.android.platform.Notifier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import okio.buffer
import okio.source
import java.io.File
import java.util.concurrent.TimeUnit

/** The share jobs on disk: `filesDir/share/<id>/job.json` and the copied files beside it (MOBILE_UI.md §20.4). */
class ShareJobs(private val root: File) {
    constructor(context: Context) : this(File(context.filesDir, "share"))

    fun dir(id: String): File = File(root, id)

    fun read(id: String): ShareJob? = File(dir(id), JOB_FILE).takeIf { it.isFile }?.readText()?.let { ShareJob.decode(it) }

    /** Written to a temporary file and renamed, so a kill half-way never leaves a broken job. */
    fun save(job: ShareJob) {
        val dir = dir(job.id).apply { mkdirs() }
        val tmp = File(dir, "$JOB_FILE.tmp")
        tmp.writeText(ShareJob.encode(job))
        if (!tmp.renameTo(File(dir, JOB_FILE))) {
            File(dir, JOB_FILE).writeText(ShareJob.encode(job))
            tmp.delete()
        }
    }

    /**
     * The worker's save of an uploaded attachment id: only while the job is still there, so work that runs on after its
     * account's jobs were removed ([dropAccount]) never brings the job back.
     */
    fun update(job: ShareJob) {
        if (File(dir(job.id), JOB_FILE).isFile) save(job)
    }

    fun delete(id: String) {
        dir(id).deleteRecursively()
    }

    /**
     * REVIEW-v0.1.62 #1: the jobs of [serverUrl] that do not belong to [keepUserId] (all of them when null) — a
     * sign-out, a removed workspace, or another account signing in there. Each job and its copies are deleted; the
     * jobs are returned so that their work and notifications can go too.
     */
    fun dropAccount(serverUrl: String, keepUserId: String? = null): List<ShareJob> {
        val dropped = mutableListOf<ShareJob>()
        root.listFiles()?.forEach { dir ->
            val job = runCatching { File(dir, JOB_FILE).takeIf { it.isFile }?.readText() }.getOrNull()?.let { ShareJob.decode(it) } ?: return@forEach
            if (job.serverUrl != serverUrl || (keepUserId != null && job.userId == keepUserId)) return@forEach
            dir.deleteRecursively()
            dropped += job
        }
        return dropped
    }

    /** Copies left behind by a share screen that was closed without sending (or killed): older than [maxAgeMs], no job. */
    fun purgeAbandoned(now: Long = System.currentTimeMillis(), maxAgeMs: Long = 24 * 3600_000L, keep: Set<String> = emptySet()) {
        root.listFiles()?.forEach { dir ->
            if (dir.name in keep) return@forEach
            if (!File(dir, JOB_FILE).isFile && now - dir.lastModified() > maxAgeMs) dir.deleteRecursively()
        }
    }

    companion object {
        const val JOB_FILE = "job.json"
    }
}

/**
 * MOBILE_UI.md §20.4: uploads a share's files and posts its message after the share screen closed. Expedited, and a
 * foreground job with a progress notification while it uploads, so a long video keeps going; it waits for a network and
 * retries temporary failures with a growing wait (WorkManager's backoff); the post carries the job's idempotency key, so
 * a retry after a lost answer finds the message made the first time. The end is a notification that opens the conversation.
 */
class ShareWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val jobs = ShareJobs(context)
    private val notifications = ShareNotifications(context)

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val job = inputData.getString(KEY_JOB)?.let { jobs.read(it) }
        return foregroundInfo(job, 0, 0)
    }

    private fun foregroundInfo(job: ShareJob?, sent: Long, total: Long): ForegroundInfo {
        val notification = notifications.progress(job, sent, total)
        val id = ShareNotifications.progressId(job?.id ?: "")
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(id, notification)
    }

    override suspend fun doWork(): Result {
        val jobId = inputData.getString(KEY_JOB) ?: return Result.failure()
        val job = withContext(Dispatchers.IO) { jobs.read(jobId) } ?: return Result.failure()
        val controller = (applicationContext as ChikuwaApp).controller
        // REVIEW-v0.1.62 #1: the client of the account that shared it, never the one now signed in to the same server.
        val client = withContext(Dispatchers.Main) { controller.shareClient(job) }
        // Signed out, or another person signed in there: the share goes without a request in anyone's name (the
        // sign-out itself removed the account's jobs and said so when it was not asked for, AppController.endSession).
        if (client == null) return finish(job, ShareOutcome.Dropped)
        if (job.files.any { it.attachmentId == null }) {
            // Android 12+ may refuse a foreground start from the background (a retry): the work goes on without it.
            runCatching { setForeground(foregroundInfo(job, 0, job.pendingBytes)) }
        }
        var shown = 0L
        val sender = ShareSender(
            api = WorkerShareApi(client, jobs),
            save = { jobs.update(it) },
            progress = { sent, total ->
                val now = System.currentTimeMillis()
                if (now - shown >= PROGRESS_INTERVAL_MS || sent == total) {
                    shown = now
                    notifications.showProgress(job, sent, total)
                }
            },
            stillOurs = { withContext(Dispatchers.Main) { controller.shareStillOurs(job, client) } },
        )
        val outcome = withContext(Dispatchers.IO) { sender.run(job) }
        if (outcome is ShareOutcome.Retry && runAttemptCount + 1 < MAX_ATTEMPTS) {
            notifications.showWaiting(job)
            return Result.retry()
        }
        return finish(job, outcome)
    }

    private suspend fun finish(job: ShareJob, outcome: ShareOutcome): Result {
        notifications.cancelProgress(job)
        when (outcome) {
            is ShareOutcome.Posted -> {
                val controller = (applicationContext as ChikuwaApp).controller
                withContext(Dispatchers.Main) { controller.sharePosted(job.serverUrl, outcome.message) }
                notifications.showPosted(job, outcome.message)
                ShareShortcuts.push(applicationContext, job.serverUrl, job.channelId, job.channelTitle)
            }
            is ShareOutcome.Retry, is ShareOutcome.Failed -> {
                val error = (outcome as? ShareOutcome.Failed)?.error ?: (outcome as ShareOutcome.Retry).error
                val controller = (applicationContext as ChikuwaApp).controller
                notifications.showFailed(job, if (error is ShareFileMissing) L10n.str(R.string.share_in_failed_files_gone) else controller.describe(error))
            }
            ShareOutcome.Dropped -> Unit // its account left: nothing is said in another person's session
        }
        withContext(Dispatchers.IO) { jobs.delete(job.id) }
        return if (outcome is ShareOutcome.Posted) Result.success() else Result.failure()
    }

    companion object {
        const val KEY_JOB = "job"
        /** About a day of retries with the backoff below (30 s doubling, WorkManager caps it at 5 h). */
        const val MAX_ATTEMPTS = 12
        private const val PROGRESS_INTERVAL_MS = 700L

        /** Starts the job's work now (expedited while the quota lasts), once a network is there. */
        fun enqueue(context: Context, jobId: String, serverUrl: String) {
            val request = OneTimeWorkRequestBuilder<ShareWorker>()
                .setInputData(workDataOf(KEY_JOB to jobId))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(TAG)
                .addTag(serverTag(serverUrl))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(workName(jobId), ExistingWorkPolicy.KEEP, request)
        }

        const val TAG = "share"

        fun workName(jobId: String) = "share:$jobId"

        /** Every share work of one workspace carries this tag, so a sign-out can cancel the lot. */
        fun serverTag(serverUrl: String) = "share-server:$serverUrl"

        /**
         * REVIEW-v0.1.62 #1: the account of [serverUrl] signed out, left this device or was replaced by another one
         * ([keepUserId] the new account's, whose own jobs stay): its jobs, their copies, their work and their
         * notifications go. A job already running is cancelled with its work (and checks its account between calls).
         * [reason] (a session the server ended) says once per job that it was not sent; a sign-out on purpose says nothing.
         */
        fun dropAccount(context: Context, serverUrl: String, keepUserId: String? = null, reason: String? = null) {
            val manager = WorkManager.getInstance(context)
            if (keepUserId == null) manager.cancelAllWorkByTag(serverTag(serverUrl))
            val dropped = ShareJobs(context).dropAccount(serverUrl, keepUserId)
            for (job in dropped) manager.cancelUniqueWork(workName(job.id))
            val notifications = ShareNotifications(context)
            notifications.clearWorkspace(serverUrl)
            if (reason != null) for (job in dropped) notifications.showFailed(job, reason)
        }
    }
}

/** The worker's server calls: the workspace's own ApiClient, the copied file streamed from disk. */
private class WorkerShareApi(private val client: ApiClient, private val jobs: ShareJobs) : ShareApi {
    override suspend fun upload(job: ShareJob, file: ShareJobFile, sent: (Long) -> Unit): String {
        val copy = File(jobs.dir(job.id), file.path)
        if (!copy.isFile) throw ShareFileMissing(file.name)
        return client.uploadAttachment(FileBody(copy, file.mime, sent), file.name).id
    }

    override suspend fun post(channelId: String, clientMsgId: String, body: String, attachmentIds: List<String>): MessageOut =
        client.postMessage(channelId, clientMsgId, body, null, attachmentIds).first
}

/** A file streamed in chunks, counting what was written (the progress notification). Written again on a token refresh. */
private class FileBody(private val file: File, private val mime: String?, private val sent: (Long) -> Unit) : RequestBody() {
    override fun contentType(): MediaType? = (mime ?: "application/octet-stream").toMediaTypeOrNull()
    override fun contentLength(): Long = file.length()
    override fun writeTo(sink: BufferedSink) {
        file.source().buffer().use { source ->
            var total = 0L
            while (true) {
                val read = source.read(sink.buffer, CHUNK)
                if (read == -1L) break
                total += read
                sink.emitCompleteSegments()
                sent(total)
            }
        }
    }

    private companion object {
        const val CHUNK = 64 * 1024L
    }
}

/** The share's notifications: progress (silent, its own channel), then 送信しました / 送信できませんでした. */
class ShareNotifications(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_PROGRESS, L10n.str(R.string.share_in_channel_progress), NotificationManager.IMPORTANCE_LOW),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_RESULT, L10n.str(R.string.share_in_channel_result), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    private val permitted: Boolean
        get() = Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun progress(job: ShareJob?, sent: Long, total: Long): android.app.Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(job?.let { L10n.str(R.string.share_in_sending_to, it.channelTitle) } ?: L10n.str(R.string.share_in_sending))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        if (job != null) builder.addExtras(workspaceExtras(job))
        if (total > 0) {
            val percent = ((sent * 100) / total).toInt().coerceIn(0, 100)
            builder.setProgress(100, percent, false).setContentText("$percent%")
        } else {
            builder.setProgress(0, 0, true)
        }
        if (job != null) builder.setContentIntent(open(job, null))
        return builder.build()
    }

    fun showProgress(job: ShareJob, sent: Long, total: Long) {
        if (!permitted) return
        manager.notify(progressId(job.id), progress(job, sent, total))
    }

    /** Between retries: no bar, a line that it will be sent once the connection is back. */
    fun showWaiting(job: ShareJob) {
        if (!permitted) return
        val notification = NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(L10n.str(R.string.share_in_sending_to, job.channelTitle))
            .setContentText(L10n.str(R.string.share_in_waiting))
            .addExtras(workspaceExtras(job))
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(open(job, null))
            .build()
        manager.notify(progressId(job.id), notification)
    }

    fun cancelProgress(job: ShareJob) = manager.cancel(progressId(job.id))

    fun showPosted(job: ShareJob, message: MessageOut) {
        if (!permitted) return
        val notification = NotificationCompat.Builder(context, CHANNEL_RESULT)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(L10n.str(R.string.share_in_posted_to, job.channelTitle))
            .addExtras(workspaceExtras(job))
            .setContentIntent(open(job, message.id))
            .setAutoCancel(true)
            .setTimeoutAfter(RESULT_TIMEOUT_MS)
            .build()
        manager.notify(job.id, RESULT_ID, notification)
    }

    fun showFailed(job: ShareJob, reason: String) {
        if (!permitted) return
        val notification = NotificationCompat.Builder(context, CHANNEL_RESULT)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(L10n.str(R.string.share_in_failed_to, job.channelTitle))
            .addExtras(workspaceExtras(job))
            .setContentText(reason)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reason))
            .setContentIntent(open(job, null))
            .setAutoCancel(true)
            .build()
        manager.notify(job.id, RESULT_ID, notification)
    }

    /** The workspace the notification belongs to: its sign-out removes it (Notifier.clearWorkspace, [clearWorkspace]). */
    private fun workspaceExtras(job: ShareJob) = android.os.Bundle().apply { putString(Notifier.EXTRA_WORKSPACE, job.serverUrl) }

    /** REVIEW-v0.1.62 #1: a workspace's share notifications (progress, waiting, sent, not sent) go with its account. */
    fun clearWorkspace(serverUrl: String) {
        runCatching { manager.activeNotifications }.getOrNull()?.forEach { shown ->
            val channel = shown.notification.channelId
            if ((channel == CHANNEL_PROGRESS || channel == CHANNEL_RESULT) && shown.notification.extras?.getString(Notifier.EXTRA_WORKSPACE) == serverUrl) {
                manager.cancel(shown.tag, shown.id)
            }
        }
    }

    /** The conversation in its workspace, as a message notification opens it ([messageId] only tells the intents apart). */
    private fun open(job: ShareJob, messageId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(Notifier.EXTRA_CHANNEL_ID, job.channelId)
            putExtra(Notifier.EXTRA_WORKSPACE, job.serverUrl)
            // Not revealed at the message: it is the newest one, and a reveal shows 「検索結果の前後」 instead of the timeline.
        }
        return PendingIntent.getActivity(context, ("share|" + job.id + "|" + messageId).hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    companion object {
        const val CHANNEL_PROGRESS = "share_progress"
        const val CHANNEL_RESULT = "share_result"
        private const val RESULT_ID = 2
        private const val RESULT_TIMEOUT_MS = 10 * 60_000L

        /** One progress notification per job (also the foreground service's). */
        fun progressId(jobId: String): Int = 0x5000 + (jobId.hashCode() and 0x0fff)
    }
}

/**
 * Direct Share (MOBILE_UI.md §20.5): the conversation shortcuts carry [CATEGORY], which res/xml/shortcuts.xml names as a
 * share target of [ShareActivity], so the system's share sheet can offer them. A share posted to a conversation makes or
 * refreshes its shortcut too (the message notifications already make one per conversation, PUSH_NOTIFICATIONS.md §16).
 */
object ShareShortcuts {
    const val CATEGORY = "jp.chikuwachat.android.category.SHARE_TARGET"

    fun push(context: Context, workspace: String, channelId: String, title: String) {
        val id = ConversationStyle.shortcutId(workspace, channelId)
        // A notification's shortcut has the sender's picture: it is kept as it is (it carries the category already).
        val exists = runCatching {
            ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_DYNAMIC).any { it.id == id }
        }.getOrDefault(false)
        if (exists) return
        val shortcut = ShortcutInfoCompat.Builder(context, id)
            .setShortLabel(title.take(40).ifBlank { "?" })
            .setLongLived(true)
            .setCategories(setOf(CATEGORY))
            .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
            .setIntent(
                Intent(context, MainActivity::class.java).apply {
                    action = Notifier.ACTION_CONVERSATION
                    putExtra(Notifier.EXTRA_CHANNEL_ID, channelId)
                    putExtra(Notifier.EXTRA_WORKSPACE, workspace)
                },
            )
            .build()
        runCatching { ShortcutManagerCompat.pushDynamicShortcut(context, shortcut) }
    }
}
