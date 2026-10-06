package jp.chikuwachat.android

import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.ActivityPage
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.PageCrumb
import jp.chikuwachat.android.api.PageOut
import jp.chikuwachat.android.api.WikiChangesOut
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.sync.WikiLevels
import jp.chikuwachat.android.sync.WikiLinks
import jp.chikuwachat.android.sync.WikiTree
import jp.chikuwachat.android.ui.ActivityTarget
import jp.chikuwachat.android.ui.ActivityText
import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.BodyToken
import jp.chikuwachat.android.ui.DocPageText
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.PageRights
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.parseBlocks
import jp.chikuwachat.android.ui.tokenizeInline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M122 (docs/WIKI.md §3, §4.1, §9, §10; SYNC_PROTOCOL.md §17): 「ドキュメント」's tree on this device, the change feed applied
 * to it, what a level allows, the routes of pages, page links in bodies, page pushes and activity items.
 */
class WikiTreeTest {
    private fun map(vararg pages: jp.chikuwachat.android.api.PageItem) = pages.associateBy { it.id }

    // --- order and layout -----------------------------------------------------------------------

    @Test
    fun siblingsGoByPositionBytesThenId() {
        // "a0" < "aV" < "a~" as bytes (as the server's collate "C"); equal positions go by id.
        val pages = map(page("x", position = "a~"), page("y", position = "a0"), page("b2", position = "aV"), page("b1", position = "aV"))
        assertEquals(listOf("y", "b1", "b2", "x"), WikiTree.children(pages, null).map { it.id })
        // Not the locale's order: an upper-case letter sorts before a lower-case one.
        assertTrue(WikiTree.compareBytes("Z", "a") < 0)
        assertTrue(WikiTree.compareBytes("a", "ab") < 0)
    }

    @Test
    fun aPageWhoseParentIsNotHereShowsAtTheTopAndTheTopSplitsIntoSharedAndPrivate() {
        val pages = map(
            page("manual", position = "a"),
            page("memo", position = "b", private = true),
            page("child", parent = "manual"),
            page("orphan", parent = "unreadable", position = "c"),
            page("row", parent = "manual", kind = "row"),
        )
        val sections = WikiTree.sections(pages)
        assertEquals(listOf("manual", "orphan"), sections.shared.map { it.id })
        assertEquals(listOf("memo"), sections.private.map { it.id })
        assertEquals(listOf("child"), WikiTree.children(pages, "manual").map { it.id }) // rows never show in the tree
    }

    @Test
    fun rowsOpenALevelAtATime() {
        val pages = map(
            page("a", position = "a"), page("a1", parent = "a", position = "a"), page("a2", parent = "a", position = "b"),
            page("a1x", parent = "a1"), page("b", position = "b"),
        )
        val roots = WikiTree.children(pages, null)
        val closed = WikiTree.rows(pages, roots, emptySet())
        assertEquals(listOf("a" to 0, "b" to 0), closed.map { it.page.id to it.depth })
        assertTrue(closed[0].hasChildren)
        assertFalse(closed[0].expanded)
        assertFalse(closed[1].hasChildren)
        val open = WikiTree.rows(pages, roots, setOf("a", "a1"))
        assertEquals(listOf("a" to 0, "a1" to 1, "a1x" to 2, "a2" to 1, "b" to 0), open.map { it.page.id to it.depth })
        // A child opened under a closed parent stays hidden.
        assertEquals(listOf("a", "b"), WikiTree.rows(pages, roots, setOf("a1")).map { it.page.id })
    }

    @Test
    fun aBrokenCycleIsLaidOutOnce() {
        val pages = map(page("a", parent = "b"), page("b", parent = "a"), page("top"))
        val rows = WikiTree.rows(pages, WikiTree.children(pages, null), setOf("a", "b", "top"))
        assertEquals(listOf("top"), rows.map { it.page.id })
        assertEquals(emptyList<String>(), WikiTree.ancestors(pages, "zzz").map { it.id })
        assertTrue(WikiTree.ancestors(pages, "a").size <= 2)
    }

