package jp.chikuwachat.android

import jp.chikuwachat.android.api.AiAgentPublic
import jp.chikuwachat.android.api.AiAskIn
import jp.chikuwachat.android.api.AiRunOut
import jp.chikuwachat.android.api.AiRunUpdated
import jp.chikuwachat.android.api.AiSourceOut
import jp.chikuwachat.android.api.AiStatusOut
import jp.chikuwachat.android.api.AiSummaryIn
import jp.chikuwachat.android.api.AiSummaryTargetOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ErrorMessages
import jp.chikuwachat.android.sync.AiApi
import jp.chikuwachat.android.sync.AiAskState
import jp.chikuwachat.android.sync.AiHub
import jp.chikuwachat.android.sync.AiSummaryPhase
import jp.chikuwachat.android.sync.AiSummaryRequest
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.AiTexts
import jp.chikuwachat.android.ui.Search
import jp.chikuwachat.android.ui.SearchDate
import jp.chikuwachat.android.ui.SearchParams
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/** M71 (docs/AI.md §13): 「AI に聞く」 on Android — decoding, the question, [n] links, the hub's states and the words. */
class AiAskTest {
    private class World(val server: FakeServer, val api: FakeServer.Api, val bob: String, val channelId: String, val engine: SyncEngine, val scope: CoroutineScope) {
        val hub: AiHub get() = engine.ai
    }

    private suspend fun settle(engine: SyncEngine) = repeat(3) { engine.idle() }

    private suspend fun world(target: AiSummaryTargetOut? = AiSummaryTargetOut(true, "anthropic", "claude-opus-5-5", "ちくわ")): World {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val bot = server.addUser("ai-chikuwa", role = "bot")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        server.aiStatus = AiStatusOut(true, true, listOf(AiAgentPublic("agent-1", bot.id, "ちくわ", "claude-opus-5-5")))
        server.aiAskTarget = target
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val api = server.api(bob.id)
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", Store(), { "t" }, scope, EngineOptions(sleep = {}, reconnectMinMs = 0))
        engine.start(); settle(engine)
        return World(server, api, bob.id, channel.id, engine, scope)
    }

    private fun World.finish() {
        engine.stop(); scope.cancel()
    }

    private suspend fun World.reconnect() {
        server.disconnect(bob)
        repeat(50) { if (engine.status.value != EngineStatus.ONLINE) settle(engine) }
        settle(engine)
        assertEquals(EngineStatus.ONLINE, engine.status.value)
    }

    private fun source(n: Int, id: String = "0000000$n-0000-7000-8000-000000000000", parent: String? = null) =
        AiSourceOut(n, id, "c1", parent, "u1", "2026-10-02T09:00:00Z", "抜粋 $n")

    // --- decoding ---------------------------------------------------------------------------------------

    @Test fun askRunsDecodeLeniently() {
        val run = Codec.snake.decodeFromString(
            AiRunOut.serializer(),
            """{"id":"r","kind":"ask","status":"done","channel_id":null,"question":"発表はいつ？ in:#general","output":"金曜です [1]",
               "sources":[{"n":1,"message_id":"m1","channel_id":"c1","parent_id":null,"sender_id":"u1","created_at":"t","excerpt":"金曜","future":1},
                          {"n":2},{"message_id":"m0"}],"omitted_count":2,"provider":"openai","model":"gpt-6.1-sol","extra":true}""",
        )
        assertEquals("ask", run.kind)
        assertNull(run.channelId)
        assertEquals("発表はいつ？ in:#general", run.question)
        assertEquals(3, run.sources!!.size)
        assertEquals(listOf("m1"), run.citedSources.map { it.messageId }) // no id / no number: not openable, left out
        assertEquals(2, run.omittedCount)

        val bare = Codec.snake.decodeFromString(AiRunOut.serializer(), """{"id":"r","sources":null,"question":null}""")
        assertEquals(emptyList<AiSourceOut>(), bare.citedSources)
        assertNull(bare.question)
        val summary = Codec.snake.decodeFromString(AiRunOut.serializer(), """{"id":"r","kind":"summary","channel_id":"c"}""")
        assertNull(summary.sources)

        val unordered = AiRunOut("r", sources = listOf(source(3), source(1)))
        assertEquals(listOf(1, 3), unordered.citedSources.map { it.n })

        val body = Codec.snake.encodeToJsonElement(AiAskIn.serializer(), AiAskIn("質問", tzOffsetMinutes = 540)).jsonObject
        assertEquals(setOf("q", "tz_offset_minutes"), body.keys)
        val narrowed = Codec.snake.encodeToJsonElement(AiAskIn.serializer(), AiAskIn("質問", 540, "c1")).jsonObject
        assertEquals(setOf("q", "tz_offset_minutes", "channel_id"), narrowed.keys)
    }

