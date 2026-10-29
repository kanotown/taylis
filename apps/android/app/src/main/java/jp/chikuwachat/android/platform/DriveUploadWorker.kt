package jp.chikuwachat.android.platform

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.core.app.NotificationCompat
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
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.DrivePost
import jp.chikuwachat.android.sync.LargeFiles
import jp.chikuwachat.android.sync.DriveUploadJob
import jp.chikuwachat.android.sync.DriveUploadJobs
import jp.chikuwachat.android.sync.DriveUploadRules
import jp.chikuwachat.android.sync.DriveUploader
import jp.chikuwachat.android.sync.FileBytes
import jp.chikuwachat.android.sync.UploadOutcome
import jp.chikuwachat.android.sync.UploadState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * 2026-10-24 (docs/DRIVE.md §6, MOBILE_UI.md §25): the phone's drive uploads, process-wide — the jobs on disk
 * ([DriveUploadJobs] under `filesDir/drive-uploads`) as a flow for the panel, the bytes in flight, adding files (a
 * picked content URI is copied into its job first: its grant does not outlive the process), and the panel's actions
 * (cancel → DELETE the session, retry, the conflict's answer, clear the finished). The uploading itself is
 * [DriveUploadWorker]'s.
 */
object DriveUploadCenter {
    @Volatile private var jobsStore: DriveUploadJobs? = null
    private val _jobs = MutableStateFlow<List<DriveUploadJob>>(emptyList())
    val jobs: StateFlow<List<DriveUploadJob>> = _jobs
    private val _live = MutableStateFlow<Map<String, Long>>(emptyMap())
    /** Bytes sent of a job running now (the parts the server has and those on their way). */
    val live: StateFlow<Map<String, Long>> = _live
    private val running = ConcurrentHashMap<String, kotlinx.coroutines.Job>()
    private val preparing: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val liveAt = ConcurrentHashMap<String, Long>()

    fun store(context: Context): DriveUploadJobs =
        jobsStore ?: synchronized(this) { jobsStore ?: DriveUploadJobs(File(context.applicationContext.filesDir, "drive-uploads")).also { jobsStore = it } }

    fun refresh(context: Context) {
        _jobs.value = store(context).all()
    }

    /**
     * Where a batch goes, and the account it belongs to (REVIEW-v0.1.62 #1: its user id and sign-in). [onConflict]:
     * `fail` asks when a name is taken; an album's uploads keep both (`rename`, docs/ALBUMS.md §9).
     */
    data class Target(val serverUrl: String, val userId: String, val session: String?, val locationId: String, val parentId: String, val label: String, val onConflict: String = "fail")

    private fun newJob(target: Target, batchId: String, name: String, size: Long, lastModified: Long?, state: String, post: DrivePost? = null) = DriveUploadJob(
        id = UUID.randomUUID().toString(), serverUrl = target.serverUrl, userId = target.userId, session = target.session,
        batchId = batchId, clientUploadId = UUID.randomUUID().toString(), name = name, size = size, lastModifiedMs = lastModified,
        locationId = target.locationId, parentId = target.parentId, label = target.label, state = state, createdAt = System.currentTimeMillis(),
        onConflict = target.onConflict,
        // CF5: a link posted from the share sheet keeps one idempotency key per file.
        post = post?.let { if (it.mode == LargeFiles.MODE_SEND && it.clientMsgId == null) it.copy(clientMsgId = UUID.randomUUID().toString()) else it },
    )

    /**
     * Files picked in the drive (photo picker, camera, the system's file picker): each is copied into its job
     * (準備中) and then queued; the work starts at once. [onCopied] runs once all are copied (the camera's photo goes).
     */
    fun addUris(context: Context, scope: CoroutineScope, uris: List<Uri>, target: Target, onCopied: (() -> Unit)? = null, post: DrivePost? = null) {
        if (uris.isEmpty()) return
        val app = context.applicationContext
        val store = store(app)
        val batch = UUID.randomUUID().toString()
        scope.launch {
            try {
                val made = uris.map { uri ->
                    val (name, size, modified) = withContext(Dispatchers.IO) { describe(app, uri) }
                    newJob(target, batch, name, size ?: 0L, modified, UploadState.PREPARING, post).also {
                        preparing += it.id
                        withContext(Dispatchers.IO) { store.save(it) }
                    }
                }
                refresh(app)
                uris.zip(made).forEach { (uri, job) ->
                    val copied = withContext(Dispatchers.IO) {
                        try {
                            val target0 = store.data(job.id)
                            val input = app.contentResolver.openInputStream(uri) ?: throw IOException("no stream")
                            input.use { source -> target0.outputStream().use { source.copyTo(it, 64 * 1024) } }
                            target0.length()
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            null
                        }
                    }
                    withContext(Dispatchers.IO) {
                        store.change(job.id) {
                            if (copied == null) it.copy(state = UploadState.FAILED, error = "read_failed")
                            else it.copy(size = copied, state = UploadState.QUEUED)
                        }
                    }
                    preparing -= job.id
                    refresh(app)
                    if (copied != null) DriveUploadWorker.enqueue(app, target.serverUrl)
                }
            } finally {
                onCopied?.invoke()
            }
        }
    }

    /**
     * Files already copied into the app (the share screen's copies, MOBILE_UI.md §20.3): moved into their jobs and
     * queued. Runs on the caller's (IO) thread.
     */
    fun addFiles(context: Context, files: List<Pair<File, String>>, target: Target, post: DrivePost? = null) {
        if (files.isEmpty()) return
        val app = context.applicationContext
        val store = store(app)
        val batch = UUID.randomUUID().toString()
        files.forEach { (file, name) ->
            val job = newJob(target, batch, name, file.length(), null, UploadState.QUEUED, post)
            val data = store.data(job.id)
            data.parentFile?.mkdirs()
            if (!file.renameTo(data)) {
                file.inputStream().use { input -> data.outputStream().use { input.copyTo(it, 64 * 1024) } }
                file.delete()
            }
            store.save(job.copy(size = data.length()))
        }
        refresh(app)
        DriveUploadWorker.enqueue(app, target.serverUrl)
    }

    /** A picked document's name, size and time (the size may be unknown: the copy's length is used then). */
    private fun describe(context: Context, uri: Uri): Triple<String, Long?, Long?> {
        var name: String? = null
        var size: Long? = null
        var modified: Long? = null
        runCatching {
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 && !cursor.isNull(it) }?.let { name = cursor.getString(it) }
                    cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }?.let { size = cursor.getLong(it).takeIf { s -> s >= 0 } }
                    cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 && !cursor.isNull(it) }
                        ?.let { modified = cursor.getLong(it).takeIf { t -> t > 0 } }
                }
            }
        }
        return Triple(name?.takeIf { it.isNotBlank() } ?: (uri.lastPathSegment?.substringAfterLast('/') ?: "file"), size, modified)
    }

    /** 取りやめる: the job stops (its part in flight too), its copy goes and the server's session is dropped (DELETE). */
    fun cancel(context: Context, scope: CoroutineScope, id: String) {
        val app = context.applicationContext
        val store = store(app)
        scope.launch {
            val job = store.read(id) ?: return@launch
            store.cancel(id) { (app as ChikuwaApp).controller.driveUploadClient(job) }
            running[id]?.cancel()
            refresh(app)
        }
    }

    /** やり直す (a failed job). */
    fun retry(context: Context, id: String) {
        val app = context.applicationContext
        val job = store(app).change(id) { if (it.state == UploadState.FAILED && it.error != "read_failed") DriveUploadRules.retry(it) { UUID.randomUUID().toString() } else null } ?: return
        refresh(app)
        DriveUploadWorker.enqueue(app, job.serverUrl)
    }

    /** The answer to a name conflict ([all]: 「残りすべてに同じ操作」). */
    fun answer(context: Context, scope: CoroutineScope, id: String, choice: String, all: Boolean) {
        val app = context.applicationContext
        val store = store(app)
        val answered = DriveUploadRules.answer(store.all(), id, choice, all)
        answered.changed.forEach { changed -> store.change(changed.id) { changed } }
        answered.changed.filter { it.isFinished }.forEach { store.dropData(it.id) }
        refresh(app)
        DriveUploadNotifications(app).cancelAsking(id)
        val job = store.read(id) ?: return
        DriveUploadWorker.enqueue(app, job.serverUrl)
        if (answered.abort.isNotEmpty()) scope.launch {
            val client = (app as ChikuwaApp).controller.driveUploadClient(job) ?: return@launch
            answered.abort.forEach { runCatching { client.abortDriveUpload(it) } }
        }
    }

    /** 完了したものを消す: the finished rows of [serverUrl] (done, skipped, cancelled) leave the panel. */
    fun clearFinished(context: Context, serverUrl: String) {
        val store = store(context)
        store.all().filter { it.serverUrl == serverUrl && it.isFinished }.forEach { store.delete(it.id) }
        refresh(context)
    }

    /**
     * At the app's start: a job still being copied by a process that is gone fails (its grant went with it), old
     * finished rows go, and each account's unfinished jobs get their work again (KEEP: a work already there stays).
     */
    fun resume(context: Context) {
        val app = context.applicationContext
        val store = store(app)
        store.tidy(System.currentTimeMillis(), preparingHere = preparing.toSet())
        refresh(app)
        _jobs.value.filter { it.state in UploadState.RUNNABLE || LargeFiles.linkPending(it, LargeFiles.MODE_SEND) }
            .map { it.serverUrl }.distinct().forEach { DriveUploadWorker.enqueue(app, it, keep = true) }
    }

    /** CF5: the link of [id] went into its draft or was posted (never twice). */
    fun markLinked(context: Context, id: String): DriveUploadJob? {
        val app = context.applicationContext
        val changed = store(app).change(id) { job -> job.post?.takeIf { !it.linked }?.let { job.copy(post = it.copy(linked = true)) } }
        refresh(app)
        return changed
    }

    /**
     * CF5: a finished file shared into a conversation (MODE_SEND) is posted there as its `/d/` link, with the job's
     * idempotency key (a retry after a lost answer gives the same message). False: not now (the work tries again).
     */
    internal suspend fun postLink(context: Context, job: DriveUploadJob, client: ApiClient): Boolean {
        val post = job.post ?: return false
        val item = job.itemId ?: return false
        if (post.linked) return true
        return try {
            val (message, _) = client.postMessage(
                post.channelId, post.clientMsgId ?: job.id, LargeFiles.link(client.baseUrl, item), post.parentId, emptyList(),
                jp.chikuwachat.android.sync.SendOptions(),
            )
            markLinked(context, job.id)
            withContext(Dispatchers.Main) { (context.applicationContext as ChikuwaApp).controller.sharePosted(job.serverUrl, message) }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.w("DriveUpload", "could not post the link of ${job.id}", e)
            // Refused for good (left the channel, archived): nothing to retry; the file stays in the drive.
            if (e is jp.chikuwachat.android.api.ApiException.Api && !e.isRetryable) markLinked(context, job.id)
            false
        }
    }

    /** REVIEW-v0.1.62 #1: the account of [serverUrl] left (or another signed in): its jobs, copies, work and notifications go. */
    fun dropAccount(context: Context, serverUrl: String, keepUserId: String? = null) {
        val app = context.applicationContext
        if (keepUserId == null) WorkManager.getInstance(app).cancelUniqueWork(DriveUploadWorker.workName(serverUrl))
        val dropped = store(app).dropAccount(serverUrl, keepUserId)
        dropped.forEach { running[it.id]?.cancel() }
        refresh(app)
        DriveUploadNotifications(app).clearWorkspace(serverUrl)
    }

    internal fun setLive(jobId: String, sent: Long?, force: Boolean = false) {
        if (sent == null) {
            liveAt.remove(jobId)
            _live.value = _live.value - jobId
            return
        }
        val now = System.currentTimeMillis()
        if (!force && now - (liveAt[jobId] ?: 0L) < 200) return
        liveAt[jobId] = now
        _live.value = _live.value + (jobId to sent)
    }

    /** Runs one job; a cancel from the panel stops it alone ([UploadOutcome.Gone]), not the work. */
    internal suspend fun run(context: Context, job: DriveUploadJob, client: ApiClient, onProgress: () -> Unit): UploadOutcome {
        val app = context.applicationContext
        val store = store(app)
        val controller = (app as ChikuwaApp).controller
        val uploader = DriveUploader(
            api = client,
            save = { next -> store.update(next).also { if (it) _jobs.value = _jobs.value.map { held -> if (held.id == next.id) next else held } } },
            progress = { id, sent -> setLive(id, sent); onProgress() },
            stillOurs = { withContext(Dispatchers.Main) { controller.driveUploadStillOurs(job, client) } },
            findFolder = { held -> LargeFiles.applied(held, LargeFiles.resolve(client, held.post!!, System.currentTimeMillis())) },
        )
        return try {
            coroutineScope {
                val task = async(Dispatchers.IO) { uploader.run(job, FileBytes(store.data(job.id))) }
                running[job.id] = task
                task.await()
            }
        } catch (e: CancellationException) {
            if (!currentCoroutineContext().isActive) throw e
            UploadOutcome.Gone(store.read(job.id)?.uploadId ?: job.uploadId)
        } finally {
            running.remove(job.id)
            setLive(job.id, null)
            refresh(app)
        }
    }
}

