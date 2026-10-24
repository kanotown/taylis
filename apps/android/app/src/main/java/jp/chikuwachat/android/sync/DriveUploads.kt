package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DrivePreviewOut
import jp.chikuwachat.android.api.DriveUploadCompleteOut
import jp.chikuwachat.android.api.DriveUploadOut
import jp.chikuwachat.android.api.DriveUploadPartOut
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

/*
 * 2026-10-24 (docs/DRIVE.md §6, §28): uploads into the drive from the phone — the same API and rules as the desktop's
 * drive/uploads.ts. A file is a job kept on disk (`filesDir/drive-uploads/<id>/job.json` and a copy of its bytes,
 * `data`): content URIs from the pickers and the share sheet lose their grant, so the bytes are copied first. The
 * background work (platform/DriveUploadWorker.kt) runs [DriveUploader] on one job at a time; everything here is plain
 * Kotlin (DriveUploadTest runs it against a fake server).
 */

/** The drive's write calls (ApiClient; a fake in DriveUploadTest). Separate from [DriveApi], which is read only. */
interface DriveWriteApi {
    suspend fun createDriveUpload(clientUploadId: String, parentId: String, name: String, sizeBytes: Long, contentModifiedMs: Long?, onConflict: String): DriveUploadOut
    suspend fun driveUpload(uploadId: String): DriveUploadOut
    suspend fun patchDriveUpload(uploadId: String, onConflict: String): DriveUploadOut
    /** PUT /drive/uploads/{id}/parts/{n}: bytes [start, end) of [bytes], `X-Content-SHA256` [sha256Hex]; [sent] counts what was written. */
    suspend fun putDrivePart(uploadId: String, number: Int, bytes: UploadBytes, start: Long, end: Long, sha256Hex: String, sent: (Long) -> Unit): DriveUploadPartOut
    suspend fun completeDriveUpload(uploadId: String): DriveUploadCompleteOut
    suspend fun abortDriveUpload(uploadId: String)
    /** POST /drive/folders {parent_id, name, client_op_id}: the same client_op_id again answers the same folder. */
    suspend fun createDriveFolder(parentId: String, name: String, clientOpId: String): DriveItemOut
    /** §27.3: POST /drive/items/{id}/preview — makes the preview when the file has none (pending), or says how it stands. */
    suspend fun requestDrivePreview(itemId: String): DrivePreviewOut
}

/** A file's bytes, read a range at a time (never whole). */
interface UploadBytes {
    /** Hex SHA-256 of [start, end). */
    fun sha256(start: Long, end: Long): String
    fun open(start: Long, end: Long): InputStream
}

/** The job's copy on disk. A copy that is gone (storage cleared) throws: the job fails with `read_failed`. */
class FileBytes(private val file: File) : UploadBytes {
    override fun sha256(start: Long, end: Long): String {
        val digest = MessageDigest.getInstance("SHA-256")
        open(start, end).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return hex(digest.digest())
    }

    override fun open(start: Long, end: Long): InputStream {
        val input = FileInputStream(file)
        input.channel.position(start)
        return Bounded(input, end - start)
    }

    private class Bounded(input: InputStream, private var left: Long) : FilterInputStream(input) {
        override fun read(): Int = if (left <= 0) -1 else super.read().also { if (it >= 0) left-- }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = super.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
    }

    companion object {
        fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    }
}

/** A job's states (the panel's words: 準備中 / 待機中 / 送信中 / 完了処理中 / 接続待ち / 確認中 / 完了 / …). */
object UploadState {
    /** The picked file is being copied into the job (the grant of a content URI lasts only so long). */
    const val PREPARING = "preparing"
    const val QUEUED = "queued"
    const val UPLOADING = "uploading"
    const val COMPLETING = "completing"
    /** A network failure, 429 or 5xx: the work tries again (WorkManager's backoff, once a network is there). */
    const val WAITING = "waiting"
    /** A name conflict waits for the person's answer (the in-app question; a notification while in the background). */
    const val ASKING = "asking"
    const val DONE = "done"
    const val SKIPPED = "skipped"
    const val FAILED = "failed"
    const val CANCELLED = "cancelled"