    // --- the question -----------------------------------------------------------------------------------

    @Test fun theQuestionIsTheWordsAndTheChipsAsModifiers() {
        val today = LocalDate.of(2026, 10, 2)
        val names = mapOf("u1" to "tanaka")
        fun ask(params: SearchParams) = Search.askQuery(params, { names[it] }, today)
        assertEquals("発表はいつ", ask(SearchParams(q = "  発表はいつ ")))
        assertEquals("発表 from:@tanaka", ask(SearchParams(q = "発表", fromUserId = "u1")))
        assertEquals("発表", ask(SearchParams(q = "発表", fromUserId = "unknown"))) // a name not known: no modifier
        assertEquals("発表 after:2026-10-01", ask(SearchParams(q = "発表", date = SearchDate(preset = "today"))))
        assertEquals("発表 after:2026-09-30 before:2026-10-02", ask(SearchParams(q = "発表", date = SearchDate(preset = "yesterday"))))
        assertEquals("発表 after:2026-09-25", ask(SearchParams(q = "発表", date = SearchDate(preset = "week"))))
        assertEquals("x after:2026-08-31 before:2026-09-16", ask(SearchParams(q = "x", date = SearchDate(from = "2026-09-01", to = "2026-09-15"))))
        assertEquals("x before:2026-09-16", ask(SearchParams(q = "x", date = SearchDate(to = "2026-09-15"))))
        assertEquals(
            "設計 has:file has:link is:thread is:times",
            ask(SearchParams(q = "設計", has = listOf("file", "bogus", "link"), isThread = true, isTimes = true)),
        )
        assertEquals("in:#general 決定", ask(SearchParams(q = "in:#general 決定", channelId = "c1"))) // the conversation goes apart
        assertEquals("", ask(SearchParams(channelId = "c1")))
        assertEquals("is:thread", ask(SearchParams(isThread = true)))

        assertFalse(AiTexts.askTooLong("あ".repeat(Search.ASK_MAX)))
        assertTrue(AiTexts.askTooLong("あ".repeat(Search.ASK_MAX + 1)))
        assertFalse(AiTexts.askTooLong("😀".repeat(Search.ASK_MAX))) // counted in characters, not UTF-16 units
    }

    // --- [n] as links --------------------------------------------------------------------------------------

    @Test fun citationsBecomeMessageLinks() {
        val base = "https://chat.example.jp/"
        val sources = listOf(source(1, "m-1"), source(3, "m-3"), source(4, "m-4"))
        fun link(text: String) = AiTexts.linkCitations(text, sources, base)
        assertEquals("金曜です [3](https://chat.example.jp/m/m-3)。", link("金曜です [3]。"))
        assertEquals("[1](https://chat.example.jp/m/m-1)[4](https://chat.example.jp/m/m-4)", link("[1][4]"))
        assertEquals("[1](https://chat.example.jp/m/m-1) [4](https://chat.example.jp/m/m-4)", link("[1, 4]"))
        assertEquals("[1](https://chat.example.jp/m/m-1) [3](https://chat.example.jp/m/m-3)", link("[1、3]"))
        assertEquals("[2] と [1, 2]", link("[2] と [1, 2]")) // a number not among the sources: left as written
        assertEquals("[1](https://example.com)", link("[1](https://example.com)")) // already a link
        assertEquals("- [ ] やること", link("- [ ] やること"))
        assertEquals("[3]", AiTexts.linkCitations("[3]", emptyList(), base))
        assertEquals("[1]", AiTexts.linkCitations("[1]", listOf(AiSourceOut(1)), base)) // no message id: no link
    }

    // --- the words --------------------------------------------------------------------------------------

