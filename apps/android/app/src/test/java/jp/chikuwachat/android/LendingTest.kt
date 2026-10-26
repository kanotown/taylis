package jp.chikuwachat.android

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.LendingApproversOut
import jp.chikuwachat.android.api.LendingItemOut
import jp.chikuwachat.android.api.LendingLoanOut
import jp.chikuwachat.android.api.LendingSettingsOut
import jp.chikuwachat.android.api.LendingSummaryOut
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.platform.LendingTarget
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.LendingSummary
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ActivityTarget
import jp.chikuwachat.android.ui.ActivityText
import jp.chikuwachat.android.ui.HomeTile
import jp.chikuwachat.android.ui.HomeTiles
import jp.chikuwachat.android.ui.LendingRules
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.NavItems
import jp.chikuwachat.android.ui.Permalink
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import jp.chikuwachat.android.ui.Route
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M172 (docs/LENDING.md §12.3, §14): 「備品」 on Android — decoding (an unknown status never fails), the borrow / extend
 * dates, the requests, the 409 words, the teacher's decision, the activity row, the push and its tap, the tile and the
 * reload after lending.updated.
 */
class LendingTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")

    private fun loan(id: String, borrower: String, due: String = "2026-10-30", overdue: Int = 0, status: String = "active") =
        LendingLoanOut(id = id, itemId = "item-$id", itemName = "カメラ A", borrowerId = borrower, status = status, dueOn = due, overdueDays = overdue)

    @Test fun decodesTheServersItemsAndLoans() {
        val list = """
            [{"id": "i1", "name": "カメラ A", "category_id": "c1", "code": "CAM-02", "location": "301 棚 2", "notes": "充電器・ケース",
              "photo": {"id": "a1", "filename": "cam.jpg", "content_type": "image/jpeg", "size_bytes": 1000, "has_thumbnail": true},
              "status": "on_loan", "status_note": null, "requires_permission": true, "requires_permission_source": "category",
              "max_days": 14, "max_days_source": "default",
              "loan": {"id": "l1", "borrower_id": "u2", "borrowed_at": "2026-10-16T01:00:00Z", "due_on": "2026-10-30", "overdue_days": 2,
                       "permission_state": null, "status": "active", "returned_at": null, "return_condition": null},
              "watching": false, "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z"},
             {"id": "i2", "name": "未来の状態", "status": "lost_in_space", "requires_permission": false, "max_days": 7,
              "watching": true, "created_at": "", "updated_at": "", "brand_new_field": 1}]
        """.trimIndent()
        val items = Codec.snake.decodeFromString(kotlinx.serialization.builtins.ListSerializer(LendingItemOut.serializer()), list)
        assertEquals(2, items.size)
        assertEquals("CAM-02", items[0].code)
        assertEquals(2, items[0].loan?.overdueDays)
        assertTrue(items[0].photo!!.isImage)
        // A status this app does not know decodes and reads 「（不明）」.
        assertEquals("（不明）", LendingRules.statusLabel(items[1].status))
        val detail = """
            {"id": "i1", "name": "カメラ A", "status": "available", "requires_permission": false, "max_days": 14, "watching": false,
             "created_at": "", "updated_at": "", "loan": null, "watcher_count": 2,
             "recent_loans": [{"id": "l0", "borrower_id": "u3", "borrowed_at": "2026-10-01T01:00:00Z", "due_on": "2026-10-05", "overdue_days": 0,
                               "permission_state": null, "status": "returned", "returned_at": "2026-10-04T01:00:00Z", "return_condition": "issue"}]}
        """.trimIndent()
        val item = Codec.snake.decodeFromString(LendingItemOut.serializer(), detail)
        assertEquals(2, item.watcherCount)
        assertEquals("issue", item.recentLoans.single().returnCondition)
        val hidden = """
            {"id": "l1", "item_id": "i1", "item_name": "カメラ A", "item_code": "CAM-02", "borrower_id": "u2", "status": "active",
             "borrowed_at": "2026-10-16T01:00:00Z", "due_on": "2026-10-30", "original_due_on": "2026-10-30", "overdue_days": 0,
             "extension_count": 1, "can_extend": false, "latest_due_on": "2026-11-09", "purpose": null, "permission_required": true,
             "approver_id": null, "permission_state": null, "permission_decided_at": null, "permission_note": null, "returned_at": null,
             "returned_by": null, "return_condition": null, "return_note": null, "details_hidden": true}
        """.trimIndent()
        val out = Codec.snake.decodeFromString(LendingLoanOut.serializer(), hidden)
        assertTrue(out.detailsHidden)
        assertNull(out.purpose)
        assertEquals("2026-11-09", out.latestDueOn)
    }

    @Test fun borrowDatesFollowTheWorkspaceZoneAndTheItemsMaximum() {
        // 23:30 in Tokyo on 10/26 is still 10/26 there (14:30 UTC), whatever the device's zone.
        val now = Instant.parse("2026-10-26T14:30:00Z")
        val today = LendingRules.today(now, tokyo)
        assertEquals(LocalDate.of(2026, 10, 26), today)
        assertEquals(LocalDate.of(2026, 10, 27), LendingRules.today(Instant.parse("2026-10-26T15:30:00Z"), tokyo))
        val item = LendingItemOut(id = "i", name = "PC-03", maxDays = 14)
        val range = LendingRules.borrowRange(item, today)
        assertEquals(today, range.start)
        assertEquals(LocalDate.of(2026, 11, 9), range.endInclusive)
        // Same-day return is fine (0 days); a maximum of 0 means today only.
        assertEquals(today..today, LendingRules.borrowRange(item.copy(maxDays = 0), today))
        // The send button: a date in range, a purpose, and the mark and a teacher when needed.
        assertTrue(LendingRules.canSendBorrow(range.endInclusive, range, "学会の撮影", needsPermission = false, confirmed = false, approverId = null))
        assertFalse(LendingRules.canSendBorrow(range.endInclusive.plusDays(1), range, "学会の撮影", false, false, null))
        assertFalse(LendingRules.canSendBorrow(today, range, "  ", false, false, null))
        assertFalse(LendingRules.canSendBorrow(today, range, "撮影", needsPermission = true, confirmed = true, approverId = null))
        assertFalse(LendingRules.canSendBorrow(today, range, "撮影", needsPermission = true, confirmed = false, approverId = "t1"))
        assertTrue(LendingRules.canSendBorrow(today, range, "撮影", needsPermission = true, confirmed = true, approverId = "t1"))
        // The picker's UTC-midnight millis round-trip.
        assertEquals(range.endInclusive, LendingRules.pickerDay(LendingRules.pickerMillis(range.endInclusive)))
    }

    @Test fun extendRangeAndTheExtensionsLeft() {
        val l = loan("l1", "me", due = "2026-10-30").copy(latestDueOn = "2026-11-09", extensionCount = 1, canExtend = true)
        assertEquals(LocalDate.of(2026, 10, 31)..LocalDate.of(2026, 11, 9), LendingRules.extendRange(l))
        assertNull(LendingRules.extendRange(l.copy(latestDueOn = "2026-10-30")))
        assertEquals(1, LendingRules.extensionsLeft(l, LendingSettingsOut(enabled = true, maxExtensions = 2)))
        assertEquals(0, LendingRules.extensionsLeft(l.copy(extensionCount = 3), LendingSettingsOut(enabled = true, maxExtensions = 2)))
        assertNull(LendingRules.extensionsLeft(l, null))
    }

    @Test fun theRequestsTheServerExpects() {
        val body = ApiClient.borrowLendingBody("req-1", "2026-10-30", "学会の撮影", permissionConfirmed = true, approverId = "t1")
        assertEquals("req-1", body["client_request_id"]!!.jsonPrimitive.content)
        assertEquals("2026-10-30", body["due_on"]!!.jsonPrimitive.content)
        assertEquals("true", body["permission_confirmed"]!!.jsonPrimitive.content)
        assertEquals("t1", body["approver_id"]!!.jsonPrimitive.content)
        val plain = ApiClient.borrowLendingBody("req-1", "2026-10-30", "撮影", permissionConfirmed = false, approverId = null)
        assertFalse("approver_id" in plain)
    }

    @Test fun conflictsSayWhoTookItFirst() {
        val name: (String) -> String = { if (it == "u2") "山田 太郎" else "?" }
        val taken = ApiException.Api(409, "lending_item_unavailable", "x", buildJsonObject {
            put("status", "on_loan"); put("loan_id", "l1"); put("borrower_id", "u2"); put("due_on", "2026-10-30")
        })
        assertEquals("山田 太郎 さんが先に借りました（10/30 (金) まで）", LendingRules.errorText(taken, "me", name))
        assertTrue(LendingRules.isConflict(taken))
        val mine = ApiException.Api(409, "lending_item_unavailable", "x", buildJsonObject {
            put("status", "on_loan"); put("borrower_id", "me"); put("due_on", "2026-10-30")
        })
        assertEquals("すでに借りています", LendingRules.errorText(mine, "me", name))
        val repair = ApiException.Api(409, "lending_item_unavailable", "x", buildJsonObject { put("status", "in_repair") })
        assertEquals("この備品は修理中です", LendingRules.errorText(repair, "me", name))
        // Others: the shared table (apps/shared/errors.json), never the server's English.
        val notApprover = ApiException.Api(403, "lending_not_approver", "Only the teacher")
        assertFalse(LendingRules.errorText(notApprover, "me", name).contains("Only the teacher"))
        assertFalse(LendingRules.isConflict(notApprover))
    }

    @Test fun theTeachersDecisionStaysOpenFourteenDaysAfterTheReturn() {
        val now = Instant.parse("2026-10-26T00:00:00Z")
        val l = loan("l1", "u2").copy(permissionRequired = true, approverId = "t1", permissionState = "claimed")
        assertTrue(LendingRules.canDecide(l, "t1", now))
        assertFalse(LendingRules.canDecide(l, "u2", now)) // not the teacher (nor a keeper or an admin)
        assertFalse(LendingRules.canDecide(l.copy(permissionRequired = false), "t1", now))
        val returned = l.copy(status = "returned", returnedAt = "2026-10-20T00:00:00Z")
        assertTrue(LendingRules.canDecide(returned, "t1", now))
        assertFalse(LendingRules.canDecide(returned.copy(returnedAt = "2026-10-01T00:00:00Z"), "t1", now))
        assertEquals("申告（未確認）", LendingRules.permissionText("claimed"))
        assertNull(LendingRules.permissionText(null))
    }

    @Test fun theListFiltersByTextCategoryAndStatus() {
        val items = listOf(
            LendingItemOut(id = "1", name = "カメラ A", code = "CAM-02", categoryId = "cam", status = "on_loan"),
            LendingItemOut(id = "2", name = "ＰＣ ３", code = "PC-03", categoryId = "pc", status = "available"),
            LendingItemOut(id = "3", name = "統計学入門", code = "図-0123", categoryId = "book", status = "in_repair", location = "本棚 B"),
        )
        assertEquals(listOf("2"), LendingRules.filter(items, "pc 3", null, null).map { it.id }) // NFKC: full-width matches
        assertEquals(listOf("1"), LendingRules.filter(items, "cam-02", null, null).map { it.id })
        assertEquals(listOf("3"), LendingRules.filter(items, "本棚", null, null).map { it.id })
        assertEquals(listOf("1"), LendingRules.filter(items, "", "cam", null).map { it.id })
        assertEquals(listOf("2"), LendingRules.filter(items, "", null, "available").map { it.id })
        assertEquals(emptyList<String>(), LendingRules.filter(items, "", "cam", "available").map { it.id })
    }

    @Test fun teachersMySupervisorFirst() {
        val approvers = LendingApproversOut(userIds = listOf("t3", "t1", "t2"), suggestedIds = listOf("t2"))
        val names = mapOf("t1" to "加納", "t2" to "佐藤", "t3" to "伊藤")
        val choices = LendingRules.approverChoices(approvers, { names.getValue(it) })
        assertEquals("t2", choices.first())
        assertEquals(setOf("t1", "t2", "t3"), choices.toSet())
        assertEquals(listOf("t1"), LendingRules.approverChoices(approvers, { names.getValue(it) }, "加納"))
        // A suggestion who is not a candidate is never offered.
        assertFalse("x" in LendingRules.approverChoices(approvers.copy(suggestedIds = listOf("x")), { names[it] ?: "x" }))
    }

    @Test fun anActivityItemOfKindLending() {
        val json = """
            {"id": "n1", "kind": "lending", "at": "2026-10-26T00:00:00Z", "message": null, "actor_ids": [], "emojis": [],
             "lending": {"item_id": "n1", "lending_item_id": "i1", "loan_id": "l1", "item_name": "カメラ A", "role": "approver",
                         "text": "🔑 山田 さんが「カメラ A（CAM-02）」を借りました", "done": false, "done_at": null, "done_by": null}, "read": false}
        """.trimIndent()
        val item = ActivityItem.decodeOrNull(Codec.snake, Codec.snake.parseToJsonElement(json))!!
        assertEquals("lending:n1", item.key)
        assertEquals("カメラ A · 許可の確認", ActivityText.lead(item) { it })
        assertEquals("🔑 山田 さんが「カメラ A（CAM-02）」を借りました", ActivityText.excerpt(item, emptySet()) { "" })
        assertEquals(ActivityTarget.Lending("i1", "l1"), ActivityText.target(item))
        assertTrue(LendingRules.showsDecision(item.lending!!, emptySet()))
        // Done once decided (or named in activity.updated before the list reads again).
        assertTrue(LendingRules.activityDone(item.lending, setOf("n1")))
        assertFalse(LendingRules.showsDecision(item.lending!!.copy(done = true), emptySet()))
        // Other roles are never to-dos; the keepers' summary opens the overdue list.
        val summary = item.lending!!.copy(role = "keeper", lendingItemId = null, loanId = null, itemName = null)
        assertFalse(LendingRules.activityDone(summary.copy(done = true), emptySet()))
        assertEquals("備品 · 備品係", LendingRules.activityLead(summary))
        // Asked for on every activity call.
        assertTrue("include=lending" in jp.chikuwachat.android.api.ActivityInclude.query("include"))
    }

    @Test fun thePushAndWhereItsTapGoes() {
        val push = PushMessage.parse(mapOf(
            "kind" to "lending", "title" to "備品", "body" to "📦 「カメラ A」は今日が返す日です。", "lending_item_id" to "i1", "loan_id" to "l1",
            "collapse_key" to "lending:loan:l1", "workspace_id" to "w1",
        ))!!
        assertTrue(push.shown) // no conversation, still a notification
        assertEquals("lending:loan:l1", push.notificationKey)
        assertEquals(LendingTarget("i1", "l1"), push.lendingTarget)
        val summary = PushMessage.parse(mapOf("kind" to "lending", "title" to "備品", "body" to "⏰ …"))!!
        assertEquals("lending:overdue", summary.notificationKey)
        assertEquals("lending:overdue", LendingRules.notificationKey(summary.lendingTarget!!))
        assertEquals("lending:item:i1", LendingRules.notificationKey(LendingTarget("i1", null)))
        assertNull(PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c"))!!.lendingTarget)
        // The tap: the loan over the list; else the item; else the overdue segment.
        val root = listOf<Route>(Route.ChannelList)
        assertEquals(listOf(Route.ChannelList, Route.Lending(), Route.Lending(loanId = "l1")), MainNav.landLending(root, "i1", "l1"))
        assertEquals(listOf(Route.ChannelList, Route.Lending(), Route.Lending(itemId = "i1")), MainNav.landLending(root, "i1", null))
        assertEquals(listOf(Route.ChannelList, Route.Lending(overdue = true)), MainNav.landLending(root, null, null))
        // A row opens over what is on screen; the same page on top stays.
        val open = MainNav.openLending(listOf(Route.ChannelList, Route.Lending()), itemId = "i1")
        assertEquals(open, MainNav.openLending(open, itemId = "i1"))
        assertEquals("備品", LendingRules.barTitle(Route.Lending(), emptyMap()))
        assertEquals("カメラ A", LendingRules.barTitle(Route.Lending(itemId = "i1"), mapOf("i1" to "カメラ A")))
    }

    @Test fun theTileOnlyWhileOnWithMyOverdueAndTheKeepersCount() {
        assertEquals(1, LendingRules.tileCount(LendingSummaryOut(myOverdueCount = 1, keeperAttentionCount = 4)))
        assertEquals(5, LendingRules.tileCount(LendingSummaryOut(isKeeper = true, myOverdueCount = 1, keeperAttentionCount = 4)))
        val threads = ThreadSummary(unreadCount = 0, mentionCount = 0)
        val off = HomeTiles.tiles(threads, 0, 0, 0, navItems = null)
        assertFalse(off.any { it.tile == HomeTile.LENDING })
        val on = HomeTiles.tiles(threads, 0, 0, 0, navItems = null, reservations = HomeTiles.ReservationTile(0, false), lending = HomeTiles.LendingTile(2))
        val keys = on.map { it.tile }
        assertEquals(keys.indexOf(HomeTile.RESERVATIONS) + 1, keys.indexOf(HomeTile.LENDING))
        val tile = on.first { it.tile == HomeTile.LENDING }
        assertEquals(2, tile.count)
        assertTrue(tile.alert)
        assertNull(HomeTiles.tiles(threads, 0, 0, 0, navItems = null, lending = HomeTiles.LendingTile(0)).first { it.tile == HomeTile.LENDING }.count)
        assertEquals("lending", HomeTile.LENDING.navKey)
        assertTrue("lending" in NavItems.implemented(attendance = false, lending = true))
        assertFalse("lending" in NavItems.implemented(attendance = false))
    }

    @Test fun theSummaryWorkedOutAgain() {
        val settings = LendingSettingsOut(enabled = true, isKeeper = true, keeperOverdueDays = 3)
        val mine = listOf(loan("a", "me", overdue = 1), loan("b", "me"), loan("c", "me", status = "returned"))
        val active = mine.filter { it.status == "active" } + loan("d", "u2", overdue = 3) + loan("e", "gone")
        val out = LendingSummary.of(settings, mine, active) { it == "gone" }!!
        assertEquals(2, out.myActiveCount)
        assertEquals(1, out.myOverdueCount)
        assertEquals(2, out.keeperAttentionCount) // 3 days past due, and a deactivated borrower
        assertEquals(0, LendingSummary.of(settings.copy(isKeeper = false), mine, null) { false }!!.keeperAttentionCount)
        assertNull(LendingSummary.of(settings.copy(enabled = false), mine, active) { false })
    }

    @Test fun guestsAndOffHaveNoLending() {
        val store = Store()
        store.setLending(LendingSummaryOut(enabled = false))
        assertNull(store.lending)
        store.setLending(LendingSummaryOut(enabled = true, myActiveCount = 1))
        assertEquals(1, store.lending?.myActiveCount)
        val before = store.lendingRevision
        store.bumpLending()
        assertEquals(before + 1, store.lendingRevision)
    }

    @Test fun anOlderServerHasTheNumbersWorkedOutFromTheLoans() = runBlocking {
        val server = FakeServer()
        server.lendingSummaryRoute = false // a server before M173: GET /lending/summary is 404
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        server.createChannel("general", alice.id)
        server.lendingSettings = LendingSettingsOut(enabled = true)
        server.lendingLoans = listOf(loan("l1", bob.id))
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        val notices = mutableListOf<String>()
        engine.onLendingNotice = { notices += it.text }
        engine.start(); engine.idle()
        assertEquals(1, store.lending?.myActiveCount)
        assertEquals(0, store.lending?.myOverdueCount)
        val revision = store.lendingRevision
        // Two events in a burst: one read of my loans.
        server.lendingLoans = listOf(loan("l1", bob.id, overdue = 2))
        val reads = server.lendingLoanReads.size
        server.publishLending()
        server.publishLending()
        engine.idle()
        delay(600)
        assertEquals(1, store.lending?.myOverdueCount)
        assertEquals(listOf("mine"), server.lendingLoanReads.drop(reads))
        assertTrue(store.lendingRevision > revision)
        // Turned off: the settings say so and the tile goes.
        server.lendingSettings = LendingSettingsOut(enabled = false)
        server.publishLending(settings = true)
        engine.idle()
        delay(600)
        assertNull(store.lending)
        server.noticeLending(bob.id, "📦 「カメラ A」は今日が返す日です。")
        engine.idle()
        assertEquals(listOf("📦 「カメラ A」は今日が返す日です。"), notices)
        assertEquals(1, server.lendingSummaryReads) // asked once, then the loans
        engine.stop(); scope.cancel()
    }

    @Test fun lendingUpdatedAndANoticeReadTheSummaryAndOffHidesTheTile() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        server.createChannel("general", alice.id)
        server.lendingSettings = LendingSettingsOut(enabled = true, isKeeper = true, keeperOverdueDays = 3)
        server.lendingLoans = listOf(loan("l1", bob.id), loan("l2", alice.id, overdue = 4))
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); engine.idle()
        assertEquals(1, store.lending?.keeperAttentionCount)
        // lending.updated: the summary, no loans read (a keeper read every active loan before M173).
        server.lendingLoans = listOf(loan("l1", bob.id, overdue = 1), loan("l2", alice.id, overdue = 4))
        val reads = server.lendingLoanReads.size
        server.publishLending()
        engine.idle()
        delay(600)
        assertEquals(1, server.lendingSummaryReads)
        assertEquals(1, store.lending?.myOverdueCount)
        assertEquals(emptyList<String>(), server.lendingLoanReads.drop(reads))
        // lending.notice (the morning's reminder, no lending.updated): the numbers again.
        server.lendingLoans = listOf(loan("l1", bob.id, overdue = 1))
        server.noticeLending(bob.id, "⏰")
        engine.idle()
        delay(600)
        assertEquals(2, server.lendingSummaryReads)
        assertEquals(0, store.lending?.keeperAttentionCount)
        // Turned off: 409 lending_disabled is null, the tile goes.
        server.lendingSettings = LendingSettingsOut(enabled = false)
        server.publishLending(settings = true)
        engine.idle()
        delay(600)
        assertNull(store.lending)
        assertEquals(emptyList<String>(), server.lendingLoanReads.drop(reads))
        engine.stop(); scope.cancel()
    }

    @Test fun theSummaryRequestOffGuestsAndAnOlderServer() = runBlocking {
        val answers = ArrayDeque(listOf(
            200 to """{"enabled": true, "is_keeper": false, "my_active_count": 1, "my_overdue_count": 1, "keeper_attention_count": 0, "settings_updated_at": "2026-10-26T00:00:00Z"}""",
            409 to """{"error": {"code": "lending_disabled", "message": "off"}}""",
            403 to """{"error": {"code": "guest_restricted", "message": "guests"}}""",
            404 to """{"error": {"code": "not_found", "message": "Not Found"}}""",
        ))
        val paths = ArrayList<String>()
        val http = okhttp3.OkHttpClient.Builder().addInterceptor { chain ->
            paths += chain.request().url.encodedPath
            val (code, body) = answers.removeFirst()
            okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(code).message("x")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }.build()
        val client = ApiClient("http://server", http)
        val summary = client.lendingSummary()
        assertEquals(1, summary?.myOverdueCount)
        assertEquals("2026-10-26T00:00:00Z", summary?.settingsUpdatedAt)
        assertNull(client.lendingSummary()) // off
        assertNull(client.lendingSummary()) // a guest
        val old = runCatching { client.lendingSummary() }.exceptionOrNull()
        assertTrue(old != null && LendingSummary.isMissingRoute(old))
        assertEquals(List(4) { "/api/v1/lending/summary" }, paths)
        assertFalse(LendingSummary.isMissingRoute(ApiException.Api(404, "lending_item_not_found", "")))
        assertFalse(LendingSummary.isMissingRoute(ApiException.Network(java.io.IOException("x"))))
    }

    @Test fun equipmentLinksOfThisServer() {
        val base = "https://chat.example.com"
        val id = "0c9a1f0e-1b2c-4d3e-8f40-5a6b7c8d9e0f"
        assertEquals(id, Permalink.equipmentId(base, "https://chat.example.com/eq/$id"))
        assertEquals(id, Permalink.equipmentId("$base/", "HTTPS://CHAT.EXAMPLE.COM/eq/${id.uppercase()}?x=1#y"))
        assertNull(Permalink.equipmentId(base, "https://chat.example.com/eq/not-an-id"))
        assertNull(Permalink.equipmentId(base, "https://other.example.com/eq/$id"))
        assertNull(Permalink.equipmentId(base, "https://chat.example.com/e/$id")) // an event's
        assertNull(Permalink.eventId(base, "https://chat.example.com/eq/$id"))
        assertEquals("https://chat.example.com/eq/$id", Permalink.equipmentUrl("$base/", id))
    }
}
