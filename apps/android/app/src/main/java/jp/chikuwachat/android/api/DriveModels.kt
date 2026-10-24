package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

/*
 * M166 (docs/DRIVE.md §5, §26, the phones' D7): 「ドライブ」, read only on the phone. The shapes are openapi.json's
 * DriveLocationOut / DriveItemOut / DriveFileOut / DriveCrumb / DriveItemDetailOut / DriveChildrenOut / DriveSearchOut /
 * DriveDownloadTicketOut / DriveZipOut. Plain @Serializable data only (R8: no reflection). Defaults keep a row decodable
 * when a field is absent (an older server, a test's fixture).
 */

/** A place files live (§3.1): 研究室ドライブ (`workspace`), a channel's drive (`channel`), マイドライブ (`user`). */
@Serializable
data class DriveLocationOut(
    val id: String,
    /** workspace | channel | user. */
    val kind: String,
    val channelId: String? = null,
    val userId: String? = null,
    val rootId: String,
    /** The server's name (in Japanese for the workspace's and mine; the channel's name for a channel): see DriveNames. */
    val name: String = "",
    val canWrite: Boolean = false,
    val canManage: Boolean = false,
    val canShare: Boolean = false,
    val externalLinks: Boolean = false,
    val quotaBytes: Long? = null,
    val usedBytes: Long = 0,
    val itemCount: Long = 0,
)

@Serializable
data class DriveLocationListOut(val locations: List<DriveLocationOut> = emptyList())

/** The current version's attachment: its thumbnail, poster and preview are /attachments/{attachment_id}/… (§5.2). */
@Serializable
data class DriveFileOut(
    val attachmentId: String,
    val versionId: String = "",
    val width: Int? = null,
    val height: Int? = null,
    val hasThumbnail: Boolean = false,
    val hasPoster: Boolean = false,
    val durationMs: Long? = null,
    val preview: AttachmentPreviewOut? = null,
)

@Serializable
data class DriveItemOut(
    val id: String,
    val locationId: String = "",
    val parentId: String? = null,
    /** folder | file. */
    val kind: String = "file",
    val name: String = "",
    val sizeBytes: Long? = null,
    val contentType: String? = null,
    val contentModifiedAt: String? = null,
    val createdBy: String? = null,
    val createdAt: String = "",
    val updatedBy: String? = null,
    val updatedAt: String = "",
    val versionCount: Int = 0,
    val file: DriveFileOut? = null,
    val linkCount: Int = 0,
) {
    val isFolder: Boolean get() = kind == "folder"
}

/** One step of an item's path, from the location's root (whose name is the location's). */
@Serializable
data class DriveCrumb(val id: String, val name: String = "")

/** GET /drive/items/{id}: the item, its path (root first, the item's own folder last) and its location's kind (§25.1). */
@Serializable
data class DriveItemDetailOut(val item: DriveItemOut, val path: List<DriveCrumb> = emptyList(), val locationKind: String? = null)

/** GET /drive/folders/{id}/children: one page of a folder (folders first), with the folder and its path. */
@Serializable
data class DriveChildrenOut(
    val folder: DriveItemOut,
    val path: List<DriveCrumb> = emptyList(),
    val items: List<DriveItemOut> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class DriveSearchHitOut(
    val item: DriveItemOut,
    val path: List<DriveCrumb> = emptyList(),
    val locationKind: String = "workspace",
    /** §29: what matched (`name`, `content`, `both`); null from a server before it. */
    val match: String? = null,
    /** §29: the text around the match inside the file, in pieces; `hit` pieces are the words found. */
    val snippet: List<DriveSnippetPart>? = null,
    /** §29: the PDF page the snippet is on (from 1). */
    val page: Int? = null,
) {
    /** The snippet as one line (null for a name match). */
    val snippetText: String? get() = snippet?.takeIf { it.isNotEmpty() }?.joinToString("") { it.text }
}

/** A piece of a drive search snippet (docs/DRIVE.md §29): plain text, never markup. */
@Serializable
data class DriveSnippetPart(val text: String, val hit: Boolean = false)

@Serializable
data class DriveSearchOut(val items: List<DriveSearchHitOut> = emptyList(), val nextCursor: String? = null)

/** §21.2: a URL (relative to the server) that serves the file without the bearer token, with Range, while used. */
@Serializable
data class DriveDownloadTicketOut(val url: String, val expiresIn: Int = 0)

/** §22: a one-shot URL streaming an uncompressed ZIP exactly `zip_bytes` long. */
@Serializable
data class DriveZipOut(
    val url: String,
    val expiresIn: Int = 0,
    val entries: Int = 0,
    val sizeBytes: Long = 0,
    val zipBytes: Long = 0,
    val filename: String = "download.zip",
)

/*
 * 2026-10-24 (docs/DRIVE.md §6, §27.3, §28): uploads from the phone and the preview a viewer asks for. openapi.json's
 * DriveUploadOut / DriveUploadListOut / DriveUploadCompleteOut / DriveUploadPartOut / DrivePreviewOut.
 */

/** A resumable upload session (§5.3): the parts the server has (`received_parts`) are never sent again. */
@Serializable
data class DriveUploadOut(
    val id: String,
    val clientUploadId: String = "",
    /** active | completing | completed | aborted | expired. */
    val status: String = "active",
    val locationId: String = "",
    val parentId: String = "",
    val name: String = "",
    val onConflict: String = "fail",
    val partSize: Long = 16L * 1024 * 1024,
    val partsTotal: Int = 0,
    val receivedParts: List<Int> = emptyList(),
    val sizeBytes: Long = 0,
    val expiresAt: String = "",
    val itemId: String? = null,
    val versionId: String? = null,
    /** Why an active session could not complete (drive_name_taken, drive_upload_incomplete) or why it ended (drive_upload_target_moved). */
    val error: String? = null,
)

@Serializable
data class DriveUploadListOut(val uploads: List<DriveUploadOut> = emptyList())

/** POST /drive/uploads/{id}/complete: 200 `completed` (the item; null when I cannot read it any more, §28.3) or 202 `completing`. */
@Serializable
data class DriveUploadCompleteOut(val status: String, val item: DriveItemOut? = null, val versionId: String? = null)

@Serializable
data class DriveUploadPartOut(val partNumber: Int, val sizeBytes: Long = 0)

/** POST /drive/items/{id}/preview (§27.3): pending / ready / failed, or null when this file gets no preview. */
@Serializable
data class DrivePreviewOut(val preview: AttachmentPreviewOut? = null)