    @Test
    fun theFilterFindsTitlesInTreeOrderIgnoringWidthAndCase() {
        val pages = map(
            page("a", title = "研究室マニュアル", position = "a"), page("a1", parent = "a", title = "ＧＰＵ サーバ"),
            page("b", title = "gpu の予約", position = "b"), page("c", title = "備品"),
        )
        assertEquals(listOf("a1", "b"), WikiTree.filter(pages, "GPU").map { it.id })
        assertEquals(emptyList<String>(), WikiTree.filter(pages, "  ").map { it.id })
        assertEquals(listOf("a"), WikiTree.ancestors(pages, "a1").map { it.id })
    }

    // --- the feed -----------------------------------------------------------------------------------

    @Test
    fun removedPagesTakeTheirSubtreeUnlessTheyComeBackInPages() {
        val pages = map(page("a"), page("a1", parent = "a"), page("a1x", parent = "a1"), page("a2", parent = "a"), page("b"))
        // a went to the trash with its subtree; a2 is still readable on its own (shared with me by name): it comes again.
        val next = WikiTree.apply(pages, WikiChangesOut(pages = listOf(page("a2", parent = null, title = "a2 now")), removed = listOf("a", "unknown"), cursor = 9))
        assertEquals(setOf("a2", "b"), next.keys)
        assertNull(next.getValue("a2").parentId)
        assertEquals("a2 now", next.getValue("a2").title)
    }

    @Test
    fun changedPagesReplaceOrJoinAndRowsStayOut() {
        val pages = map(page("a", title = "old"))
        val next = WikiTree.apply(pages, WikiChangesOut(pages = listOf(page("a", title = "new", version = 2), page("n", parent = "a"), page("r", parent = "a", kind = "row")), cursor = 3))
        assertEquals("new", next.getValue("a").title)
        assertEquals(setOf("a", "n"), next.keys)
    }

    @Test
    fun anUpdatedEventTakesTheTitleButKeepsThePlaceLevelAndPrivacy() {
        val pages = map(page("a", parent = "p", position = "q", level = "full", private = true, title = "old", version = 3), page("p"))
        // wiki.page.updated's PageMeta: parent_id always null, no my_level / private.
        val meta = page("a", parent = null, position = "zz", level = "view", title = "new", icon = "📘", version = 4)
        val next = WikiTree.applyMeta(pages, meta).getValue("a")
        assertEquals("new", next.title)
        assertEquals("📘", next.icon)
        assertEquals("p", next.parentId)
        assertEquals("q", next.position)
        assertEquals("full", next.myLevel)
        assertTrue(next.private)
        // An older event changes nothing; an unknown page is not added.
        assertEquals("old", WikiTree.applyMeta(pages, meta.copy(version = 2, title = "older")).getValue("a").title)
        assertFalse(WikiTree.applyMeta(pages, page("zz")).containsKey("zz"))
    }

    // --- levels -------------------------------------------------------------------------------------

    @Test
    fun viewReadsOnlyEditAndFullWriteGuestsMakeNoTopLevelPage() {
        assertFalse(WikiLevels.canEdit("view"))
        assertTrue(WikiLevels.canEdit("edit"))
        assertTrue(WikiLevels.canEdit("full"))
        assertFalse(WikiLevels.canEdit(null))
        assertFalse(WikiLevels.canCreateChild("view"))
        assertTrue(WikiLevels.canCreateChild("edit"))
        assertTrue(WikiLevels.canCreateTopLevel("member"))
        assertTrue(WikiLevels.canCreateTopLevel("admin"))
        assertFalse(WikiLevels.canCreateTopLevel("guest"))
        assertFalse(WikiLevels.canCreateTopLevel(null))
        assertEquals(PageRights(edit = false, createChild = false), PageRights.of("view"))
        assertEquals(PageRights(edit = true, createChild = true), PageRights.of("full"))
        // The tree's level (kept current by the feed) wins over the page's answer.
        val out = PageOut(id = "a", myLevel = "edit")
        assertEquals("view", DocPageText.level(page("a", level = "view"), out))
        assertEquals("edit", DocPageText.level(null, out))
    }