    @Test fun targetLineProgressAndNotes() {
        assertEquals("質問は ちくわ (Anthropic) に送られます", AiTexts.askTargetLine(AiSummaryTargetOut(true, "anthropic", "claude-opus-5-5", "ちくわ")))
        assertEquals("質問は OpenAI に送られます", AiTexts.askTargetLine(AiSummaryTargetOut(true, "openai")))
        assertNull(AiTexts.askTargetLine(AiSummaryTargetOut(true)))
        assertNull(AiTexts.askTargetLine(null))
        assertEquals("この会話のボットは非公開の会話を読めないため、ここでは聞けません", AiTexts.askTargetLine(AiSummaryTargetOut(false, "anthropic", reason = "ai_private_not_allowed")))
        assertEquals("今月の AI の利用上限に達しました", AiTexts.askTargetLine(AiSummaryTargetOut(false, reason = "ai_budget_exceeded")))
        assertEquals(ErrorMessages.byCode.getValue("ai_unavailable"), AiTexts.askTargetLine(AiSummaryTargetOut(false, reason = "ai_unavailable")))
        assertEquals("今は AI に聞けません", AiTexts.askTargetLine(AiSummaryTargetOut(false, reason = "something_new")))

        assertEquals("メッセージを探しています…", AiTexts.askProgress(AiAskState("q", null)))
        assertEquals("メッセージを探しています…", AiTexts.askProgress(AiAskState("q", null, AiRunOut("r", kind = "ask"))))
        assertEquals("答えを書いています…", AiTexts.askProgress(AiAskState("q", null, AiRunOut("r", kind = "ask", status = "running"))))
        assertNull(AiTexts.askProgress(AiAskState("q", null, AiRunOut("r", kind = "ask", status = "done"))))
        assertEquals("非公開の会話の 4 件は、このボットに送れないため除きました", AiTexts.askOmittedNote(4))
        assertNull(AiTexts.askOmittedNote(0))
        assertEquals("田中 · #general · スレッド · 10/2 18:00", AiTexts.sourceLine("田中", "#general", true, "10/2 18:00"))
        assertEquals("田中 · DM", AiTexts.sourceLine("田中", "DM", false, ""))
        assertNull(AiTexts.historyStatus(AiRunOut("r", status = "done")))
        assertEquals("失敗", AiTexts.historyStatus(AiRunOut("r", status = "failed")))
        assertEquals("作成中", AiTexts.historyStatus(AiRunOut("r", status = "running")))
    }

    @Test fun askStatePhasesAndFailureWords() {
        assertEquals(AiSummaryPhase.REQUESTING, AiAskState("q", null).phase)
        assertEquals(AiSummaryPhase.RUNNING, AiAskState("q", null, AiRunOut("r", status = "pending")).phase)
        assertEquals(AiSummaryPhase.RUNNING, AiAskState("q", null, AiRunOut("r", status = "something_new")).phase)
        assertEquals(AiSummaryPhase.DONE, AiAskState("q", null, AiRunOut("r", status = "done")).phase)
        val failed = AiAskState("q", null, AiRunOut("r", status = "failed", error = "質問に使うボットが無効になりました"))
        assertEquals(AiSummaryPhase.FAILED, failed.phase)
        assertEquals("答えられませんでした: 質問に使うボットが無効になりました", failed.failureText)
        assertEquals("答えられませんでした", AiAskState("q", null, AiRunOut("r", status = "failed")).failureText)
        assertEquals(AiSummaryPhase.FAILED, AiAskState("q", null, error = "x").phase)
        assertNull(AiAskState("q", null, AiRunOut("r", status = "done")).failureText)
    }

    // --- the hub ----------------------------------------------------------------------------------------

    @Test fun theTargetIsReadPerQuestionAndAnOlderServerHidesTheEntry() = runBlocking {
        val w = world()
        w.hub.loadAskTarget("発表 is:thread", w.channelId)
        assertEquals(listOf("発表 is:thread" to w.channelId), w.api.askTargetCalls)
        assertEquals("ちくわ", w.hub.askTargetFor("発表 is:thread", w.channelId)!!.agentName)
        assertNull(w.hub.askTargetFor("発表 is:thread", null)) // another conversation: not this answer
        assertNull(w.hub.askTargetFor("別の質問", w.channelId))

        w.server.aiAskTarget = null // a server before M70: 404
        w.hub.loadAskTarget("発表 is:thread", w.channelId)
        assertNull(w.hub.askTargetFor("発表 is:thread", w.channelId))
        w.finish()
    }