    /** The states the worker runs. */
    val RUNNABLE = setOf(QUEUED, UPLOADING, COMPLETING, WAITING)
    val FINISHED = setOf(DONE, SKIPPED, CANCELLED)
}

object ConflictChoice {
    const val VERSION = "version"
    const val RENAME = "rename"
    const val SKIP = "skip"
}

/** One file on its way into a drive folder, as kept on disk. */
@Serializable
data class DriveUploadJob(
    val id: String,
    /** The account it belongs to (REVIEW-v0.1.62 #1, as ShareJob): its server, immutable user id and sign-in. */
    val serverUrl: String,
    val userId: String? = null,
    val session: String? = null,
    /** Files added together: 「残りすべてに同じ操作」 answers the rest of the batch. */
    val batchId: String,
    /** Fixed per session (§6.2: the session is one per (user, client_upload_id)); a new one only when the session is gone. */
    val clientUploadId: String,
    val uploadId: String? = null,
    val name: String,
    val size: Long,
    val lastModifiedMs: Long? = null,
    val locationId: String,
    val parentId: String,
    /** 「研究室ドライブ › 論文」 for the panel, the question and the notifications. */
    val label: String = "",
    val state: String = UploadState.QUEUED,
    /** fail (ask on a conflict) → version / rename once answered. */
    val onConflict: String = "fail",
    /** An answer given with 「残りすべてに同じ操作」 for this batch: used at this job's conflict without asking. */
    val presetAnswer: String? = null,
    /** While asking: the kind of what has the name (`folder`: no new version possible) and where the conflict came up. */
    val existingKind: String? = null,
    /** `create` (POST /drive/uploads answered 409) or `complete` (a name taken meanwhile: PATCH then complete again). */
    val conflictStage: String? = null,
    /** The answer to a completion's conflict must be PATCHed onto the session before completing again. */
    val patchConflict: Boolean = false,
    val partSize: Long = 0,
    val partsTotal: Int = 0,
    val received: List<Int> = emptyList(),
    /** The server's error code (or `network`, `read_failed`) while failed or waiting. */
    val error: String? = null,
    val itemId: String? = null,
    val createdAt: Long = 0,
) {
    val isFinished: Boolean get() = state in UploadState.FINISHED

    /** Bytes the server has. */
    val sentBytes: Long get() = if (state == UploadState.DONE) size else DriveUploadRules.sentBytes(received, size, partSize)

    fun accountIn(workspaces: List<jp.chikuwachat.android.app.Workspace>): jp.chikuwachat.android.app.Workspace? =
        workspaces.firstOrNull { it.serverUrl == serverUrl }?.takeIf { it.isAccount(userId, session) }

    companion object {
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        fun encode(job: DriveUploadJob): String = json.encodeToString(serializer(), job)

        fun decode(text: String): DriveUploadJob? = runCatching { json.decodeFromString(serializer(), text) }.getOrNull()
    }
}

/** The plain rules (the desktop's partCount / partRange / missingParts / sentBytes / uploadTotals, and the panel's actions). */
object DriveUploadRules {
    const val RETRY_MIN_MS = 2_000L
    const val RETRY_MAX_MS = 30_000L
    const val COMPLETE_POLL_MS = 2_000L
    /** How often a completion naming parts to send again (409 drive_upload_incomplete) is answered by sending them. */
    const val RESEND_ROUNDS = 3

    fun partCount(size: Long, partSize: Long): Int = if (size <= 0 || partSize <= 0) 0 else ((size + partSize - 1) / partSize).toInt()

    /** Bytes [start, end) of part [number] (from 1). */
    fun partRange(number: Int, size: Long, partSize: Long): Pair<Long, Long> {
        val start = (number - 1).toLong() * partSize
        return start to minOf(size, start + partSize)
    }

    fun missingParts(total: Int, received: Collection<Int>): List<Int> {
        val have = received.toSet()
        return (1..total).filter { it !in have }
    }

    fun sentBytes(received: Collection<Int>, size: Long, partSize: Long): Long {
        if (partSize <= 0) return 0
        return received.toSet().sumOf { n -> partRange(n, size, partSize).let { (s, e) -> if (e > s) e - s else 0L } }
    }