    @Test
    fun breadcrumbsNeverNameAnAncestorICannotRead() {
        val crumbs = DocPageText.crumbs(listOf(PageCrumb(null, null, null, false), PageCrumb("m", "マニュアル", "📘", true), PageCrumb("x", "", null, true)))
        assertEquals(listOf(null to "…", "m" to "📘 マニュアル", "x" to "無題"), crumbs)
    }

    @Test
    fun subpagesComeFromTheTreeWhenItKnowsThePage() {
        val pages = map(page("p"), page("c2", parent = "p", position = "b"), page("c1", parent = "p", position = "a"))
        assertEquals(listOf("c1", "c2"), DocPageText.children(pages, null, "p").map { it.id })
        val answer = PageOut(id = "q", children = listOf(page("z", parent = "q", position = "b"), page("y", parent = "q", position = "a")))
        assertEquals(listOf("y", "z"), DocPageText.children(pages, answer, "q").map { it.id })
    }

    // --- routes -------------------------------------------------------------------------------------

    @Test
    fun pagesStackOverTheTreeAndBackReturns() {
        val docs = MainNav.open(MainNav.root, Route.Docs)
        val one = MainNav.openPage(docs, "p1")
        assertEquals(listOf(Route.ChannelList, Route.Docs, Route.DocPage("p1")), one)
        assertEquals(one, MainNav.openPage(one, "p1")) // the same page on top stays
        val two = MainNav.openPage(one, "p2")
        assertEquals(Route.DocPage("p2"), MainNav.top(two))
        assertEquals(one, MainNav.back(two))
        assertEquals(docs, MainNav.back(one))
        // A breadcrumb goes back to a page under it, else opens over it.
        assertEquals(one, MainNav.openCrumb(two, "p1"))
        assertEquals(two + Route.DocPage("p0"), MainNav.openCrumb(two, "p0"))
        // The stack survives a rotation.
        assertEquals(two, MainNav.decode(MainNav.encode(two)))
    }

    @Test
    fun aPageFromTheSearchKeepsTheResultsAndOneOverAConversationLeavesItBehind() {
        val searched = MainNav.runSearch(MainNav.openSearch(MainNav.root), SearchParams(q = "gpu"))
        val opened = MainNav.openPage(MainNav.expandSearch(searched), "p1")
        assertEquals(Route.DocPage("p1"), MainNav.top(opened))
        assertEquals(false, (opened[opened.size - 2] as Route.Search).expanded)
        assertEquals(searched, MainNav.back(opened))
        // A /p/ link in a conversation: the page over it; back returns to the conversation.
        val conversation = MainNav.openConversation(MainNav.root, "ch1")
        val over = MainNav.openPage(conversation, "p1")
        assertEquals(conversation, MainNav.back(over))
        // A conversation opened from a page keeps the page behind it (back returns there).
        val fromPage = MainNav.openConversation(over, "ch2")
        assertTrue(fromPage.contains(Route.DocPage("p1")))
    }

    @Test
    fun aNotificationLandsThePageOverTheTreeOnTheHomeTab() {
        val state = MainTabs.landPage(MainTabs.initial.copy(selected = MainTab.ACTIVITY), "p9")
        assertEquals(MainTab.HOME, state.selected)
        assertEquals(listOf(Route.ChannelList, Route.Docs, Route.DocPage("p9")), MainTabs.stack(state))
    }

    // --- links in bodies ------------------------------------------------------------------------------