    @Test fun aQuestionFollowsItsRunToTheAnswerWithSources() = runBlocking {
        val w = world()
        w.hub.startAsk("発表はいつ？ after:2026-09-01", w.channelId)
        val sent = w.api.askRequests.single()
        assertEquals("発表はいつ？ after:2026-09-01", sent.q)
        assertEquals(w.channelId, sent.channelId)
        assertTrue(sent.tzOffsetMinutes != null)
        val runId = w.hub.ask!!.run!!.id
        assertEquals(AiSummaryPhase.RUNNING, w.hub.ask!!.phase)

        w.server.advanceAiRun(runId, "running"); settle(w.engine)
        assertEquals("答えを書いています…", AiTexts.askProgress(w.hub.ask!!))
        w.server.advanceAiRun(runId, "done", output = "金曜です [1]", omittedCount = 2, sources = listOf(source(1, "m-1"))); settle(w.engine)
        val done = w.hub.ask!!
        assertEquals(AiSummaryPhase.DONE, done.phase)
        assertEquals("金曜です [1]", done.run!!.output)
        assertEquals(listOf("m-1"), done.run!!.citedSources.map { it.messageId })
        assertEquals("Anthropic · claude-opus-5-5", AiTexts.runCaption(done.run))
        assertNull(w.hub.summary) // the summary sheet is not touched

        w.hub.closeAsk()
        assertNull(w.hub.ask)
        w.finish()
    }

    @Test fun askAndSummaryRunsGoToTheirOwnSheets() = runBlocking {
        val w = world()
        w.hub.requestSummary(AiSummaryRequest(w.channelId, "unread"))
        w.hub.startAsk("発表", null)
        val summaryId = w.hub.summary!!.run!!.id
        val askId = w.hub.ask!!.run!!.id
        w.server.advanceAiRun(askId, "done", output = "答え"); settle(w.engine)
        assertEquals(AiSummaryPhase.RUNNING, w.hub.summary!!.phase)
        assertEquals(AiSummaryPhase.DONE, w.hub.ask!!.phase)
        w.server.advanceAiRun(summaryId, "done", output = "要約"); settle(w.engine)
        assertEquals("要約", w.hub.summary!!.run!!.output)
        assertEquals("答え", w.hub.ask!!.run!!.output)
        w.finish()
    }

    @Test fun aMissedEventIsReadAgainAfterReconnecting() = runBlocking {
        val w = world()
        w.hub.startAsk("発表", null)
        val runId = w.hub.ask!!.run!!.id
        w.server.advanceAiRun(runId, "done", output = "金曜", silent = true) // the event is lost
        assertEquals(AiSummaryPhase.RUNNING, w.hub.ask!!.phase)
        w.reconnect()
        assertEquals(listOf(runId), w.api.aiRunCalls)
        assertEquals("金曜", w.hub.ask!!.run!!.output)
        w.reconnect() // finished: not read again
        assertEquals(listOf(runId), w.api.aiRunCalls)
        w.finish()
    }

    @Test fun refusalsAreWordedAndTurnOffsAreReadAgain() = runBlocking {
        val w = world()
        for (code in listOf("ai_daily_limit", "search_busy", "search_timeout")) {
            w.server.aiAskRefusals.add(ApiException.Api(if (code == "ai_daily_limit") 429 else 503, code, "x"))
            w.hub.startAsk("発表", null)
            assertEquals(AiSummaryPhase.FAILED, w.hub.ask!!.phase)
            assertEquals(code, ErrorMessages.byCode.getValue(code), w.hub.ask!!.failureText)
        }
        val statusReads = w.api.aiStatusCalls
        val targetReads = w.api.askTargetCalls.size
        w.server.aiAskRefusals.add(ApiException.Api(409, "ai_private_not_allowed", "x"))
        w.hub.startAsk("発表", w.channelId)
        assertEquals(ErrorMessages.byCode.getValue("ai_private_not_allowed"), w.hub.ask!!.failureText)
        assertEquals(statusReads + 1, w.api.aiStatusCalls)
        assertEquals(targetReads + 1, w.api.askTargetCalls.size) // the bar follows the server again

        w.api.pendingFailure = ApiException.Network(RuntimeException("offline"))
        w.hub.startAsk("発表", null)
        assertEquals(ErrorMessages.NETWORK, w.hub.ask!!.failureText)
        w.hub.retryAsk() // 「もう一度」: a new POST
        assertEquals(AiSummaryPhase.RUNNING, w.hub.ask!!.phase)

        w.hub.startAsk("発表", "00000000-0000-7000-8000-999999999999")
        assertEquals(ErrorMessages.byCode["channel_not_found"], w.hub.ask!!.failureText)

        w.hub.startAsk("発表", null)
        w.server.advanceAiRun(w.hub.ask!!.run!!.id, "failed", error = "API のエラーが続きました"); settle(w.engine)
        assertEquals("答えられませんでした: API のエラーが続きました", w.hub.ask!!.failureText)
        w.finish()
    }