    /** The wait before the [attempt]th try after a temporary failure: 2 s doubling to 30 s. */
    fun backoff(attempt: Int): Long = minOf(RETRY_MIN_MS shl (attempt - 1).coerceIn(0, 10), RETRY_MAX_MS)

    data class Totals(val files: Int, val done: Int, val failed: Int, val bytes: Long, val sent: Long, val pending: Int)

    /** The panel's head: files and bytes of what is not skipped or cancelled; [live] adds the bytes of parts in flight. */
    fun totals(jobs: List<DriveUploadJob>, live: Map<String, Long> = emptyMap()): Totals {
        val counted = jobs.filter { it.state != UploadState.CANCELLED && it.state != UploadState.SKIPPED }
        return Totals(
            files = counted.size,
            done = counted.count { it.state == UploadState.DONE },
            failed = counted.count { it.state == UploadState.FAILED },
            bytes = counted.sumOf { it.size },
            sent = counted.sumOf { job -> if (job.state == UploadState.DONE) job.size else maxOf(job.sentBytes, live[job.id] ?: 0L).coerceAtMost(job.size) },
            pending = counted.count { !it.isFinished && it.state != UploadState.FAILED },
        )
    }

    /** What an answer changes: the jobs to save, and a session to drop (skip after a completion's conflict). */
    data class Answered(val changed: List<DriveUploadJob>, val abort: List<String>)

    /**
     * The person's answer to [jobId]'s conflict. version / rename: the job goes on (made again with the same
     * client_upload_id, or the session PATCHed before completing again); skip: skipped (a made session is dropped).
     * [all]: the same for the rest of the batch — remembered on each, and given at once to those asking already (a
     * folder of that name cannot take a version: such a job keeps its question).
     */
    fun answer(jobs: List<DriveUploadJob>, jobId: String, choice: String, all: Boolean): Answered {
        val job = jobs.firstOrNull { it.id == jobId } ?: return Answered(emptyList(), emptyList())
        val changed = mutableListOf<DriveUploadJob>()
        val abort = mutableListOf<String>()
        fun apply(target: DriveUploadJob) {
            if (target.state != UploadState.ASKING) return
            if (choice == ConflictChoice.VERSION && target.existingKind == "folder") return
            if (choice == ConflictChoice.SKIP) {
                if (target.conflictStage == "complete") target.uploadId?.let { abort += it }
                changed += target.copy(state = UploadState.SKIPPED, existingKind = null, conflictStage = null)
            } else {
                changed += target.copy(
                    state = UploadState.QUEUED, onConflict = choice, existingKind = null, error = null,
                    patchConflict = target.conflictStage == "complete", conflictStage = null,
                )
            }
        }
        apply(job)
        if (all) {
            for (other in jobs) {
                if (other.id == job.id || other.batchId != job.batchId || other.isFinished || other.state == UploadState.FAILED) continue
                if (other.state == UploadState.ASKING) {
                    val before = changed.size
                    apply(other)
                    if (changed.size > before) continue
                }
                changed += other.copy(presetAnswer = choice)
            }
        }
        return Answered(changed, abort)
    }

    /** How many more of [job]'s batch are still to go (「残りすべてに同じ操作（あと n 件）」 shows when > 0). */
    fun remainingInBatch(jobs: List<DriveUploadJob>, job: DriveUploadJob): Int =
        jobs.count { it.batchId == job.batchId && it.id != job.id && !it.isFinished && it.state != UploadState.FAILED }

    /**
     * 「やり直す」 on a failed job: queued again. A session that ended (its folder moved to another drive, §28.1; expired)
     * or a file that could not be read starts over with a new client_upload_id; otherwise the parts the server has stay.
     */
    fun retry(job: DriveUploadJob, newId: () -> String): DriveUploadJob {
        val fresh = job.error in setOf("drive_upload_target_moved", "drive_upload_expired", "drive_upload_not_found")
        return if (fresh) job.copy(state = UploadState.QUEUED, error = null, uploadId = null, clientUploadId = newId(), received = emptyList(), partSize = 0, partsTotal = 0)
        else job.copy(state = UploadState.QUEUED, error = null)
    }
}

