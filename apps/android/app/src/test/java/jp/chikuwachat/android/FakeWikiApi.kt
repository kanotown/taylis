package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasConflict
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.PageConflictDetails
import jp.chikuwachat.android.api.PageCrumb
import jp.chikuwachat.android.api.PageItem
import jp.chikuwachat.android.api.PageOut
import jp.chikuwachat.android.api.PageRef
import jp.chikuwachat.android.api.PageSaveOut
import jp.chikuwachat.android.api.PageSearchOut
import jp.chikuwachat.android.api.WikiChangesOut
import jp.chikuwachat.android.api.WikiTreeOut
import jp.chikuwachat.android.sync.WikiApi

/** A page as the tests write it. */
fun page(
    id: String, parent: String? = null, position: String = "a", title: String = id, level: String = "edit", private: Boolean = false,
    version: Long = 1, kind: String = "page", icon: String? = null,
) = PageItem(
    id = id, parentId = parent, position = position, kind = kind, title = title, icon = icon, version = version, headRevId = "r$version",
    metaSeq = 1, createdBy = "u1", updatedBy = "u1", createdAt = "2026-10-07T00:00:00Z", updatedAt = "2026-10-07T00:00:00Z",
    myLevel = level, private = private,
)

/**
 * M122: 「ドキュメント」 on a pretend server — the tree with its ETag, a change feed the test fills, and pages with the save
 * protocol of CANVAS.md §4.4 reduced to "the base is the head, or 409 page_conflict" (the merge is the server's own tests').
 */
class FakeWikiApi : WikiApi {
    var tree = WikiTreeOut(emptyList(), 0)
    var treeEtag = "\"t1\""
    /** What GET /wiki/changes answers next (by `since`), else nothing changed. */
    val changes = HashMap<Long, WikiChangesOut>()
    val calls = ArrayList<String>()
    val failures = ArrayDeque<Throwable>()

    // One page with a body.
    var pageId = "p1"
    var body = ""
    var version = 1L
    var head = "r1"
    var level = "edit"
    var crumbs = listOf(PageCrumb(null, null, null, false))
    val saves = ArrayList<List<String>>()
    var conflictNext = false

    val refs = HashMap<String, PageRef>()

    private fun fail() { failures.removeFirstOrNull()?.let { throw it } }

    fun pageOut(): PageOut = PageOut(
        id = pageId, parentId = null, position = "a", title = "マニュアル", version = version, headRevId = head, myLevel = level,
        createdBy = "u1", updatedBy = "u2", createdAt = "2026-10-07T00:00:00Z", updatedAt = "2026-10-07T00:00:00Z", body = body,
        breadcrumbs = crumbs, children = emptyList(),
    )

    override suspend fun wikiTree(etag: String?): Pair<WikiTreeOut?, String?> {
        calls.add("tree " + (etag ?: "-"))
        fail()
        return if (etag == treeEtag) null to etag else tree to treeEtag
    }

    override suspend fun wikiChanges(since: Long): WikiChangesOut {
        calls.add("changes $since")
        fail()
        return changes.remove(since) ?: WikiChangesOut(cursor = since)
    }

    override suspend fun wikiPage(pageId: String, etag: String?): PageOut? {
        calls.add("page $pageId " + (etag ?: "-"))
        fail()
        if (pageId != this.pageId) throw ApiException.Api(404, "page_not_found", "Page not found")
        return if (etag == "\"v$version-$level\"") null else pageOut()
    }

    override suspend fun saveWikiPage(pageId: String, baseRevId: String, body: String, clientSaveId: String, onConflict: String): PageSaveOut {
        saves.add(listOf(baseRevId, body, clientSaveId, onConflict))
        fail()
        if (level == "view") throw ApiException.Api(403, "page_edit_restricted", "View only")
        if (conflictNext && onConflict == "fail") {
            conflictNext = false
            val details = Codec.snake.encodeToJsonElement(
                PageConflictDetails.serializer(),
                PageConflictDetails(pageOut().copy(breadcrumbs = null, children = null), listOf(CanvasConflict("a", body, this.body, 1, 1))),
            )
            throw ApiException.Api(409, "page_conflict", "Conflict", details)
        }
        version += 1
        head = "r$version"
        this.body = body
        return PageSaveOut(pageOut().copy(breadcrumbs = null, children = null), head, merged = false)
    }

    override suspend fun createWikiPage(parentId: String?, title: String?, access: String, tz: String?, clientSaveId: String, template: jp.chikuwachat.android.sync.PageTemplateChoice?): PageOut {
        calls.add("create ${parentId ?: "-"} ${title ?: "-"} $access")
        fail()
        return PageOut(id = "new", parentId = parentId, title = title ?: "無題", myLevel = "full", headRevId = "r1", version = 1)
    }

    override suspend fun renameWikiPage(pageId: String, title: String): PageOut = pageOut().copy(title = title)

    override suspend fun resolveWikiPages(ids: List<String>): List<PageRef> {
        calls.add("resolve " + ids.joinToString(","))
        fail()
        return ids.mapNotNull { refs[it] }
    }

    override suspend fun wikiBacklinks(pageId: String): List<PageItem> = emptyList()

    override suspend fun searchPages(q: String, limit: Int, offset: Int): PageSearchOut = PageSearchOut()
}