/**
 * The drive's upload work, one per account's server (unique work `drive-upload:<server>`): it uploads that account's
 * queued jobs one file at a time until none is left. Needs a network; a foreground job (dataSync, progress
 * notification) while it uploads, so it goes on with the app closed; temporary failures beyond the quick retries
 * end the run with WorkManager's retry (30 s doubling). After a process death or a force-stop WorkManager runs it
 * again, and the app's start enqueues it for unfinished jobs too ([DriveUploadCenter.resume]).
 */
class DriveUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val notifications = DriveUploadNotifications(context)

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo(inputData.getString(KEY_SERVER) ?: "")

    private fun foregroundInfo(server: String): ForegroundInfo {
        val notification = notifications.progress(server, DriveUploadCenter.jobs.value.filter { it.serverUrl == server }, DriveUploadCenter.live.value)
        val id = DriveUploadNotifications.progressId(server)
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(id, notification)
    }

    override suspend fun doWork(): Result {
        val server = inputData.getString(KEY_SERVER) ?: return Result.success()
        val app = applicationContext
        val store = DriveUploadCenter.store(app)
        val controller = (app as ChikuwaApp).controller
        DriveUploadCenter.refresh(app)
        var foreground = false
        val done = mutableListOf<DriveUploadJob>()
        var shown = 0L
        var linksLeft = false
        try {
            // CF5: links of shared files finished before (their posting failed for now) go first.
            for (pending in withContext(Dispatchers.IO) { store.all() }.filter { it.serverUrl == server && LargeFiles.linkPending(it, LargeFiles.MODE_SEND) }) {
                val client = withContext(Dispatchers.Main) { controller.driveUploadClient(pending) } ?: continue
                if (!DriveUploadCenter.postLink(app, pending, client)) linksLeft = true
            }
            while (true) {
                val next = withContext(Dispatchers.IO) { store.all() }.firstOrNull { it.serverUrl == server && it.state in UploadState.RUNNABLE } ?: break
                val client = withContext(Dispatchers.Main) { controller.driveUploadClient(next) }
                if (client == null) {
                    // Its account signed out or another signed in there: nothing goes in anyone's name.
                    withContext(Dispatchers.IO) { store.delete(next.id) }
                    DriveUploadCenter.refresh(app)
                    continue
                }
                if (!foreground) {
                    // Android 12+ may refuse a foreground start from the background (a retry): the work goes on without it.
                    runCatching { setForeground(foregroundInfo(server)) }
                    foreground = true
                }
                val outcome = DriveUploadCenter.run(app, next, client) {
                    val now = System.currentTimeMillis()
                    if (now - shown >= 1_000) {
                        shown = now
                        notifications.showProgress(server)
                    }
                }
                val inFront = controller.appForeground
                when (outcome) {
                    is UploadOutcome.Done -> {
                        withContext(Dispatchers.IO) { store.dropData(outcome.job.id) }
                        withContext(Dispatchers.Main) { controller.driveUploadDone(outcome.job) }
                        if (LargeFiles.linkPending(outcome.job, LargeFiles.MODE_SEND) && !DriveUploadCenter.postLink(app, outcome.job, client)) linksLeft = true
                        done += outcome.job
                    }
                    is UploadOutcome.Skipped -> withContext(Dispatchers.IO) { store.dropData(outcome.job.id) }
                    is UploadOutcome.Asking -> if (!inFront) notifications.showAsking(outcome.job)
                    is UploadOutcome.Failed -> if (!inFront) notifications.showFailed(outcome.job, describe(outcome.job))
                    is UploadOutcome.Retry -> {
                        notifications.showWaiting(server)
                        return Result.retry()
                    }
                    is UploadOutcome.Gone -> outcome.uploadId?.let { id -> runCatching { client.abortDriveUpload(id) } }
                    UploadOutcome.Dropped -> withContext(Dispatchers.IO) { store.delete(next.id) }
                }
                DriveUploadCenter.refresh(app)
            }
        } finally {
            notifications.cancelProgress(server)
        }
        if (done.isNotEmpty() && !controller.appForeground) notifications.showDone(server, done)
        return if (linksLeft) Result.retry() else Result.success()
    }

    private fun describe(job: DriveUploadJob): String = driveUploadError(job.error) ?: jp.chikuwachat.android.api.ErrorTexts.unknown

    companion object {
        const val KEY_SERVER = "server"
        const val TAG = "drive-upload"

        fun workName(serverUrl: String) = "drive-upload:$serverUrl"

        /**
         * Starts (or chains) the account's work: new files are appended after the run in progress (which may take them
         * itself: it reads the jobs again after each file); [keep] at the app's start leaves a work already there alone.
         */
        fun enqueue(context: Context, serverUrl: String, keep: Boolean = false) {
            val request = OneTimeWorkRequestBuilder<DriveUploadWorker>()
                .setInputData(workDataOf(KEY_SERVER to serverUrl))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(TAG)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                workName(serverUrl), if (keep) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.APPEND_OR_REPLACE, request,
            )
        }
    }
}