/** What one run of a job came to. */
sealed interface UploadOutcome {
    data class Done(val job: DriveUploadJob) : UploadOutcome
    data class Skipped(val job: DriveUploadJob) : UploadOutcome
    /** A name conflict waits for the person (parked as `asking`). */
    data class Asking(val job: DriveUploadJob) : UploadOutcome
    data class Failed(val job: DriveUploadJob, val error: Throwable) : UploadOutcome
    /** Temporary trouble outlasted the quick retries: the work tries again later (the job waits). */
    data class Retry(val job: DriveUploadJob, val error: Throwable) : UploadOutcome
    /** The job went while it ran (cancelled, its account's jobs dropped): [uploadId] is the session to drop, if any. */
    data class Gone(val uploadId: String?) : UploadOutcome
    /** Its account is no longer the one signed in: nothing more is sent in anyone's name. */
    data object Dropped : UploadOutcome
}

/** The copy of the file could not be read. */
class UploadReadError(cause: Throwable) : Exception(cause.message, cause)

/**
 * Runs one job to its end (the desktop's UploadQueue.run, one file): the session (made with `fail` first; a
 * conflict is answered by the batch's preset answer or parks the job as `asking`), the parts the server lacks
 * ([partsAtOnce] at a time, each with its SHA-256), the completion (200, or 202 and a look every 2 s; `not_active`
 * looks too; 409 drive_upload_incomplete sends the named parts again, 3 rounds at most; 409 drive_upload_target_moved
 * fails for good). A network failure, 429 or 5xx waits 2 s doubling to 30 s and asks the session again ([quickRetries]
 * times, then [UploadOutcome.Retry]); a session that expired or is gone starts over with a new client_upload_id.
 *
 * [save] writes the job and answers false once the job is no longer there or was cancelled: the run stops ([UploadOutcome.Gone]).
 */
