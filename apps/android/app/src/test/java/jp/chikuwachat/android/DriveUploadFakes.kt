package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DrivePreviewOut
import jp.chikuwachat.android.api.DriveUploadCompleteOut
import jp.chikuwachat.android.api.DriveUploadOut
import jp.chikuwachat.android.api.DriveUploadPartOut
import jp.chikuwachat.android.sync.DriveUploadJob
import jp.chikuwachat.android.sync.DriveUploadRules
import jp.chikuwachat.android.sync.DriveUploader
import jp.chikuwachat.android.sync.DriveWriteApi
import jp.chikuwachat.android.sync.UploadBytes
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.security.MessageDigest

/** Test helpers of DriveUploadTest: in-memory bytes, a scriptable fake of the upload endpoints, a job. */
internal fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

internal class MemoryBytes(private val data: ByteArray) : UploadBytes {
    override fun sha256(start: Long, end: Long): String = sha256Hex(data.copyOfRange(start.toInt(), end.toInt()))
    override fun open(start: Long, end: Long): InputStream = ByteArrayInputStream(data.copyOfRange(start.toInt(), end.toInt()))
}

internal data class SentPart(val uploadId: String, val number: Int, val bytes: List<Byte>, val sha: String)

internal class FakeUploadServer(private val partSize: Long = 4) : DriveWriteApi {
    val sessions = LinkedHashMap<String, DriveUploadOut>()
    /** Names already in the folder, by kind. */
    val taken = HashMap<String, String>()
    val parts = mutableListOf<SentPart>()
    /** (client_upload_id, on_conflict) of each create. */
    val creates = mutableListOf<Pair<String, String>>()
    val patches = mutableListOf<Pair<String, String>>()
    val aborted = mutableListOf<String>()
    var completes = 0
    var gets = 0
    /** Scripted completion answers in turn; a step answering null follows the usual rule. */
    val completeSteps = ArrayDeque<(DriveUploadOut) -> DriveUploadCompleteOut?>()
    /** Scripted session states for GET in turn; null keeps the session as it is. */
    val getSteps = ArrayDeque<(DriveUploadOut) -> DriveUploadOut?>()
    var partFailure: ((Int) -> Throwable?)? = null
    private var counter = 0

    private fun taken(kind: String) = ApiException.Api(409, "drive_name_taken", "taken", buildJsonObject { put("existing_kind", JsonPrimitive(kind)) })

    override suspend fun createDriveUpload(clientUploadId: String, parentId: String, name: String, sizeBytes: Long, contentModifiedMs: Long?, onConflict: String): DriveUploadOut {
        creates += clientUploadId to onConflict
        sessions.values.firstOrNull { it.clientUploadId == clientUploadId && it.status == "active" }?.let { return it }
        val kind = taken[name]
        if (kind != null && (onConflict == "fail" || (onConflict == "version" && kind == "folder"))) throw taken(kind)
        val made = DriveUploadOut(
            id = "u${++counter}", clientUploadId = clientUploadId, parentId = parentId, name = name, onConflict = onConflict,
            partSize = partSize, partsTotal = DriveUploadRules.partCount(sizeBytes, partSize), sizeBytes = sizeBytes,
        )
        sessions[made.id] = made
        return made
    }

    override suspend fun driveUpload(uploadId: String): DriveUploadOut {
        gets++
        val held = sessions[uploadId] ?: throw ApiException.Api(404, "drive_upload_not_found", "gone")
        getSteps.removeFirstOrNull()?.invoke(held)?.let { sessions[uploadId] = it }
        return sessions.getValue(uploadId)
    }

    override suspend fun patchDriveUpload(uploadId: String, onConflict: String): DriveUploadOut {
        patches += uploadId to onConflict
        val next = sessions.getValue(uploadId).copy(onConflict = onConflict)
        sessions[uploadId] = next
        return next
    }

    override suspend fun putDrivePart(uploadId: String, number: Int, bytes: UploadBytes, start: Long, end: Long, sha256Hex: String, sent: (Long) -> Unit): DriveUploadPartOut {
        partFailure?.invoke(number)?.let { throw it }
        val body = bytes.open(start, end).readBytes()
        check(sha256Hex(body) == sha256Hex) { "X-Content-SHA256 does not match part $number" }
        parts += SentPart(uploadId, number, body.toList(), sha256Hex)
        sent(body.size.toLong())
        val held = sessions.getValue(uploadId)
        sessions[uploadId] = held.copy(receivedParts = (held.receivedParts + number).distinct().sorted())
        return DriveUploadPartOut(number, body.size.toLong())
    }

    override suspend fun completeDriveUpload(uploadId: String): DriveUploadCompleteOut {
        completes++
        val held = sessions.getValue(uploadId)
        completeSteps.removeFirstOrNull()?.invoke(held)?.let { return it }
        val missing = DriveUploadRules.missingParts(held.partsTotal, held.receivedParts)
        if (missing.isNotEmpty()) throw ApiException.Api(409, "drive_upload_incomplete", "missing")
        val kind = taken[held.name]
        if (kind != null && (held.onConflict == "fail" || (held.onConflict == "version" && kind == "folder"))) throw taken(kind)
        sessions[uploadId] = held.copy(status = "completed", itemId = "item-$uploadId")
        return DriveUploadCompleteOut("completed", DriveItemOut(id = "item-$uploadId", name = held.name))
    }

    override suspend fun abortDriveUpload(uploadId: String) {
        aborted += uploadId
        sessions[uploadId]?.let { sessions[uploadId] = it.copy(status = "aborted") }
    }

    override suspend fun createDriveFolder(parentId: String, name: String, clientOpId: String): DriveItemOut = DriveItemOut(id = clientOpId, name = name, kind = "folder")

    override suspend fun requestDrivePreview(itemId: String): DrivePreviewOut = DrivePreviewOut(null)
}

internal fun uploadJob(size: Long, name: String = "a.bin", batch: String = "b1") = DriveUploadJob(
    id = "j-$name", serverUrl = "http://s", userId = "me", batchId = batch, clientUploadId = "c-$name", name = name, size = size,
    locationId = "loc", parentId = "folder", label = "研究室ドライブ › 論文",
)

/** An engine over [server] recording what it saved and how long it waited. */
internal class UploadHarness(val server: FakeUploadServer, private val partsAtOnce: Int = 1) {
    val saved = mutableListOf<DriveUploadJob>()
    val waits = mutableListOf<Long>()
    var keep: (DriveUploadJob) -> Boolean = { true }
    private var ids = 0
    val uploader = DriveUploader(server, save = { saved += it; keep(it) }, sleep = { waits += it }, newId = { "new-${++ids}" }, partsAtOnce = partsAtOnce)
}
