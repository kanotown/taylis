package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.PageItem
import jp.chikuwachat.android.api.WikiChangesOut
import kotlinx.serialization.Serializable

/*
 * M122 (docs/WIKI.md §3, §10, §14; SYNC_PROTOCOL.md §17): the 「ドキュメント」 tree on this device as pure functions
 * (WikiTreeTest). The server sends every page I can read (GET /wiki/tree) and then what changed (GET /wiki/changes);
 * here they are kept as a map by id and laid out: siblings by `position` compared byte by byte (the server's
 * `collate "C"`), ties by id; a page whose parent is not here (I cannot read it, or it is not known yet) shows at the
 * top level; the top level splits into 共有 and プライベート (only I can see it).
 */

/** The tree as kept on this device (Room's meta table, "wiki:tree"): the pages, the feed's position, the tree's ETag. */
@Serializable
data class WikiTreeSnapshot(val pages: List<PageItem> = emptyList(), val cursor: Long = 0, val etag: String? = null)

/** One row of the tree on screen: the page, how deep, whether it has children and whether they show. */
data class WikiTreeRow(val page: PageItem, val depth: Int, val hasChildren: Boolean, val expanded: Boolean)

object WikiTree {
    /** The deepest a tree goes (WIKI.md §3.2: 20), with room to spare; deeper rows are not laid out (a cycle cannot loop). */
    const val MAX_DEPTH = 24

    /** Siblings' order: `position` as UTF-8 bytes (unsigned), then the id. */
    val order: Comparator<PageItem> = Comparator { a, b ->
        val byPosition = compareBytes(a.position, b.position)
        if (byPosition != 0) byPosition else a.id.compareTo(b.id)
    }

    fun compareBytes(a: String, b: String): Int {
        val x = a.toByteArray(Charsets.UTF_8)
        val y = b.toByteArray(Charsets.UTF_8)
        for (i in 0 until minOf(x.size, y.size)) {
            val d = (x[i].toInt() and 0xff) - (y[i].toInt() and 0xff)
            if (d != 0) return d
        }
        return x.size - y.size
    }

    /** Rows (database rows) never show in the tree. */
    private fun inTree(page: PageItem) = page.kind != "row"

    /** Shown at the top level: no parent, or a parent this device does not have (WIKI.md §4.6). */
    fun isTopLevel(pages: Map<String, PageItem>, page: PageItem): Boolean = page.parentId == null || !pages.containsKey(page.parentId)

    /** The children of `parentId` in order; null: the top level. */
    fun children(pages: Map<String, PageItem>, parentId: String?): List<PageItem> =
        pages.values.filter { inTree(it) && if (parentId == null) isTopLevel(pages, it) else it.parentId == parentId }.sortedWith(order)

    /** The top level split as the sidebar shows it: 共有 and プライベート (WIKI.md §3.1). */
    data class Sections(val shared: List<PageItem>, val private: List<PageItem>)

    fun sections(pages: Map<String, PageItem>): Sections {
        val top = children(pages, null)
        return Sections(top.filterNot { it.private }, top.filter { it.private })
    }

    /** The parent → children index, built once per layout. */
    private fun childIndex(pages: Map<String, PageItem>): Map<String?, List<PageItem>> =
        pages.values.filter(::inTree).groupBy { if (isTopLevel(pages, it)) null else it.parentId }.mapValues { (_, list) -> list.sortedWith(order) }

    /**
     * The rows on screen under `roots`: each page, then (when its id is in `expanded`) its children, depth first. A
     * page reached twice (never, unless the data is broken) shows once.
     */
    fun rows(pages: Map<String, PageItem>, roots: List<PageItem>, expanded: Set<String>): List<WikiTreeRow> {
        val index = childIndex(pages)
        val out = ArrayList<WikiTreeRow>()
        val seen = HashSet<String>()
        fun walk(page: PageItem, depth: Int) {
            if (!seen.add(page.id) || depth > MAX_DEPTH) return
            val kids = index[page.id].orEmpty()
            val open = page.id in expanded && kids.isNotEmpty()
            out.add(WikiTreeRow(page, depth, kids.isNotEmpty(), open))
            if (open) kids.forEach { walk(it, depth + 1) }
        }
        roots.forEach { walk(it, 0) }
        return out
    }

    /** Every page under `id` (not itself), as far as this device knows the tree. */
    fun descendants(pages: Map<String, PageItem>, id: String): Set<String> {
        val index = pages.values.groupBy { it.parentId }
        val out = LinkedHashSet<String>()
        val queue = ArrayDeque(listOf(id))
        while (queue.isNotEmpty()) {
            val next = queue.removeFirst()
            index[next].orEmpty().forEach { child -> if (child.id != id && out.add(child.id)) queue.addLast(child.id) }
        }
        return out
    }

