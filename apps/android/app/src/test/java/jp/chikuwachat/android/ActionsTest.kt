package jp.chikuwachat.android

import java.io.IOException
import jp.chikuwachat.android.api.ActionInvokeOut
import jp.chikuwachat.android.api.ActionListOut
import jp.chikuwachat.android.api.ActionOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.NavItem
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ActionRules
import jp.chikuwachat.android.ui.HomeTile
import jp.chikuwachat.android.ui.HomeTiles
import jp.chikuwachat.android.ui.NavItems
import jp.chikuwachat.android.ui.Route
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M143 (docs/ACTIONS.md §9): 操作ボタン on Android — decoding, groups and texts, who sees them (off, guests, the 在室状況
 * placement), the home tile, one press per client_invoke_id across network retries, the error texts, and the sync.
 */
class ActionsTest {
    private fun action(id: String, name: String, group: String? = null, position: Int = 0, confirm: Boolean = true, confirmText: String? = null) =
        ActionOut(id = id, name = name, groupLabel = group, icon = null, emoji = "🔓", confirm = confirm, confirmText = confirmText, position = position)

    private val unlock = action("a1", "開ける", group = "研究室の鍵", position = 0)
    private val lock = action("a2", "閉める", group = "研究室の鍵", position = 1, confirm = false)
    private val light = action("a3", "照明", position = 2, confirm = false)
    private val prof = action("a4", "開ける", group = "教授室", position = 3, confirmText = "教授室の鍵を開けます。よろしいですか？")
    private val list = ActionListOut(enabled = true, showOnAttendance = false, actions = listOf(light, prof, lock, unlock))

    private fun result(ok: Boolean, error: String? = null, message: String? = null, statusCode: Int? = null, status: String = if (ok) "succeeded" else "failed") =
        ActionInvokeOut(invokeId = "i", actionId = "a1", ok = ok, status = status, statusCode = statusCode, error = error, message = message, at = "2026-10-08T00:00:00Z")

    @Test fun decodesTheServersShapes() {
        val listJson = """
            {"enabled": true, "show_on_attendance": true,
             "actions": [{"id": "0192f0c2-0000-7000-8000-000000000001", "name": "開ける", "group_label": "研究室の鍵", "icon": "door-open",
                          "emoji": "🔓", "confirm": true, "confirm_text": null, "position": 0}]}
        """.trimIndent()
        val decoded = Codec.snake.decodeFromString(ActionListOut.serializer(), listJson)
        assertTrue(decoded.showOnAttendance)
        assertEquals("研究室の鍵", decoded.actions.single().groupLabel)
        assertEquals("door-open", decoded.actions.single().icon)
        assertNull(decoded.actions.single().confirmText)
        // From a server that leaves the placement out: off.
        assertFalse(Codec.snake.decodeFromString(ActionListOut.serializer(), """{"enabled": false}""").showOnAttendance)
        val invokeJson = """
            {"invoke_id": "i1", "action_id": "a1", "ok": false, "status": "failed", "status_code": null, "error": "timeout",
             "message": null, "at": "2026-10-07T09:15:00Z", "repeated": true}
        """.trimIndent()
        val out = Codec.snake.decodeFromString(ActionInvokeOut.serializer(), invokeJson)
        assertEquals("timeout", out.error)
        assertTrue(out.repeated)
        assertNull(out.statusCode)
    }

    @Test fun groupsInOrderWithTheUngroupedLast() {
        val groups = ActionRules.groups(list.actions)
        assertEquals(listOf("研究室の鍵", "教授室", null), groups.map { it.label })
        assertEquals(listOf("a1", "a2"), groups[0].actions.map { it.id })
        assertEquals(listOf("a3"), groups[2].actions.map { it.id })
        // A blank group is no group.
        assertEquals(listOf<String?>(null), ActionRules.groups(listOf(action("x", "x", group = "  "))).map { it.label })
    }

    @Test fun titlesAndTheConfirmation() {
        assertEquals("研究室の鍵：開ける", ActionRules.title(unlock))
        assertEquals("照明", ActionRules.title(light))
        assertEquals("研究室の鍵：開ける を実行しますか？", ActionRules.confirmText(unlock))
        assertEquals("教授室の鍵を開けます。よろしいですか？", ActionRules.confirmText(prof))
    }

