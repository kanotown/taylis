package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.OkHttpWsTransport
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.UUID

/**
 * End-to-end check against a running backend (skipped unless LIVE_URL is set), using the real
 * ApiClient, OkHttp WebSocket transport and SyncEngine:
 *   LIVE_URL=http://127.0.0.1:8000 LIVE_USER=alice LIVE_PASSWORD=... LIVE_PEER=bob LIVE_PEER_PASSWORD=... ./gradlew :app:testDebugUnitTest --tests '*LiveBackendTest*'
 */
class LiveBackendTest {
    @Test fun loginSyncSendAndReceive() = runBlocking {
        val url = System.getenv("LIVE_URL")
        assumeTrue("LIVE_URL not set", !url.isNullOrBlank())
        val user = System.getenv("LIVE_USER") ?: "alice"
        val password = System.getenv("LIVE_PASSWORD") ?: "password123"
        val peer = System.getenv("LIVE_PEER") ?: "bob"
        val peerPassword = System.getenv("LIVE_PEER_PASSWORD") ?: password

        val http = OkHttpClient()
        val api = ApiClient(url!!, http)
        api.login(user, password, "android", "junit", "test")
        val peerApi = ApiClient(url, http)
        val peerTokens = peerApi.login(peer, peerPassword, "android", "junit-peer", "test")

        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
        val engine = SyncEngine(api, { wsUrl, _ -> OkHttpWsTransport.connect(http, wsUrl) }, api.wsUrl, store, { api.accessToken }, scope, EngineOptions())
        engine.isActive = { false }
        try {
            withTimeout(15_000) { engine.start() }
            assertEquals(EngineStatus.ONLINE, engine.status.value)
            val me = store.me!!
            assertEquals(user, me.username)

            // A DM with the peer: send from this client, then receive the peer's reply over the socket.
            val dm = api.createDm(listOf(peerTokens.user.id))
            store.upsertChannel(dm, isMember = true)
            engine.openChannel(dm.id)
            val mine = "android live " + UUID.randomUUID()
            engine.send(dm.id, mine)
            engine.idle()
            assertTrue(store.messages(dm.id).any { it.body == mine && it.seq != null })

            val reply = "peer reply " + UUID.randomUUID()
            peerApi.postMessage(dm.id, UUID.randomUUID().toString(), reply)
            withTimeout(10_000) {
                while (store.messages(dm.id).none { it.body == reply }) delay(100)
            }
            val channel = store.channel(dm.id)!!
            assertEquals(channel.lastSeq, channel.syncedSeq)
        } finally {
            engine.stop()
            scope.cancel()
            runCatching { api.logout() }
            runCatching { peerApi.logout() }
        }
    }
}