/** An upload's failure in words: read_failed is the app's; the server's codes go through the shared error table. */
fun driveUploadError(code: String?): String? = when (code) {
    null -> null
    "read_failed" -> L10n.str(R.string.drive_upload_read_failed)
    "network" -> jp.chikuwachat.android.api.ErrorTexts.network
    else -> jp.chikuwachat.android.api.ErrorTexts.code(code) ?: jp.chikuwachat.android.api.ErrorTexts.unknown
}

/** The uploads' notifications: progress (silent, its own channel), waiting, the conflict's question, done / failed. */
class DriveUploadNotifications(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannel(NotificationChannel(CHANNEL_PROGRESS, L10n.str(R.string.drive_upload_channel_progress), NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel(CHANNEL_RESULT, L10n.str(R.string.drive_upload_channel_result), NotificationManager.IMPORTANCE_DEFAULT))
    }

    private val permitted: Boolean
        get() = Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun extras(server: String) = android.os.Bundle().apply { putString(Notifier.EXTRA_WORKSPACE, server) }

    fun progress(server: String, jobs: List<DriveUploadJob>, live: Map<String, Long>): android.app.Notification {
        val totals = DriveUploadRules.totals(jobs.filter { !it.isFinished || it.state == UploadState.DONE }, live)
        val builder = NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(L10n.str(R.string.drive_upload_notify_progress, totals.done, totals.files))
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .addExtras(extras(server))
            .setContentIntent(open(server, "progress"))
        if (totals.bytes > 0) {
            builder.setProgress(1000, ((totals.sent * 1000) / totals.bytes).toInt().coerceIn(0, 1000), false)
                .setContentText(L10n.str(R.string.drive_progress, DriveNames.bytes(totals.sent), DriveNames.bytes(totals.bytes)))
        } else builder.setProgress(0, 0, true)
        return builder.build()
    }

    fun showProgress(server: String) {
        if (!permitted) return
        manager.notify(progressId(server), progress(server, DriveUploadCenter.jobs.value.filter { it.serverUrl == server }, DriveUploadCenter.live.value))
    }

    fun cancelProgress(server: String) = manager.cancel(progressId(server))

    fun showWaiting(server: String) {
        if (!permitted) return
        manager.notify(progressId(server), NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(L10n.str(R.string.drive_upload_channel_progress))
            .setContentText(L10n.str(R.string.drive_upload_notify_waiting))
            .setOnlyAlertOnce(true).setSilent(true)
            .addExtras(extras(server))
            .setContentIntent(open(server, "waiting"))
            .build())
    }

    fun showAsking(job: DriveUploadJob) {
        if (!permitted) return
        manager.notify(job.id, ASK_ID, NotificationCompat.Builder(context, CHANNEL_RESULT)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(L10n.str(R.string.drive_upload_notify_asking, job.name))
            .setContentText(L10n.str(R.string.drive_upload_notify_asking_text))
            .addExtras(extras(job.serverUrl))
            .setContentIntent(open(job.serverUrl, "ask:" + job.id))
            .setAutoCancel(true)
            .build())
    }

    fun cancelAsking(jobId: String) = manager.cancel(jobId, ASK_ID)

    fun showFailed(job: DriveUploadJob, reason: String) {
        if (!permitted) return
        manager.notify(job.id, RESULT_ID, NotificationCompat.Builder(context, CHANNEL_RESULT)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(L10n.str(R.string.drive_upload_notify_failed, job.name))
            .setContentText(reason)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reason))
            .addExtras(extras(job.serverUrl))
            .setContentIntent(open(job.serverUrl, "failed:" + job.id))
            .setAutoCancel(true)
            .build())
    }

    fun showDone(server: String, done: List<DriveUploadJob>) {
        if (!permitted) return
        val title = if (done.size == 1) L10n.str(R.string.drive_upload_notify_done_one, done[0].name) else L10n.plural(R.plurals.drive_upload_notify_done, done.size, done.size)
        manager.notify(server, DONE_ID, NotificationCompat.Builder(context, CHANNEL_RESULT)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(done.map { it.label }.distinct().joinToString(", "))
            .addExtras(extras(server))
            .setContentIntent(open(server, "done"))
            .setAutoCancel(true)
            .setTimeoutAfter(10 * 60_000L)
            .build())
    }

    fun clearWorkspace(server: String) {
        runCatching { manager.activeNotifications }.getOrNull()?.forEach { shown ->
            val channel = shown.notification.channelId
            if ((channel == CHANNEL_PROGRESS || channel == CHANNEL_RESULT) && shown.notification.extras?.getString(Notifier.EXTRA_WORKSPACE) == server) {
                manager.cancel(shown.tag, shown.id)
            }
        }
    }

    /** The app in that workspace with the uploads panel open (the question shows there). */
    private fun open(server: String, key: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(EXTRA_DRIVE_UPLOADS, true)
            putExtra(Notifier.EXTRA_WORKSPACE, server)
        }
        return PendingIntent.getActivity(context, ("drive-upload|$server|$key").hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    companion object {
        const val CHANNEL_PROGRESS = "drive_upload_progress"
        const val CHANNEL_RESULT = "drive_upload_result"
        const val EXTRA_DRIVE_UPLOADS = "drive_uploads"
        private const val RESULT_ID = 3
        private const val ASK_ID = 4
        private const val DONE_ID = 5

        fun progressId(server: String): Int = 0x6000 + (server.hashCode() and 0x0fff)
    }
}