    @Test fun whoSeesThemOffGuestsAndTheAttendancePlacement() {
        assertTrue(ActionRules.shown(list, "member"))
        assertFalse(ActionRules.shown(list.copy(enabled = false), "member"))
        assertFalse(ActionRules.shown(list.copy(actions = emptyList()), "admin"))
        assertFalse(ActionRules.shown(null, "member"))
        assertFalse(ActionRules.shown(list, "guest"))
        assertTrue(ActionRules.onAttendance(list, "member").isEmpty())
        assertEquals(4, ActionRules.onAttendance(list.copy(showOnAttendance = true), "member").size)
        assertTrue(ActionRules.onAttendance(list.copy(showOnAttendance = true, enabled = false), "member").isEmpty())
        // The store keeps none while off, nor for a guest.
        val store = Store()
        store.setActions(list.copy(enabled = false))
        assertNull(store.actions)
        store.setActions(list)
        assertEquals(4, store.actions!!.actions.size)
        store.setMe(UserMe("g", "g", "G", "guest", null, "t", "t", null, false))
        store.setActions(list)
        assertNull(store.actions)
    }

    @Test fun theTileAndTheSettingsRowOnlyWhileIMayPressOne() {
        assertTrue(NavItems.catalogue.single { it.key == "actions" }.platforms.contains(NavItems.Platform.MOBILE))
        val off = HomeTiles.tiles(ThreadSummary(0, 0), 0, 0, 0, navItems = null)
        assertTrue(off.none { it.tile == HomeTile.ACTIONS })
        val on = HomeTiles.tiles(ThreadSummary(0, 0), 0, 0, 0, navItems = null, attendance = true, actions = true)
        assertEquals(listOf(HomeTile.ATTENDANCE, HomeTile.ACTIONS), on.takeLast(2).map { it.tile })  // last in the mobile order
        assertNull(on.last().count)
        assertEquals("actions", HomeTile.ACTIONS.navKey)
        assertEquals("操作", HomeTile.ACTIONS.label)
        assertFalse("actions" in NavItems.implemented)
        assertTrue("actions" in NavItems.implemented(attendance = false, actions = true))
        val hidden = HomeTiles.tiles(ThreadSummary(0, 0), 0, 0, 0, navItems = listOf(NavItem("actions", false)), actions = true)
        assertTrue(hidden.none { it.tile == HomeTile.ACTIONS })
        assertTrue(Route.Actions.keptUnderConversation)
    }

    @Test fun theOutcomeInWords() {
        assertEquals(ActionRules.Result(true, "解錠しました"), ActionRules.resultText(result(true, message = "解錠しました"), unlock))
        assertEquals(ActionRules.Result(true, "研究室の鍵：開ける を実行しました"), ActionRules.resultText(result(true), unlock))
        assertEquals(ActionRules.Result(false, "電池が切れています"), ActionRules.resultText(result(false, "relay_error", "電池が切れています", 503), unlock))
        assertEquals(
            "機器（またはハブ）から応答がありませんでした。実行されたかどうかわかりません。状態を確かめてください",
            ActionRules.resultText(result(false, "timeout"), unlock).text,
        )
        assertEquals("機器（またはハブ）に接続できませんでした。オフラインかもしれません", ActionRules.resultText(result(false, "network"), unlock).text)
        assertEquals("実行できませんでした（HTTP 503）", ActionRules.resultText(result(false, "relay_error", statusCode = 503), unlock).text)
        assertEquals("このボタンの設定に問題があります。管理者に連絡してください", ActionRules.resultText(result(false, "secret_missing"), unlock).text)
        assertEquals("このボタンの設定に問題があります。管理者に連絡してください", ActionRules.resultText(result(false, "url_not_allowed"), unlock).text)
        assertTrue(ActionRules.resultText(result(false, "interrupted"), unlock).text.startsWith("送信が途中で止まりました"))
        assertTrue(ActionRules.resultText(result(false, status = "pending"), unlock).text.startsWith("まだ処理中です"))
        assertEquals("実行できませんでした", ActionRules.resultText(result(false, "something_new"), unlock).text)
    }