    @Test
    fun theCanvasDialectReadsPageAndFileLinksMessagesDoNot() {
        val id = "0190a2b4-0000-7000-8000-000000000001"
        val line = "手順は [GPU の予約](page:$id) と [規則.pdf](attachment:$id) を見てください"
        val block = parseBlocks(line, canvas = true).single() as BodyBlock.Paragraph
        val links = block.lines.single().filterIsInstance<BodyToken.Link>()
        assertEquals(listOf(BodyToken.Link("page:$id", "GPU の予約"), BodyToken.Link("attachment:$id", "規則.pdf")), links)
        // Lists, tasks, quotes, headings and tables read them too.
        val list = parseBlocks("- [a](page:$id)\n", canvas = true).first() as BodyBlock.ListBlock
        assertTrue(list.items.single().tokens.any { it is BodyToken.Link && it.url == "page:$id" })
        val heading = parseBlocks("## [a](page:$id)", canvas = true).single() as BodyBlock.Heading
        assertTrue(heading.tokens.any { it is BodyToken.Link })
        // A message keeps them as text; an ordinary link still is one.
        assertTrue(tokenizeInline(line).none { it is BodyToken.Link })
        assertEquals(BodyToken.Link("https://example.com", "x"), (parseBlocks("[x](https://example.com)", canvas = true).single() as BodyBlock.Paragraph).lines.single().single())
        // A malformed id stays text.
        assertTrue((parseBlocks("[x](page:nope)", canvas = true).single() as BodyBlock.Paragraph).lines.single().none { it is BodyToken.Link })
    }

    @Test
    fun theLinkedPagesOfABodyAreFoundOnce() {
        val a = "0190a2b4-0000-7000-8000-00000000000a"
        val b = "0190A2B4-0000-7000-8000-00000000000B"
        val body = "[A](page:$a) [A again](page:$a) https://chat.example/p/$b と https://other.example/p/$a"
        assertEquals(setOf(a, b.lowercase()), WikiLinks.pageIds(body, "https://chat.example"))
        assertEquals(a, WikiLinks.idOf("page:$a"))
        assertNull(WikiLinks.idOf("https://x/p/$a"))
        assertEquals(a, WikiLinks.attachmentOf("attachment:$a"))
        assertEquals(b.lowercase(), jp.chikuwachat.android.ui.Permalink.pageId("https://chat.example", "https://chat.example/p/$b?x=1"))
        assertEquals("https://chat.example/p/$a", jp.chikuwachat.android.ui.Permalink.pageUrl("https://chat.example/", a))
    }

    // --- push and activity ----------------------------------------------------------------------------

    @Test
    fun aPagePushIsShownOncePerPageAndOpensIt() {
        val push = PushMessage.parse(mapOf("kind" to "page", "page_id" to "p1", "title" to "ドキュメント", "body" to "佐藤 が「手順」であなたをメンションしました", "collapse_key" to "page:p1"))!!
        assertTrue(push.isPage)
        assertTrue(push.shown)
        assertEquals("page:p1", push.notificationKey)
        assertEquals("page:p2", push.copy(collapseKey = null, pageId = "p2").notificationKey)
        assertFalse(push.copy(pageId = null).shown)
    }

    @Test
    fun pageActivityItemsSayWhatHappenedAndOpenThePage() {
        val json = """{"kind":"page_mention","at":"2026-10-07T01:00:00Z","message":null,"actor_ids":["u2"],
            "page":{"item_id":"i1","page_id":"p1","title":"GPU の予約","icon":"🖥","excerpt":"@android1 確認して","rev_id":"r3","level":null}}"""
        val item = Codec.snake.decodeFromString(ActivityItem.serializer(), json)
        assertTrue(item.isShown)
        assertEquals("page_mention:i1", item.key)
        val name = { id: String -> if (id == "u2") "佐藤" else null }
        assertEquals("佐藤 が「GPU の予約」であなたをメンションしました", ActivityText.lead(item, name))
        assertEquals("ドキュメント", ActivityText.where(item, ""))
        assertEquals(ActivityTarget.Page("p1"), ActivityText.target(item))
        assertEquals("@android1 確認して", ActivityText.excerpt(item, emptySet()) { "" })
        assertEquals("", ActivityText.excerpt(item, setOf("i1")) { "" })
        val shared = item.copy(kind = "page_shared", page = ActivityPage("i2", "p2", "備品", null, "", null, "edit"))
        assertEquals("佐藤 が「備品」を共有しました", ActivityText.lead(shared, name))
        // Without its page an item of these kinds is not shown.
        assertFalse(item.copy(page = null).isShown)
    }
}
