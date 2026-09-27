package jp.chikuwachat.android

import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ChannelLinks
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Links pinned to the top of a conversation (M15f). */
class ChannelLinksTest {
    @Test fun onlyHttpLinksAreAccepted() {
        assertTrue(ChannelLinks.validUrl("https://example.com/doc"))
        assertTrue(ChannelLinks.validUrl(" http://grafana.local/d/1 "))
        listOf("javascript:alert(1)", "data:text/html,x", "ftp://example.com", "https://", "https://a b", "example.com").forEach {
            assertFalse(it, ChannelLinks.validUrl(it))
        }
    }

    @Test fun linksLoadWhenTheConversationOpensAndFollowChanges() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        server.setLinks(channel.id, listOf("設計書"))
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); engine.idle()
        assertEquals(emptyList<Any>(), store.linksOf(channel.id)) // not part of bootstrap
        engine.openChannel(channel.id); engine.idle()
        assertEquals(listOf("設計書"), store.linksOf(channel.id).map { it.title })
        server.setLinks(channel.id, listOf("設計書", "監視")); engine.idle()
        assertEquals(listOf("設計書", "監視"), store.linksOf(channel.id).map { it.title })
        engine.stop(); scope.cancel()
    }
}
