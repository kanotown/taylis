package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasRevisionMeta
import jp.chikuwachat.android.api.CanvasSearchRequest
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.sync.CanvasLinkState
import jp.chikuwachat.android.sync.CanvasRequests
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.CanvasCards
import jp.chikuwachat.android.ui.CanvasDiff
import jp.chikuwachat.android.ui.CanvasRights
import jp.chikuwachat.android.ui.CanvasText
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.Search
import jp.chikuwachat.android.ui.SearchDate
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.parseBlocks
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * M58: the Android canvas catching up with the desktop's M44 (CANVAS.md §14): the history's comparison (the desktop's
 * canvasDiff.test.ts cases), the image line and its limit, the history / share / search requests, who may erase and
 * share, `/c/` cards in messages, and the search's 「キャンバス」 tab landing.
 */
class CanvasPhoneParityTest {
    // --- the comparison (canvasDiff.test.ts) ---------------------------------------------------------

    private fun kinds(before: String, after: String) = CanvasDiff.lines(before, after).map {
        (when (it.kind) { CanvasDiff.Kind.SAME -> " "; CanvasDiff.Kind.ADD -> "+"; CanvasDiff.Kind.DEL -> "-" }) + it.text
    }

    @Test
    fun linesAreKeptAddedAndRemovedWithTheirNumbers() {
        assertEquals(listOf(" a", "-b", " c", "+d"), kinds("a\nb\nc", "a\nc\nd"))
        val lines = CanvasDiff.lines("a\nb\nc", "a\nc\nd")
        assertEquals(listOf(1 to 1, 2 to null, 3 to 2, null to 3), lines.map { it.oldNo to it.newNo })
        assertEquals(1 to 1, CanvasDiff.counts(lines))
        assertEquals(listOf("+x", "+y"), kinds("", "x\ny"))
        assertEquals(listOf("-x", "-y"), kinds("x\ny", ""))
        assertEquals(listOf(" same"), kinds("same", "same"))
    }

    @Test
    fun theShortestScriptAmongRepeatedLines() {
        val before = listOf("- [ ] a", "- [ ] b", "- [ ] a", "- [ ] b").joinToString("\n")
        val after = listOf("- [ ] a", "- [ ] b", "- [ ] c", "- [ ] a", "- [ ] b").joinToString("\n")
        assertEquals(1 to 0, CanvasDiff.counts(CanvasDiff.lines(before, after)))
    }

    @Test
    fun aLineTouchedUpShowsTheWordsThatChangedInJapanese() {
        val lines = CanvasDiff.lines("# 議事録\n来週までに研究計画を提出する。", "# 議事録\n来週までに予稿を提出する。")
        val del = lines.first { it.kind == CanvasDiff.Kind.DEL }
        val add = lines.first { it.kind == CanvasDiff.Kind.ADD }
        assertEquals(listOf("研究計画"), del.words!!.filter { it.changed }.map { it.text })
        assertEquals(listOf("予稿"), add.words!!.filter { it.changed }.map { it.text })
        assertEquals("来週までに予稿を提出する。", add.words.joinToString("") { it.text })
    }

    @Test
    fun aTickIsOneWordAndARewrittenLineHasNoWordView() {
        val (del, add) = CanvasDiff.lines("- [ ] 旅費申請", "- [x] 旅費申請")
        assertEquals(listOf(" "), del.words!!.filter { it.changed }.map { it.text })
        assertEquals(listOf("x"), add.words!!.filter { it.changed }.map { it.text })
        assertNull(CanvasDiff.wordDiff("全く別の内容です", "Completely different text"))
    }