class DriveUploader(
    private val api: DriveWriteApi,
    private val save: (DriveUploadJob) -> Boolean,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val newId: () -> String = { UUID.randomUUID().toString() },
    /** Bytes the server has plus those of the parts on their way (the panel and the notification). */
    private val progress: (jobId: String, sent: Long) -> Unit = { _, _ -> },
    private val stillOurs: suspend () -> Boolean = { true },
    private val partsAtOnce: Int = 2,
    private val quickRetries: Int = 4,
) {
    private class Gone : Exception("the job went")
    private class AccountChanged : Exception("the account changed")
    private class Parked : Exception("asking")
    private class Finished : Exception("finished")

    suspend fun run(start: DriveUploadJob, bytes: UploadBytes): UploadOutcome = Run(start, bytes).go()

    private inner class Run(var job: DriveUploadJob, val bytes: UploadBytes) {
        private val lock = Mutex()
        private val inFlight = HashMap<Int, Long>()
        private var outcome: UploadOutcome? = null

        private fun put(next: DriveUploadJob) {
            job = next
            if (!save(next)) throw Gone()
        }

        private suspend fun ours() {
            if (!stillOurs()) throw AccountChanged()
        }

        private fun told() = progress(job.id, job.sentBytes + synchronized(inFlight) { inFlight.values.sum() })

        suspend fun go(): UploadOutcome {
            var transient = 0
            var restarts = 0
            while (true) {
                try {
                    ours()
                    put(job.copy(state = UploadState.UPLOADING, error = null))
                    val session = ensureSession()
                    if (session.status != "completing") {
                        sendParts(session)
                        transient = 0
                    }
                    completeWithResends()
                    return outcome ?: UploadOutcome.Done(job)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Finished) {
                    return outcome!!
                } catch (_: Parked) {
                    return UploadOutcome.Asking(job)
                } catch (_: Gone) {
                    return UploadOutcome.Gone(job.uploadId)
                } catch (_: AccountChanged) {
                    return UploadOutcome.Dropped
                } catch (e: Exception) {
                    if (!stillOurs()) return UploadOutcome.Dropped
                    synchronized(inFlight) { inFlight.clear() }
                    try {
                        val code = (e as? ApiException.Api)?.code
                        when {
                            e is UploadReadError -> return fail("read_failed", e)
                            code == "drive_upload_target_moved" -> return fail(code, e) // §28.1: never started again by itself
                            code == "drive_upload_expired" || code == "drive_upload_not_found" -> {
                                // The session is gone (a day without parts, dropped elsewhere): start over with a new one.
                                if (++restarts > 2) return UploadOutcome.Retry(job, e)
                                put(job.copy(uploadId = null, clientUploadId = newId(), received = emptyList(), partSize = 0, partsTotal = 0, patchConflict = false))
                            }
                            transient(e) -> {
                                transient += 1
                                put(job.copy(state = UploadState.WAITING, error = "network"))
                                if (transient > quickRetries) return UploadOutcome.Retry(job, e)
                                sleep(DriveUploadRules.backoff(transient))
                            }
                            else -> return fail(code ?: "unknown", e)
                        }
                    } catch (_: Gone) {
                        return UploadOutcome.Gone(job.uploadId)
                    }
                }
            }
        }

        private fun fail(code: String, e: Throwable): UploadOutcome {
            put(job.copy(state = UploadState.FAILED, error = code))
            return UploadOutcome.Failed(job, e)
        }

        private fun finish(itemId: String?): Nothing {
            put(job.copy(state = UploadState.DONE, itemId = itemId, error = null, received = (1..job.partsTotal).toList()))
            outcome = UploadOutcome.Done(job)
            throw Finished()
        }

        private fun skip(): Nothing {
            put(job.copy(state = UploadState.SKIPPED, existingKind = null, conflictStage = null))
            outcome = UploadOutcome.Skipped(job)
            throw Finished()
        }

        private fun take(session: DriveUploadOut) {
            put(job.copy(uploadId = session.id, partSize = session.partSize, partsTotal = session.partsTotal, received = session.receivedParts.distinct().sorted()))
            told()
        }

        /** The answer for a conflict: the batch's preset (not a version over a folder), or null (ask). */
        private fun preset(kind: String?): String? = job.presetAnswer?.takeUnless { it == ConflictChoice.VERSION && kind == "folder" }

        private fun park(kind: String?, stage: String): Nothing {
            put(job.copy(state = UploadState.ASKING, existingKind = kind, conflictStage = stage))
            throw Parked()
        }

        private suspend fun ensureSession(): DriveUploadOut {
            job.uploadId?.let { id ->
                val session = api.driveUpload(id)
                when {
                    session.status == "completed" -> finish(session.itemId)
                    session.status == "aborted" && session.error == "drive_upload_target_moved" -> throw ApiException.Api(409, session.error, session.error)
                    session.status == "expired" || session.status == "aborted" -> throw ApiException.Api(410, "drive_upload_expired", "expired")
                }
                take(session)
                return session
            }
            while (true) {
                ours()
                try {
                    val session = api.createDriveUpload(job.clientUploadId, job.parentId, job.name, job.size, job.lastModifiedMs, job.onConflict)
                    take(session)
                    return session
                } catch (e: ApiException.Api) {
                    if (e.code != "drive_name_taken" || job.onConflict == ConflictChoice.RENAME) throw e
                    val kind = existingKind(e)
                    // fail asks; a version over a folder of that name cannot be (409 again): asked too, without 「上書き」.
                    if (job.onConflict == ConflictChoice.VERSION && kind != "folder") throw e
                    val choice = preset(kind) ?: park(kind, "create")
                    if (choice == ConflictChoice.SKIP) skip()
                    put(job.copy(onConflict = choice))
                }
            }
        }

        private suspend fun sendParts(session: DriveUploadOut) {
            val todo = DriveUploadRules.missingParts(job.partsTotal, job.received)
            if (todo.isEmpty()) return
            var next = 0
            coroutineScope {
                repeat(minOf(partsAtOnce, todo.size).coerceAtLeast(1)) {
                    launch {
                        while (true) {
                            val number = lock.withLock { todo.getOrNull(next++) } ?: break
                            ours()
                            val (start, end) = DriveUploadRules.partRange(number, job.size, job.partSize)
                            val sha = try { bytes.sha256(start, end) } catch (e: java.io.IOException) { throw UploadReadError(e) }
                            api.putDrivePart(session.id, number, bytes, start, end, sha) { sent ->
                                synchronized(inFlight) { inFlight[number] = sent }
                                told()
                            }
                            lock.withLock {
                                synchronized(inFlight) { inFlight.remove(number) }
                                put(job.copy(received = (job.received + number).distinct().sorted(), state = UploadState.UPLOADING, error = null))
                            }
                            told()
                        }
                    }
                }
            }
        }

        private suspend fun completeWithResends() {
            var round = 1
            while (true) {
                try {
                    complete()
                    return
                } catch (e: ApiException.Api) {
                    // Parts the server no longer counts (REVIEW-v0.1.70 #5): send them again, then complete again.
                    if (e.code != "drive_upload_incomplete" || round > DriveUploadRules.RESEND_ROUNDS) throw e
                    round += 1
                    val fresh = api.driveUpload(job.uploadId!!)
                    take(fresh)
                    put(job.copy(state = UploadState.UPLOADING))
                    sendParts(fresh)
                }
            }
        }

        private suspend fun complete() {
            val uploadId = job.uploadId!!
            if (job.patchConflict) {
                ours()
                api.patchDriveUpload(uploadId, job.onConflict)
                put(job.copy(patchConflict = false))
            }
            put(job.copy(state = UploadState.COMPLETING))
            while (true) {
                ours()
                val answer = try {
                    api.completeDriveUpload(uploadId)
                } catch (e: ApiException.Api) {
                    when {
                        e.code == "drive_name_taken" && job.onConflict != ConflictChoice.RENAME -> {
                            // A name taken meanwhile (mode fail): the session stays active; asked, then PATCHed.
                            val kind = existingKind(e)
                            if (job.onConflict == ConflictChoice.VERSION && kind != "folder") throw e
                            val choice = preset(kind) ?: park(kind, "complete")
                            if (choice == ConflictChoice.SKIP) {
                                runCatching { api.abortDriveUpload(uploadId) }
                                skip()
                            }
                            api.patchDriveUpload(uploadId, choice)
                            put(job.copy(onConflict = choice, state = UploadState.COMPLETING))
                            continue
                        }
                        e.code == "drive_upload_not_active" -> DriveUploadCompleteOut("completing") // completing already: look
                        else -> throw e
                    }
                }
                if (answer.status == "completed") finish(answer.item?.id)
                // 202: the parts are being joined; look again until the session says how it ended.
                while (true) {
                    sleep(DriveUploadRules.COMPLETE_POLL_MS)
                    ours()
                    val session = api.driveUpload(uploadId)
                    when (session.status) {
                        "completed" -> finish(session.itemId)
                        "completing" -> continue
                        "active" -> {
                            val error = session.error
                            if (error != null && !(error == "drive_name_taken" && job.onConflict != ConflictChoice.RENAME)) throw ApiException.Api(409, error, error)
                            break // complete again (a name taken asks there)
                        }
                        "aborted" -> if (session.error == "drive_upload_target_moved") throw ApiException.Api(409, session.error, session.error)
                            else throw ApiException.Api(410, "drive_upload_expired", "expired")
                        else -> throw ApiException.Api(410, "drive_upload_expired", "expired")
                    }
                }
            }
        }
    }

    companion object {
        /** Network trouble or a server briefly unwell: wait and go on (the parts it has are kept). */
        fun transient(e: Throwable): Boolean = e is ApiException.Network || (e is ApiException.Api && e.isRetryable)

        fun existingKind(e: ApiException.Api): String? =
            ((e.details as? JsonObject)?.get("existing_kind") as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

/**
 * The jobs on disk: `<root>/<id>/job.json` (written to a temporary file and renamed) and the copy `<root>/<id>/data`.
 * Every change goes through one lock, so a cancel and the worker's next save never cross: [update] writes only while
 * the job is there and not cancelled.
 */
class DriveUploadJobs(val root: File) {
    private val lock = Any()

    fun dir(id: String): File = File(root, id)

    fun data(id: String): File = File(dir(id), DATA_FILE)

    fun read(id: String): DriveUploadJob? = synchronized(lock) { readUnlocked(id) }

    private fun readUnlocked(id: String): DriveUploadJob? =
        runCatching { File(dir(id), JOB_FILE).takeIf { it.isFile }?.readText() }.getOrNull()?.let { DriveUploadJob.decode(it) }

    fun all(): List<DriveUploadJob> = synchronized(lock) {
        root.listFiles()?.mapNotNull { readUnlocked(it.name) }.orEmpty().sortedBy { it.createdAt }
    }

    fun save(job: DriveUploadJob) = synchronized(lock) { write(job) }

    private fun write(job: DriveUploadJob) {
        val dir = dir(job.id).apply { mkdirs() }
        val tmp = File(dir, "$JOB_FILE.tmp")
        tmp.writeText(DriveUploadJob.encode(job))
        if (!tmp.renameTo(File(dir, JOB_FILE))) {
            File(dir, JOB_FILE).writeText(DriveUploadJob.encode(job))
            tmp.delete()
        }
    }

    /** The worker's save: false (nothing written) once the job is gone or was cancelled. */
    fun update(job: DriveUploadJob): Boolean = synchronized(lock) {
        val held = readUnlocked(job.id) ?: return@synchronized false
        if (held.state == UploadState.CANCELLED) return@synchronized false
        // An answer or a retry given meanwhile is not overwritten by a run that is ending.
        write(job.copy(presetAnswer = held.presetAnswer ?: job.presetAnswer))
        true
    }

    /** Changes a job under the lock (the panel's actions); null when it is gone. */
    fun change(id: String, block: (DriveUploadJob) -> DriveUploadJob?): DriveUploadJob? = synchronized(lock) {
        val held = readUnlocked(id) ?: return@synchronized null
        val next = block(held) ?: return@synchronized null
        write(next)
        next
    }

    fun delete(id: String) = synchronized(lock) { dir(id).deleteRecursively() }

    /** The copy of a finished job is not needed any more (its row stays in the panel until cleared). */
    fun dropData(id: String) {
        data(id).delete()
    }

    /** REVIEW-v0.1.62 #1: [serverUrl]'s jobs not of [keepUserId] (all when null) go, with their copies. */
    fun dropAccount(serverUrl: String, keepUserId: String? = null): List<DriveUploadJob> = synchronized(lock) {
        val dropped = mutableListOf<DriveUploadJob>()
        root.listFiles()?.forEach { dir ->
            val job = readUnlocked(dir.name) ?: return@forEach
            if (job.serverUrl != serverUrl || (keepUserId != null && job.userId == keepUserId)) return@forEach
            dir.deleteRecursively()
            dropped += job
        }
        dropped
    }

    /**
     * At start: a job still `preparing` was being copied by a process that is gone (its grant went with it): it
     * fails with read_failed. Finished jobs older than [keepFinishedMs] and folders without a job go.
     */
    fun tidy(now: Long, keepFinishedMs: Long = 24 * 3600_000L, preparingHere: Set<String> = emptySet()) = synchronized(lock) {
        root.listFiles()?.forEach { dir ->
            val job = readUnlocked(dir.name)
            when {
                job == null -> if (now - dir.lastModified() > 3600_000L) dir.deleteRecursively()
                job.state == UploadState.PREPARING && job.id !in preparingHere -> {
                    write(job.copy(state = UploadState.FAILED, error = "read_failed"))
                    File(dir, DATA_FILE).delete()
                }
                job.isFinished && now - File(dir, JOB_FILE).lastModified() > keepFinishedMs -> dir.deleteRecursively()
            }
        }
    }

    /**
     * 取りやめる: the job is marked cancelled (a running upload's next save fails, so it stops) and its copy goes; then
     * the server's session is dropped (DELETE /drive/uploads/{id}; one left behind expires within a day anyway).
     * Returns the cancelled job (null: gone or finished already).
     */
    suspend fun cancel(id: String, api: suspend () -> DriveWriteApi?): DriveUploadJob? {
        val job = change(id) { if (it.isFinished) null else it.copy(state = UploadState.CANCELLED) } ?: return null
        dropData(id)
        val uploadId = job.uploadId ?: return job
        try {
            api()?.abortDriveUpload(uploadId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
        return job
    }

    companion object {
        const val JOB_FILE = "job.json"
        const val DATA_FILE = "data"
    }
}
