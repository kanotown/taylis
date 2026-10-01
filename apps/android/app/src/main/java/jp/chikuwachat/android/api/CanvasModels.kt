package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

/*
 * Canvases (CANVAS.md; the server in M41 / M42, this client in M46): Markdown documents of a conversation, saved whole
 * with the version they were written on and merged on the server (§4.4). The canvas.* events carry the metadata only
 * (§4.6). The shapes are openapi.json's CanvasMeta / CanvasOut / SaveOut / CanvasConflictDetails / CanvasTemplateOut.
 */

/** A canvas without its body: lists and the canvas.* events. */
@Serializable
data class CanvasMeta(
    val id: String,
    val channelId: String,
    val title: String,
    val version: Long,
    val headRevId: String,
    val isChannelTab: Boolean = false,
    /** "members" | "owners" (the creator, owners and administrators change the body; everyone ticks). */
    val editPolicy: String = "members",
    val templateKey: String? = null,
    val shareMessageId: String? = null,
    val taskTotal: Int = 0,
    val taskDone: Int = 0,
    val createdBy: String,
    val updatedBy: String,
    val createdAt: String,
    val updatedAt: String,
    /** Only in the trash's list. */
    val deletedAt: String? = null,
)

/** A canvas with its body (GET /canvases/{id}, create, save, restore). */
@Serializable
data class CanvasOut(
    val id: String,
    val channelId: String,
    val title: String,
    val version: Long,
    val headRevId: String,
    val isChannelTab: Boolean = false,
    val editPolicy: String = "members",
    val templateKey: String? = null,
    val shareMessageId: String? = null,
    val taskTotal: Int = 0,
    val taskDone: Int = 0,
    val createdBy: String,
    val updatedBy: String,
    val createdAt: String,
    val updatedAt: String,
    val deletedAt: String? = null,
    val body: String = "",
) {
    val meta: CanvasMeta
        get() = CanvasMeta(
            id, channelId, title, version, headRevId, isChannelTab, editPolicy, templateKey, shareMessageId, taskTotal, taskDone,
            createdBy, updatedBy, createdAt, updatedAt, deletedAt,
        )

    /** New metadata over this body (an event or a PATCH answer that brought no body). */
    fun withMeta(meta: CanvasMeta): CanvasOut = copy(
        title = meta.title, version = meta.version, headRevId = meta.headRevId, isChannelTab = meta.isChannelTab, editPolicy = meta.editPolicy,
        templateKey = meta.templateKey, shareMessageId = meta.shareMessageId, taskTotal = meta.taskTotal, taskDone = meta.taskDone,
        updatedBy = meta.updatedBy, updatedAt = meta.updatedAt, deletedAt = meta.deletedAt,
    )
}

/** PUT /canvases/{id}/content's answer: the canvas now, and the version holding exactly what was sent. */
@Serializable
data class CanvasSaveOut(val canvas: CanvasOut, val submittedRevId: String, val merged: Boolean = false)

/** One place both sides changed: the base's text, mine, theirs (and the first line of each in its body). */
@Serializable
data class CanvasConflict(val base: String = "", val ours: String = "", val theirs: String = "", val oursLine: Int = 0, val theirsLine: Int = 0)

/** 409 canvas_conflict / canvas_base_expired: `details` of the error envelope. */
@Serializable
data class CanvasConflictDetails(val head: CanvasOut, val conflicts: List<CanvasConflict> = emptyList(), val timedOut: Boolean = false)

@Serializable
data class CanvasTemplateOut(
    val id: String,
    val key: String,
    val name: String,
    val description: String? = null,
    val title: String = "",
    val body: String = "",
    val position: Int = 0,
    val builtin: Boolean = false,
    val hidden: Boolean = false,
)

/** A version in the history list (no body). `kind`: create | save | merge | side | restore | erased. */
@Serializable
data class CanvasRevisionMeta(
    val id: String,
    val canvasId: String,
    val version: Long? = null,
    val kind: String,
    /** M58: the version it was written on (the comparison's 「前の版」 for the oldest one listed). */
    val parentRevId: String? = null,
    val authorId: String,
    val title: String = "",
    val label: String? = null,
    val linesAdded: Int = 0,
    val linesRemoved: Int = 0,
    val createdAt: String,
)

@Serializable
data class CanvasRevisionPage(val items: List<CanvasRevisionMeta> = emptyList(), val nextCursor: String? = null)

@Serializable
data class CanvasRevisionOut(
    val id: String,
    val canvasId: String,
    val version: Long? = null,
    val kind: String,
    val authorId: String,
    val title: String = "",
    val label: String? = null,
    val createdAt: String,
    val body: String = "",
)

/** M58 (CANVAS.md §4.8): one canvas found by GET /search/canvases, with the server's plain-text excerpt. */
@Serializable
data class CanvasSearchHit(val canvas: CanvasMeta, val snippet: String = "", val score: Double = 0.0)

@Serializable
data class CanvasSearchOut(
    val hits: List<CanvasSearchHit> = emptyList(),
    val keywords: List<String> = emptyList(),
    val filters: SearchFilters? = null,
    val limit: Int = 0,
    val offset: Int = 0,
    val hasMore: Boolean = false,
    val total: Int = 0,
    val totalCapped: Boolean = false,
)

/** M58: GET /search/canvases parameters (the message search's words, person, conversation and dates; no has: / thread). */
data class CanvasSearchRequest(
    val q: String,
    val channelId: String? = null,
    /** The canvas's creator or its last editor. */
    val fromUserId: String? = null,
    val after: String? = null,
    val before: String? = null,
    val sort: String = "relevance",
)