    /** The ancestors this device knows, root first (a parent not here ends the chain). */
    fun ancestors(pages: Map<String, PageItem>, id: String): List<PageItem> {
        val out = ArrayList<PageItem>()
        var parent = pages[id]?.parentId
        val seen = HashSet<String>()
        while (parent != null && seen.add(parent) && out.size <= MAX_DEPTH) {
            val page = pages[parent] ?: break
            out.add(0, page)
            parent = page.parentId
        }
        return out
    }

    /**
     * GET /wiki/changes applied (`reset` is the caller's: read the whole tree instead). `removed` goes first, with the
     * pages under it this device knows (a page moved to the trash takes its subtree; one still readable elsewhere comes
     * back in `pages`), then `pages` replace or add. Unknown ids in `removed` are ignored.
     */
    fun apply(pages: Map<String, PageItem>, changes: WikiChangesOut): Map<String, PageItem> {
        val next = LinkedHashMap(pages)
        val incoming = changes.pages.map { it.id }.toSet()
        for (id in changes.removed) {
            if (!next.containsKey(id)) continue
            val under = descendants(next, id)
            next.remove(id)
            under.filter { it !in incoming }.forEach { next.remove(it) }
        }
        changes.pages.filter(::inTree).forEach { next[it.id] = it }
        return next
    }

    /** A wiki.page.updated's PageMeta over what is known: title, icon, version and the rest; place, level and privacy stay. */
    fun applyMeta(pages: Map<String, PageItem>, meta: PageItem): Map<String, PageItem> {
        val known = pages[meta.id] ?: return pages
        if (meta.version < known.version) return pages
        val next = LinkedHashMap(pages)
        next[meta.id] = known.copy(
            title = meta.title, icon = meta.icon, version = meta.version, headRevId = meta.headRevId, taskTotal = meta.taskTotal,
            taskDone = meta.taskDone, updatedBy = meta.updatedBy, updatedAt = meta.updatedAt, inheritAccess = meta.inheritAccess,
        )
        return next
    }

    /** Titles that contain `query` (NFKC, case ignored), in tree order: the tree's filter. */
    fun filter(pages: Map<String, PageItem>, query: String): List<PageItem> {
        val q = fold(query.trim())
        if (q.isEmpty()) return emptyList()
        val index = childIndex(pages)
        val out = ArrayList<PageItem>()
        val seen = HashSet<String>()
        fun walk(page: PageItem, depth: Int) {
            if (!seen.add(page.id) || depth > MAX_DEPTH) return
            if (fold(page.title).contains(q)) out.add(page)
            index[page.id].orEmpty().forEach { walk(it, depth + 1) }
        }
        index[null].orEmpty().forEach { walk(it, 0) }
        return out
    }

    private fun fold(text: String): String = java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFKC).lowercase()
}

/** What a level allows on a phone (WIKI.md §4.1, §9.2: reading and light editing; sharing and moving are elsewhere). */
object WikiLevels {
    fun rank(level: String?): Int = when (level) {
        "view" -> 1
        "edit" -> 2
        "full" -> 3
        else -> 0
    }

    /** The body, the title, ticking boxes: edit or full. View may not even tick (§4.1). */
    fun canEdit(level: String?): Boolean = rank(level) >= 2

    /** A child page: edit or full on the parent (a guest too, where it may edit). */
    fun canCreateChild(level: String?): Boolean = rank(level) >= 2

    /** A top-level page: anyone but a guest (§4.4). */
    fun canCreateTopLevel(role: String?): Boolean = role != null && role != "guest"
}

/** The page ids a body links to: `[…](page:<uuid>)` and this server's `/p/<uuid>` permalinks (WIKI.md §3.3). */
object WikiLinks {
    private val PAGE_LINK = Regex("""\]\(page:([0-9a-fA-F-]{36})\)""")
    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

    fun pageIds(body: String, base: String?): Set<String> {
        val out = LinkedHashSet<String>()
        PAGE_LINK.findAll(body).forEach { out.add(it.groupValues[1].lowercase()) }
        if (base != null) {
            val prefix = base.trimEnd('/') + "/p/"
            var at = body.indexOf(prefix, ignoreCase = true)
            while (at >= 0) {
                val id = body.substring(at + prefix.length).take(36)
                if (UUID.matches(id)) out.add(id.lowercase())
                at = body.indexOf(prefix, at + prefix.length, ignoreCase = true)
            }
        }
        return out
    }

    /** `page:<uuid>` (a link of the canvas dialect) → the id. */
    fun idOf(url: String): String? = url.takeIf { it.startsWith("page:") }?.removePrefix("page:")?.takeIf { UUID.matches(it) }?.lowercase()

    /** `attachment:<uuid>` → the id. */
    fun attachmentOf(url: String): String? = url.takeIf { it.startsWith("attachment:") }?.removePrefix("attachment:")?.takeIf { UUID.matches(it) }?.lowercase()
}
