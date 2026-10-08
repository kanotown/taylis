package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

/*
 * M122 (docs/WIKI.md §14.2, SYNC_PROTOCOL.md §17): 「ドキュメント」 — the workspace's tree of pages. The server (M120) gives
 * each person the pages they can read with their own level; bodies are saved like canvases (CANVAS.md §4.4) on the
 * /wiki endpoints. The shapes are openapi.json's PageItem / PageOut / TreeOut / ChangesOut / PageSaveOut /
 * PageConflictDetails / PageRef / PageSearchOut. Plain @Serializable data only (R8: no reflection).
 */

/** A page as I see it (the tree, the change feed, search, children, backlinks), without its body. */
@Serializable
data class PageItem(
    val id: String,
    /** Null: top level, or (for me) a page whose parent I cannot read — it shows at the top level (WIKI.md §4.6). */
    val parentId: String? = null,
    /** The order among siblings: compared as bytes, ties by id. */
    val position: String = "",
    /** page | database | row (rows never come in the tree). */
    val kind: String = "page",
    val title: String = "",
    /** One emoji or a :custom: emoji name; null for none. */
    val icon: String? = null,
    val version: Long = 0,
    val headRevId: String = "",
    val metaSeq: Long = 0,
    val inheritAccess: Boolean = true,
    val taskTotal: Int = 0,
    val taskDone: Int = 0,
    val createdBy: String = "",
    val updatedBy: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val deletedAt: String? = null,
    /** view | edit | full (absent from wiki.page.updated's PageMeta). */
    val myLevel: String = "view",
    /** Only I can see it: the tree's 「プライベート」 when it is top-level for me. */
    val private: Boolean = false,
    /** M145/M146: a template (a top-level page, or a database's row template); never in the tree. */
    val isTemplate: Boolean = false,
)

/** An ancestor in the breadcrumbs (root first). One I cannot read has no id, title or icon (「…」). */
@Serializable
data class PageCrumb(val id: String? = null, val title: String? = null, val icon: String? = null, val readable: Boolean = false)

/** GET /wiki/pages/{id} (and a create's answer): the page, its body, its breadcrumbs and its readable children. */
@Serializable
data class PageOut(
    val id: String,
    val parentId: String? = null,
    val position: String = "",
    val kind: String = "page",
    val title: String = "",
    val icon: String? = null,
    val version: Long = 0,
    val headRevId: String = "",
    val metaSeq: Long = 0,
    val inheritAccess: Boolean = true,
    val taskTotal: Int = 0,
    val taskDone: Int = 0,
    val createdBy: String = "",
    val updatedBy: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val deletedAt: String? = null,
    val myLevel: String = "view",
    val private: Boolean = false,
    /** M146: a template page (its banner) or a row template. */
    val isTemplate: Boolean = false,
    val body: String = "",
    /** Absent from a save's answer and a conflict's head (PageContent). */
    val breadcrumbs: List<PageCrumb>? = null,
    val children: List<PageItem>? = null,
) {
    val item: PageItem
        get() = PageItem(
            id, parentId, position, kind, title, icon, version, headRevId, metaSeq, inheritAccess, taskTotal, taskDone,
            createdBy, updatedBy, createdAt, updatedAt, deletedAt, myLevel, private, isTemplate,
        )
}

/** GET /wiki/tree: every page I can read and where the change feed goes on from. */
@Serializable
data class WikiTreeOut(val pages: List<PageItem> = emptyList(), val cursor: Long = 0)

/** GET /wiki/changes?since=: pages that changed (readable), ids to drop, the next `since`; `reset`: read the tree again. */
@Serializable
data class WikiChangesOut(
    val pages: List<PageItem> = emptyList(),
    val removed: List<String> = emptyList(),
    val cursor: Long = 0,
    val reset: Boolean = false,
)

/** PUT /wiki/pages/{id}/content: the page now (PageContent) and the version holding exactly what was sent. */
@Serializable
data class PageSaveOut(val page: PageOut, val submittedRevId: String, val merged: Boolean = false)

/** 409 page_conflict / page_base_expired: `details` (the same as a canvas's, with the page as `head`). */
@Serializable
data class PageConflictDetails(val head: PageOut, val conflicts: List<CanvasConflict> = emptyList(), val timedOut: Boolean = false)

/** POST /wiki/pages/resolve: only the pages I can read come back. */
@Serializable
data class PageRef(val id: String, val title: String = "", val icon: String? = null, val kind: String = "page")

/** In GET /sync/bootstrap: the change feed's position (absent: the server has no 「ドキュメント」). */
@Serializable
data class WikiBootstrap(val changeSeq: Long = 0)

/** GET /search/pages's hit. */
@Serializable
data class PageSearchHit(val page: PageItem, val snippet: String = "", val score: Double = 0.0)

@Serializable
data class PageSearchOut(
    val hits: List<PageSearchHit> = emptyList(),
    val keywords: List<String> = emptyList(),
    val filters: SearchFilters? = null,
    val limit: Int = 0,
    val offset: Int = 0,
    val hasMore: Boolean = false,
    val total: Int = 0,
    val totalCapped: Boolean = false,
)

/** A page_mention / page_shared activity item's page (asked for with `include=page_mention` / `page_shared`). */
@Serializable
data class ActivityPage(
    val itemId: String,
    val pageId: String,
    val title: String = "",
    val icon: String? = null,
    val excerpt: String = "",
    val revId: String? = null,
    val level: String? = null,
)

/** wiki.mentioned / wiki.shared (to me): who did it and where. Lenient, like CanvasMentioned. */
@Serializable
data class WikiNotice(val pageId: String, val title: String = "", val byUserId: String? = null, val level: String? = null, val revId: String? = null)

/** M146 (WIKI.md §24.3): GET /wiki/templates — the template pages I can read (newest first) and the built-in ones. */
@Serializable
data class WikiTemplatesOut(val pages: List<PageItem> = emptyList(), val builtins: List<CanvasTemplateOut> = emptyList())

/** M146: POST /wiki/pages/{id}/duplicate — the copy, and for a row its cells. */
@Serializable
data class PageDuplicateOut(val page: PageOut, val row: DbRowWithRefs? = null)
