package jp.chikuwachat.android.share

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.isRefusal
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * MOBILE_UI.md §20.4: one share on its way, saved as `job.json` next to the copies of its files
 * (`filesDir/share/<id>/`) so that the background work ([ShareWorker]) can upload and post it after the share screen
 * closed, after a retry and after the process was killed. The message's idempotency key is made once, here, so a retried
 * post never makes a second message (SYNC_PROTOCOL.md §9).
 */
@Serializable
data class ShareJob(
    val id: String,
    /** The workspace (its server URL, the list key, WORKSPACES.md §4). */
    val serverUrl: String,
    /**
     * The account that shared it (REVIEW-v0.1.62 #1): its immutable user id and its sign-in (Workspace.session). The
     * job runs only while that account is the one signed in to [serverUrl], never as whoever signed in there next. A
     * job saved by an older version has no user id and is not sent.
     */
    val userId: String? = null,
    val session: String? = null,
    val channelId: String,
    /** For the notifications (「#general に送信しました」). */
    val channelTitle: String,
    val body: String,
    val clientMsgId: String,
    val files: List<ShareJobFile> = emptyList(),
    /** The uploads were made again once already because the server no longer took the first ones (§20.4). */
    val reuploaded: Boolean = false,
) {
    /**
     * REVIEW-v0.1.62 #1: the entry of [workspaces] this job may run in — its server, signed in as its account in its
     * sign-in ([Workspace.isAccount]); null when that account signed out or another one signed in there since.
     */
    fun accountIn(workspaces: List<jp.chikuwachat.android.app.Workspace>): jp.chikuwachat.android.app.Workspace? =
        workspaces.firstOrNull { it.serverUrl == serverUrl }?.takeIf { it.isAccount(userId, session) }

    /** Bytes still to upload. */
    val pendingBytes: Long get() = files.filter { it.attachmentId == null }.sumOf { it.size }

    companion object {
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        fun encode(job: ShareJob): String = json.encodeToString(serializer(), job)

        fun decode(text: String): ShareJob? = runCatching { json.decodeFromString(serializer(), text) }.getOrNull()
    }
}

/** A copied file: [path] is its name inside the job's directory; [attachmentId] once uploaded (still pending). */
@Serializable
data class ShareJobFile(
    val path: String,
    val name: String,
    val mime: String? = null,
    val size: Long,
    val attachmentId: String? = null,
)

/** What the sender needs from the server (the workspace's ApiClient in the app, a fake in ShareTest). */
interface ShareApi {
    /** POST /attachments for one copied file; returns the pending attachment's id. [sent] gets the bytes written so far. */
    suspend fun upload(job: ShareJob, file: ShareJobFile, sent: (Long) -> Unit): String

    /** POST /channels/{id}/messages with the job's key; a replay answers with the message made the first time. */
    suspend fun post(channelId: String, clientMsgId: String, body: String, attachmentIds: List<String>): MessageOut
}

/** A copied file that is gone (the app's storage was cleared): the share cannot be finished. */
class ShareFileMissing(name: String) : Exception("missing copy of $name")

sealed interface ShareOutcome {
    data class Posted(val message: MessageOut) : ShareOutcome
    /** Temporary (network, 429, 5xx): try again later; what was uploaded is kept. */
    data class Retry(val error: Throwable) : ShareOutcome
    /** Refused (a 4xx, signed out, a missing file): the share ends with a notification. */
    data class Failed(val error: Throwable) : ShareOutcome
    /** Its account is no longer the one signed in (signed out, another person signed in): dropped, nothing sent as another. */
    data object Dropped : ShareOutcome
}

/**
 * Uploads the job's files that have no attachment id yet (each id is saved at once, so a retry uploads only the rest),
 * then posts one message with all of them and the text under the job's idempotency key.
 *
 * Pending uploads that the server no longer takes (`attachment_invalid`: removed after 24 hours unused, SECURITY.md §4)
 * are uploaded again once; a second refusal ends the share.
 */
class ShareSender(
    private val api: ShareApi,
    private val save: (ShareJob) -> Unit,
    private val progress: (sent: Long, total: Long) -> Unit = { _, _ -> },
    /**
     * Whether the job's account is still the one signed in (REVIEW-v0.1.62 #1): asked before every call and after every
     * answer, so an account change half-way (a sign-out, another person signing in) stops the share there.
     */
    private val stillOurs: suspend () -> Boolean = { true },
) {
    private class AccountChanged : Exception("the share's account is no longer signed in")

    private suspend fun ensureOurs() {
        if (!stillOurs()) throw AccountChanged()
    }

    suspend fun run(start: ShareJob): ShareOutcome {
        var job = start
        while (true) {
            try {
                val total = job.pendingBytes
                var done = 0L
                job.files.forEachIndexed { index, file ->
                    if (file.attachmentId != null) return@forEachIndexed
                    ensureOurs()
                    val id = api.upload(job, file) { sent -> progress(done + sent, total) }
                    ensureOurs()
                    done += file.size
                    progress(done, total)
                    job = job.copy(files = job.files.toMutableList().also { it[index] = file.copy(attachmentId = id) })
                    save(job)
                }
                ensureOurs()
                val message = api.post(job.channelId, job.clientMsgId, job.body, job.files.mapNotNull { it.attachmentId })
                ensureOurs()
                return ShareOutcome.Posted(message)
            } catch (e: CancellationException) {
                throw e
            } catch (_: AccountChanged) {
                return ShareOutcome.Dropped
            } catch (e: Exception) {
                // A failure after the account changed comes from that change: nothing to retry or to report.
                if (!stillOurs()) return ShareOutcome.Dropped
                if (e is ApiException.Api && e.code == "attachment_invalid" && !job.reuploaded && job.files.isNotEmpty()) {
                    job = job.copy(reuploaded = true, files = job.files.map { it.copy(attachmentId = null) })
                    save(job)
                    continue
                }
                return outcome(e)
            }
        }
    }

    companion object {
        /** A refusal or a lost session ends the share; a network failure, 429 or 5xx waits for a retry. */
        fun outcome(e: Throwable): ShareOutcome = when {
            e is ShareFileMissing -> ShareOutcome.Failed(e)
            e is ApiException.Api && e.isAuth -> ShareOutcome.Failed(e) // the refresh was refused: signed out
            e.isRefusal() -> ShareOutcome.Failed(e)
            e is ApiException -> ShareOutcome.Retry(e)
            else -> ShareOutcome.Failed(e)
        }
    }
}