    @Test fun historyListsMyQuestionsAndAnUnfinishedOneIsReadAgain() = runBlocking {
        val w = world()
        w.hub.requestSummary(AiSummaryRequest(w.channelId, "unread")) // not a question
        w.hub.startAsk("一つ目", null)
        val first = w.hub.ask!!.run!!.id
        w.server.advanceAiRun(first, "done", output = "答え 1", silent = true)
        w.hub.startAsk("二つ目", null)
        val history = w.hub.askHistory()!!
        assertEquals(listOf("二つ目", "一つ目"), history.map { it.question })

        val unfinished = history.first()
        w.hub.showAskRun(unfinished)
        assertEquals("二つ目", w.hub.ask!!.question)
        assertEquals(listOf(unfinished.id), w.api.aiRunCalls) // not finished: read again at once
        w.hub.showAskRun(history.last())
        assertEquals("答え 1", w.hub.ask!!.run!!.output)
        assertEquals(1, w.api.aiRunCalls.size) // finished: shown as it is

        w.server.aiAskTarget = null // an older server
        assertNull(w.hub.askHistory())
        w.finish()
    }

    @Test fun stopForgetsTheQuestion() = runBlocking {
        val w = world()
        w.hub.loadAskTarget("発表", null)
        w.hub.startAsk("発表", null)
        w.hub.stop()
        assertNull(w.hub.ask)
        assertNull(w.hub.askTarget)
        w.finish()
    }

    // --- ordering and races -----------------------------------------------------------------------------

    private class GatedApi : AiApi {
        val gate = CompletableDeferred<AiRunOut>()
        override suspend fun aiStatus() = AiStatusOut(true, true)
        override suspend fun createSummary(body: AiSummaryIn): AiRunOut = throw ApiException.Api(409, "ai_unavailable", "x")
        override suspend fun aiRun(runId: String): AiRunOut = throw ApiException.Api(404, "ai_run_not_found", "x")
        override suspend fun summaryTarget(channelId: String): AiSummaryTargetOut = throw ApiException.Api(404, "http_404", "x")
        override suspend fun createAsk(body: AiAskIn): AiRunOut = gate.await()
    }

    private fun event(run: AiRunOut): JsonObject = Codec.snake.encodeToJsonElement(AiRunUpdated.serializer(), AiRunUpdated(run)) as JsonObject

    @Test fun anEventBeforeThePostAnswerIsKept() = runBlocking {
        val api = GatedApi()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val hub = AiHub(api, scope) { 540 }
        val job = scope.launch { hub.startAsk("発表", null) }
        assertEquals(AiSummaryPhase.REQUESTING, hub.ask!!.phase)
        hub.applyEvent("ai.run_updated", event(AiRunOut("r1", kind = "ask", status = "done", output = "早い")))
        api.gate.complete(AiRunOut("r1", kind = "ask", status = "pending"))
        job.join()
        assertEquals(AiSummaryPhase.DONE, hub.ask!!.phase)
        assertEquals("早い", hub.ask!!.run!!.output)
        // A late, older copy does not take it back.
        hub.applyEvent("ai.run_updated", event(AiRunOut("r1", kind = "ask", status = "running")))
        assertEquals(AiSummaryPhase.DONE, hub.ask!!.phase)
    }

    @Test fun closingDropsAnAnswerStillOnItsWay() = runBlocking {
        val api = GatedApi()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val hub = AiHub(api, scope)
        val job = scope.launch { hub.startAsk("発表", null) }
        hub.closeAsk()
        api.gate.complete(AiRunOut("r", kind = "ask", status = "pending"))
        job.join()
        assertNull(hub.ask)
    }

    @Test fun aFakeWithoutTheRoutesActsLikeAnOlderServer() = runBlocking {
        val api = object : AiApi {
            override suspend fun aiStatus() = AiStatusOut(true, true)
            override suspend fun createSummary(body: AiSummaryIn): AiRunOut = throw IllegalStateException()
            override suspend fun aiRun(runId: String): AiRunOut = throw IllegalStateException()
            override suspend fun summaryTarget(channelId: String): AiSummaryTargetOut = throw IllegalStateException()
        }
        val hub = AiHub(api, CoroutineScope(Dispatchers.Unconfined))
        hub.loadAskTarget("q", null)
        assertNull(hub.askTargetFor("q", null))
        assertNull(hub.askHistory())
        hub.startAsk("q", null)
        assertEquals(AiSummaryPhase.FAILED, hub.ask!!.phase)
    }
}
