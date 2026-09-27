package jp.chikuwachat.android

import jp.chikuwachat.android.sync.Draft
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Drafts shared by my devices (M15d); same scenarios as the desktop and iOS tests. */
class DraftSyncTest {
    private class Devices(val server: FakeServer, val bob: String, val channelId: String, val laptop: Store, val phone: Store, val a: SyncEngine, val b: SyncEngine, val scope: CoroutineScope)

    /** Drafts are saved only when a test says so (flushDrafts), or at once when emptied. */
    private fun engine(server: FakeServer, userId: String, store: Store, scope: CoroutineScope) =
        SyncEngine(server.api(userId), server.connector(userId), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}, draftSaveMs = 60_000))

    private suspend fun settle(vararg engines: SyncEngine) = repeat(3) { engines.forEach { it.idle() } }

    private suspend fun devices(): Devices {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val laptop = Store(); val phone = Store()
        val a = engine(server, bob.id, laptop, scope); val b = engine(server, bob.id, phone, scope)
        a.start(); b.start(); settle(a, b)
        return Devices(server, bob.id, channel.id, laptop, phone, a, b, scope)
    }

    @Test fun draftReachesMyOtherDeviceAndGoesAwayOnceSent() = runBlocking {
        val d = devices()
        d.laptop.setDraft(d.channelId) { it.copy(text = "書きかけ") }
        assertTrue(d.laptop.draft(d.channelId).dirty)
        d.a.flushDrafts(); settle(d.a, d.b)
        assertEquals(listOf("書きかけ"), d.server.draftsOf(d.bob).map { it.body })
        assertFalse(d.laptop.draft(d.channelId).dirty)
        assertEquals("書きかけ", d.phone.draft(d.channelId).text)
        assertEquals(listOf("書きかけ"), d.phone.listDrafts().map { it.draft.text })

        d.laptop.setDraft(d.channelId) { Draft() } // sending empties the composer: deleted at once
        settle(d.a, d.b)
        assertEquals(emptyList<Any>(), d.server.draftsOf(d.bob))
        assertEquals("", d.phone.draft(d.channelId).text)
        assertTrue(d.laptop.draftEntries().isEmpty())
        d.a.stop(); d.b.stop(); d.scope.cancel()
    }

    @Test fun unsavedEditsHereWinOverAnotherDevicesSave() = runBlocking {
        val d = devices()
        d.phone.setDraft(d.channelId) { it.copy(text = "スマホで書いた") }
        d.laptop.setDraft(d.channelId) { it.copy(text = "PC で書いた") }
        d.a.flushDrafts(); settle(d.a, d.b)
        assertEquals("スマホで書いた", d.phone.draft(d.channelId).text)
        d.b.flushDrafts(); settle(d.a, d.b)
        assertEquals("スマホで書いた", d.laptop.draft(d.channelId).text)
        d.a.stop(); d.b.stop(); d.scope.cancel()
    }

    @Test fun bootstrapTakesServerDraftsPushesOlderOnesAndForgetsDeletedOnes() = runBlocking {
        val d = devices()
        val other = d.server.createChannel("random", d.bob)
        d.laptop.setDraft(d.channelId) { it.copy(text = "共有される") }
        d.a.flushDrafts()

        val tablet = Store()
        tablet.setDraft(other.id) { it.copy(text = "昔の下書き") }
        tablet.markDraftSaved(other.id, null, "昔の下書き", null) // as if written before M15d
        tablet.applyRemoteDraft(d.channelId, "gone-parent", "消された", "2026-09-27T00:00:00Z")
        val c = engine(d.server, d.bob, tablet, d.scope)
        c.start(); settle(c)
        assertEquals("共有される", tablet.draft(d.channelId).text)
        assertEquals("", tablet.draft(d.channelId, "gone-parent").text)
        assertEquals(listOf("共有される", "昔の下書き"), d.server.draftsOf(d.bob).map { it.body }.sorted())
        d.a.stop(); d.b.stop(); c.stop(); d.scope.cancel()
    }
}