    @Test
    fun aLargeRewriteStaysCorrect() {
        val before = (0 until 4000).joinToString("\n") { "line $it" }
        val after = (0 until 4000).joinToString("\n") { "row $it" }
        val started = System.nanoTime()
        assertEquals(4000 to 4000, CanvasDiff.counts(CanvasDiff.lines(before, after)))
        assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000)
    }

    @Test
    fun wordsAreCutByScriptSpaceAndPunctuation() {
        assertEquals(listOf("研究計画", "を", "来週", "までに", "提出", "する", "。"), CanvasDiff.words("研究計画を来週までに提出する。"))
        assertEquals(listOf("see", " ", "PGroonga", " ", "docs"), CanvasDiff.words("see PGroonga docs"))
        assertEquals(listOf("カタカナー", "漢字"), CanvasDiff.words("カタカナー漢字"))
        // A full-width space is a space, as in JavaScript.
        assertEquals(listOf("会議", "　", "資料"), CanvasDiff.words("会議　資料"))
    }

    @Test
    fun longStretchesOfKeptLinesFold() {
        val before = (0 until 20).joinToString("\n") { "l$it" }
        val after = before.replace("l10", "L10")
        val rows = CanvasDiff.rows(CanvasDiff.lines(before, after), 2).map { row ->
            when (row) {
                is CanvasDiff.Row.Skip -> "…${row.count}"
                is CanvasDiff.Row.Text -> if (row.line.kind == CanvasDiff.Kind.SAME) row.line.text else "${row.line.kind.name.lowercase()}:${row.line.text}"
            }
        }
        assertEquals(listOf("…8", "l8", "l9", "del:l10", "add:L10", "l11", "l12", "…7"), rows)
    }

    private fun revision(id: String, kind: String = "save", parent: String? = null) =
        CanvasRevisionMeta(id = id, canvasId = "c1", kind = kind, parentRevId = parent, authorId = "u", createdAt = "")

    @Test
    fun thePreviousVersionIsTheNextOlderOneListedElseItsParent() {
        val list = listOf(revision("r3", parent = "r2"), revision("r2", parent = "r1"), revision("r1", kind = "create"))
        assertEquals("r2", CanvasDiff.previousId(list, 0))
        assertNull(CanvasDiff.previousId(list, 2)) // the first version: compared with nothing
        // The oldest of a page that has more: its parent.
        assertEquals("r1", CanvasDiff.previousId(list.take(2), 1))
    }

    // --- images (§4.10) ------------------------------------------------------------------------------

    private val id = "0d4f7f2e-1c2b-4c3d-8e9f-001122334455"

    @Test
    fun anImageGoesOnALineOfItsOwnAtTheCaret() {
        // Mid line: a line break before and after; the caret on the line below.
        val mid = CanvasText.insertImageLine(CanvasText.Edit("ab", 1), id)
        assertEquals("a\n![](attachment:$id)\nb", mid.text)
        assertEquals(mid.text.indexOf("\nb") + 1, mid.start)
        // At the start of a line that goes on: no blank line before.
        val start = CanvasText.insertImageLine(CanvasText.Edit("# 見出し\n本文", 6), id)
        assertEquals("# 見出し\n![](attachment:$id)\n本文", start.text)
        // At the end of a line followed by a break: the existing break is kept, the caret after it.
        val end = CanvasText.insertImageLine(CanvasText.Edit("a\nb", 1), id)
        assertEquals("a\n![](attachment:$id)\nb", end.text)
        assertEquals(end.text.length - 1, end.start)
        // A selection is replaced; an alt text loses its brackets and line breaks.
        val replaced = CanvasText.insertImageLine(CanvasText.Edit("xSELy", 1, 4), id, alt = "図]\n1")
        assertEquals("x\n![図  1](attachment:$id)\ny", replaced.text)
        // The canvas renders it as an image (the reading view's block).
        assertTrue(parseBlocks(mid.text, canvas = true).any { it is BodyBlock.Image && it.attachmentId == id })
    }

    @Test
    fun imagesAreCountedOncePerAttachmentUpToOneHundred() {
        val upper = id.uppercase()
        val body = "![](attachment:$id)\n![a](attachment:$upper)\n[file](attachment:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)"
        assertEquals(setOf(id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), CanvasText.attachmentRefs(body))
        val full = (0 until 99).joinToString("\n") { "![](attachment:00000000-0000-0000-0000-" + it.toString().padStart(12, '0') + ")" }
        assertTrue(CanvasText.imagesFit(full, 1))
        assertFalse(CanvasText.imagesFit(full, 2))
    }

    @Test
    fun aSnippetReadsAnImageAsImage() {
        assertEquals("前 [画像] 後", CanvasText.readableSnippet("前 ![](attachment:$id) 後"))
        assertEquals("[画像：図1] と [画像]", CanvasText.readableSnippet("![図1](attachment:$id) と ![](attachment:0d4f7f2e-1c"))
    }

    // --- rights (§4.7) -----------------------------------------------------------------------------------

    private fun channel(type: String = "public", role: String? = "member", postingPolicy: String? = null) = ChannelState(
        ChannelOut(id = "ch1", type = type, name = "lab", archived = false, lastSeq = 0, createdAt = "", updatedAt = "", membership = role?.let { MembershipOut(it, "") }, postingPolicy = postingPolicy),
        isMember = true,
    )

    private fun meta(createdBy: String = "creator", shareMessageId: String? = null) =
        CanvasMeta("c1", "ch1", "週報", 1, "r1", shareMessageId = shareMessageId, taskTotal = 8, taskDone = 3, createdBy = createdBy, updatedBy = createdBy, createdAt = "", updatedAt = "")

    @Test
    fun ownersAndAdministratorsEraseAndWhoeverPostsShares() {
        // A channel: erasing is for its owners and administrators (not the creator); sharing for whoever may post.
        assertFalse(CanvasRights.of(channel(), "creator", "member", meta()).erase)
        assertTrue(CanvasRights.of(channel(role = "owner"), "me", "member", meta()).erase)
        assertTrue(CanvasRights.of(channel(), "me", "admin", meta()).erase)
        assertTrue(CanvasRights.of(channel(), "me", "member", meta()).share)
        assertTrue(CanvasRights.of(channel(), "me", "guest", meta()).share) // a guest posts in a channel they are in
        assertFalse(CanvasRights.of(channel(postingPolicy = "owners"), "creator", "member", meta()).share)
        assertTrue(CanvasRights.of(channel(postingPolicy = "owners", role = "owner"), "me", "member", meta()).share)
        // A DM: its creator erases; everyone in it shares.
        assertTrue(CanvasRights.of(channel(type = "dm"), "creator", "member", meta()).erase)
        assertFalse(CanvasRights.of(channel(type = "group_dm"), "me", "member", meta()).erase)
        assertTrue(CanvasRights.of(channel(type = "dm"), "me", "member", meta()).share)
        // Restoring and naming versions follow the body's editing right.
        assertTrue(CanvasRights.of(channel(), "me", "member", meta()).edit)
    }

    // --- /c/ cards (§4.13) ---------------------------------------------------------------------------

    private val base = "https://chat.example.jp"
    private val canvasId = "11111111-2222-3333-4444-555555555555"

    @Test
    fun aCanvasLinkOnALineOfItsOwnIsACard() {
        // The shared message the server posts: the title, then the link.
        val shared = parseBlocks("📄 週報\n$base/c/$canvasId").single() as BodyBlock.Paragraph
        val pieces = CanvasCards.split(shared.lines, base)
        assertEquals(2, pieces.size)
        assertTrue(pieces[0] is CanvasCards.Piece.Lines)
        assertEquals(CanvasCards.Piece.Card(canvasId, "$base/c/$canvasId"), pieces[1])
        // Upper-case ids are this server's too; a link inside a sentence stays a link; another server's is not a card.
        val upper = (parseBlocks("$base/c/${canvasId.uppercase()}").single() as BodyBlock.Paragraph).lines.single()
        assertEquals(canvasId, CanvasCards.cardOf(upper, base)?.canvasId)
        val inline = (parseBlocks("これを見て $base/c/$canvasId").single() as BodyBlock.Paragraph).lines.single()
        assertNull(CanvasCards.cardOf(inline, base))
        val other = (parseBlocks("https://other.example.jp/c/$canvasId").single() as BodyBlock.Paragraph).lines.single()
        assertNull(CanvasCards.cardOf(other, base))
        // A labelled link alone on its line is a card; a message permalink is not.
        assertEquals(canvasId, CanvasCards.cardOf((parseBlocks("[週報]($base/c/$canvasId)").single() as BodyBlock.Paragraph).lines.single(), base)?.canvasId)
        assertNull(CanvasCards.cardOf((parseBlocks("$base/m/$canvasId").single() as BodyBlock.Paragraph).lines.single(), base))
        // Without a server (signed out) nothing is a card.
        assertEquals(listOf(CanvasCards.Piece.Lines(shared.lines)), CanvasCards.split(shared.lines, null))
        // Lines around a card stay together, in order.
        val three = parseBlocks("前\n$base/c/$canvasId\n後").single() as BodyBlock.Paragraph
        assertEquals(listOf("L", "C", "L"), CanvasCards.split(three.lines, base).map { if (it is CanvasCards.Piece.Card) "C" else "L" })
        // The link's web preview is not asked for (the card is the preview).
        assertTrue(CanvasCards.isCanvasLink(base, "$base/c/$canvasId"))
        assertFalse(CanvasCards.isCanvasLink(base, "$base/m/$canvasId"))
        assertEquals(0.375f, CanvasCards.progress(8, 3)!!, 0.0001f)
        assertNull(CanvasCards.progress(0, 0))
    }

    @Test
    fun aCardSaysWhyItCannotShowACanvas() {
        assertEquals(CanvasLinkState.Forbidden, CanvasLinkState.of(ApiException.Api(403, "not_a_member", "")))
        assertEquals(CanvasLinkState.Missing, CanvasLinkState.of(ApiException.Api(404, "canvas_not_found", "")))
        assertEquals(CanvasLinkState.Failed, CanvasLinkState.of(ApiException.Network(IOException("offline"))))
        assertEquals(CanvasLinkState.Failed, CanvasLinkState.of(ApiException.Api(503, "unavailable", "")))
    }

    // --- the requests ---------------------------------------------------------------------------------

    private class Seen(val method: String, val path: String, val query: String?, val body: String?)

    private fun client(seen: MutableList<Seen>, answer: (Request) -> String): ApiClient = ApiClient("http://server", OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
        val request = chain.request()
        val body = request.body?.let { b -> Buffer().also { b.writeTo(it) }.readUtf8() }
        seen.add(Seen(request.method, request.url.encodedPath, request.url.query, body))
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("ok")
            .body(answer(request).toResponseBody("application/json".toMediaType())).build()
    }).build()).also { it.accessToken = "a" }

    private val revisionJson = """{"id":"r2","canvas_id":"c1","version":3,"kind":"save","parent_rev_id":"r1","author_id":"u","title":"t","label":"提出版","lines_added":2,"lines_removed":1,"created_at":"2026-10-01T00:00:00Z"}"""
    private val canvasJson = """{"id":"c1","channel_id":"ch1","title":"週報","version":4,"head_rev_id":"r4","share_message_id":"m1","created_by":"u","updated_by":"u","created_at":"","updated_at":"","body":"x"}"""

    @Test
    fun historyShareAndSearchRequestsMatchTheSpecification() = runBlocking {
        val seen = ArrayList<Seen>()
        val api = client(seen) { request ->
            when {
                request.url.encodedPath.startsWith("/api/v1/search/canvases") -> """{"hits":[{"canvas":${canvasJson.replace(",\"body\":\"x\"", "")},"snippet":"…研究計画…","score":1.5}],"keywords":["研究計画"],"filters":{"text":"研究計画","unresolved":["has:file"]},"limit":20,"offset":0,"has_more":true,"total":21}"""
                request.url.encodedPath.contains("/revisions/") -> if (request.method == "POST") canvasJson else revisionJson
                else -> canvasJson
            }
        }
        val restored = api.restoreCanvasRevision("c1", "r2", "key-1")
        assertEquals("r4", restored.headRevId)
        assertEquals("POST", seen[0].method)
        assertEquals("/api/v1/canvases/c1/revisions/r2/restore", seen[0].path)
        assertEquals("""{"client_save_id":"key-1"}""", seen[0].body)

        val named = api.labelCanvasRevision("c1", "r2", "提出版")
        assertEquals("提出版", named.label)
        assertEquals("r1", named.parentRevId)
        assertEquals("PATCH" to """{"label":"提出版"}""", seen[1].method to seen[1].body)
        api.labelCanvasRevision("c1", "r2", null)
        assertEquals("""{"label":null}""", seen[2].body) // taking the name off is an explicit null

        api.eraseCanvasRevision("c1", "r2")
        assertEquals("DELETE" to "/api/v1/canvases/c1/revisions/r2", seen[3].method to seen[3].path)

        val shared = api.shareCanvas("c1")
        assertEquals("m1", shared.shareMessageId)
        assertEquals("POST" to "/api/v1/canvases/c1/share", seen[4].method to seen[4].path)

        val found = api.searchCanvases(CanvasSearchRequest(q = "研究計画 in:#lab", channelId = "ch1", fromUserId = "u2", after = "2026-09-01T00:00:00+09:00", sort = "newest"), offset = 20)
        val query = seen[5].query!!
        assertEquals("/api/v1/search/canvases", seen[5].path)
        listOf("q=研究計画 in:#lab", "channel_id=ch1", "from_user_id=u2", "after=2026-09-01T00:00:00+09:00", "sort=newest", "limit=20", "offset=20").forEach { part ->
            assertTrue("$part in $query", query.split("&").contains(part))
        }
        assertFalse(query.contains("before="))
        assertFalse(query.contains("has=")) // kinds and threads are not the canvas search's
        assertEquals("…研究計画…", found.hits.single().snippet)
        assertEquals(listOf("has:file"), found.filters?.unresolved)
        assertTrue(found.hasMore)
        assertEquals(21, found.total)
    }

    @Test
    fun aRestoreIsSentAgainWithTheSameKeyOnlyAfterANetworkFailure() = runBlocking {
        val keys = ArrayList<String>()
        var fail = 2
        val answer = CanvasRequests.sameKey("k1", wait = {}) { key ->
            keys.add(key)
            if (fail-- > 0) throw ApiException.Network(IOException("lost"))
            "restored"
        }
        assertEquals("restored", answer)
        assertEquals(listOf("k1", "k1", "k1"), keys)
        // Three network failures: it gives up (two retries).
        keys.clear()
        try {
            CanvasRequests.sameKey("k2", wait = {}) { key -> keys.add(key); throw ApiException.Network(IOException("down")) }
            fail("expected the failure")
        } catch (_: ApiException.Network) {}
        assertEquals(3, keys.size)
        // A refusal is not sent again.
        keys.clear()
        try {
            CanvasRequests.sameKey("k3", wait = {}) { key -> keys.add(key); throw ApiException.Api(403, "canvas_edit_restricted", "") }
            fail("expected the refusal")
        } catch (e: ApiException.Api) { assertEquals(403, e.status) }
        assertEquals(listOf("k3"), keys)
    }

    // --- the search's 「キャンバス」 tab (§4.8) -------------------------------------------------------

    @Test
    fun theCanvasSearchTakesWordsPersonConversationAndDates() {
        val now = ZonedDateTime.of(2026, 10, 1, 15, 0, 0, 0, ZoneId.of("Asia/Tokyo"))
        val query = Search.canvasQuery(SearchParams(q = " 議事録 ", fromUserId = "u2", channelId = "ch1", date = SearchDate(preset = "today"), has = listOf("file"), isThread = true), now)
        assertEquals(CanvasSearchRequest(q = "議事録", channelId = "ch1", fromUserId = "u2", after = "2026-10-01T00:00:00+09:00", before = null, sort = Search.RELEVANCE), query)
        // Without words: newest first.
        assertEquals(Search.NEWEST, Search.canvasQuery(SearchParams(channelId = "ch1"), now).sort)
        // Nothing to look for (kinds alone do not count): not sent.
        assertTrue(Search.canvasEmpty(SearchParams(has = listOf("file"), isThread = true)))
        assertFalse(Search.canvasEmpty(SearchParams(date = SearchDate(preset = "week"))))
        assertFalse(Search.canvasEmpty(SearchParams(q = "週報")))
    }

    @Test
    fun aCanvasFoundBySearchOpensWithTheResultsKeptBehindIt() {
        val searched = MainNav.runSearch(MainNav.openSearch(MainNav.root), SearchParams(q = "週報"))
        val opened = MainNav.openCanvasFromSearch(searched, "ch1", "c1")
        assertEquals(Route.Channel("ch1", tab = ConversationTab.CANVAS, canvasId = "c1"), opened.last())
        assertTrue(MainNav.backToSearch(opened))
        // Back: the canvas tab goes to the messages, then back to the results.
        val back = MainNav.back(MainNav.back(opened))
        assertEquals(searched.last(), back.last())
        // Not from a search: as a /c/ link opens it.
        assertEquals(MainNav.openCanvas(MainNav.root, "ch1", "c1"), MainNav.openCanvasFromSearch(MainNav.root, "ch1", "c1"))
    }
}