    @Test fun refusalsUseTheSharedErrorTable() {
        assertEquals("少し待ってからもう一度押してください", ActionRules.refusalText(ApiException.Api(429, "rate_limited", "slow down")))
        // The regenerated table (apps/shared/errors.json) knows the actions' codes.
        for (code in listOf("actions_disabled", "action_not_found", "action_disabled", "action_not_allowed", "action_invoke_id_reused")) {
            val text = ActionRules.refusalText(ApiException.Api(409, code, "English from the server"))
            assertFalse(code, text.contains("English"))
            assertEquals(code, jp.chikuwachat.android.api.ErrorTexts.code(code), text)
        }
        assertEquals(jp.chikuwachat.android.api.ErrorTexts.network, ActionRules.refusalText(ApiException.Network(IOException("down"))))
    }

    @Test fun aNetworkFailureIsSentAgainWithTheSameIdAndTheRelayRunsOnce() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        server.actionList = list
        val api = server.api(alice.id)
        val waits = ArrayList<Long>()
        // The relay ran, but the answer was lost twice on the way back: the same id twice more, the first result answered.
        server.invokeLostAnswers.add(ApiException.Network(IOException("reset")))
        server.invokeLostAnswers.add(ApiException.Network(IOException("reset")))
        val out = ActionRules.invokeOnce("a1", api::invokeAction, wait = { waits += it })
        assertEquals(3, server.invokeCalls.size)
        assertEquals(1, server.invokeCalls.map { it.second }.toSet().size)
        assertEquals(1, server.relayCalls)
        assertTrue(out.repeated)
        assertEquals(listOf(1000L, 2000L), waits)
        // A new press is a new id (and a second relay call).
        ActionRules.invokeOnce("a1", api::invokeAction, wait = {})
        assertEquals(2, server.invokeCalls.map { it.second }.toSet().size)
        assertEquals(2, server.relayCalls)
    }

    @Test fun afterTwoRetriesTheNetworkErrorIsShownAndServerErrorsAreNeverRetried() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val api = server.api(alice.id)
        repeat(3) { server.invokeFailures.add(ApiException.Network(IOException("offline"))) }
        try {
            ActionRules.invokeOnce("a1", api::invokeAction, wait = {}); fail("expected a network error")
        } catch (e: ApiException.Network) {
            assertEquals(3, server.invokeCalls.size)
        }
        assertEquals(0, server.relayCalls)
        server.invokeCalls.clear()
        server.invokeFailures.add(ApiException.Api(429, "rate_limited", "slow"))
        try {
            ActionRules.invokeOnce("a1", api::invokeAction, wait = {}); fail("expected the 429")
        } catch (e: ApiException.Api) {
            assertEquals(429, e.status)
        }
        assertEquals(1, server.invokeCalls.size)
        // A relay failure is an answer (HTTP 200, ok false): never sent again.
        server.invokeCalls.clear()
        server.relayAnswer["a1"] = result(false, "timeout")
        val out = ActionRules.invokeOnce("a1", api::invokeAction, wait = {})
        assertFalse(out.ok)
        assertEquals(1, server.invokeCalls.size)
    }

    @Test fun theButtonsComeWithTheBootstrapAndFollowActionsUpdated() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        server.createChannel("general", alice.id)
        server.actionList = list
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); engine.idle()
        assertEquals(4, store.actions!!.actions.size)
        val reads = server.actionsReads
        // A burst of actions.updated: one read.
        repeat(3) { server.configureActions(list.copy(showOnAttendance = true)) }
        engine.idle()
        delay(500)
        assertEquals(reads + 1, server.actionsReads)
        assertTrue(store.actions!!.showOnAttendance)
        // Turned off: the buttons go (the tile with them).
        server.configureActions(list.copy(enabled = false))
        engine.idle()
        delay(500)
        assertNull(store.actions)
        engine.stop(); scope.cancel()
    }

    @Test fun aGuestNeverHasThem() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val guest = server.addUser("visitor", role = "guest")
        server.createChannel("general", alice.id)
        server.actionList = list
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(guest.id), server.connector(guest.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); engine.idle()
        assertNull(store.actions)
        engine.loadActions()  // not even asked
        assertEquals(0, server.actionsReads)
        engine.stop(); scope.cancel()
    }
}
