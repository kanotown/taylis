package jp.chikuwachat.android

import java.time.Instant
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.PoolOut
import jp.chikuwachat.android.api.ReservationOut
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ReservationRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** M99 (docs/RESERVATIONS.md §6): a channel's reservation pools — decoding, the card's words, and live reloads. */
class ReservationsTest {
    private fun row(
        id: String, user: String, status: String = "waiting", position: Int? = null, step: String? = null, pair: String? = null,
        guarantee: String? = null, evict: String? = null, ready: Boolean = false,
    ) = ReservationOut(
        id = id, userId = user, status = status, requestedAt = "2026-10-04T00:00:00Z",
        assignedAt = if (status == "waiting") null else "2026-10-04T00:00:00Z", guaranteeUntil = guarantee, evictAt = evict,
        position = position, step = step, pairId = pair, ready = ready,
    )

    private fun pool(holders: List<ReservationOut>, waiting: List<ReservationOut>, mine: String? = null, next: String? = null) = PoolOut(
        id = "p1", channelId = "c1", name = "Claude Premium シート", capacity = 1, minHours = 6, graceMinutes = 15, tz = "Asia/Tokyo",
        enabled = true, holders = holders, waiting = waiting, nextEvictId = next, myReservationId = mine,
        createdAt = "2026-10-01T00:00:00Z", updatedAt = "2026-10-01T00:00:00Z",
    )

    @Test fun decodesTheServersPool() {
        val json = """
            {"id": "p1", "channel_id": "c1", "name": "シート", "capacity": 3, "min_hours": 6, "grace_minutes": 15, "tz": "Asia/Tokyo",
             "enabled": true, "operator_ids": ["u9"], "bot_user_id": "b1",
             "holders": [{"id": "r1", "user_id": "u1", "status": "holding", "requested_at": "2026-10-04T00:00:00Z",
                          "assigned_at": "2026-10-04T00:10:00Z", "guarantee_until": "2026-10-04T06:10:00Z", "returned_at": null,
                          "evict_at": null, "email": "a@example.jp", "position": null, "step": null, "pair_id": "r2", "ready": false}],
             "waiting": [{"id": "r2", "user_id": "u2", "status": "waiting", "requested_at": "2026-10-04T01:00:00Z", "assigned_at": null,
                          "guarantee_until": null, "returned_at": null, "evict_at": null, "email": null, "position": 1, "step": "swap",
                          "pair_id": "r1", "ready": false}],
             "next_evict_id": "r1", "my_reservation_id": "r2", "can_manage": false, "can_operate": true,
             "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z"}
        """.trimIndent()
        val pool = Codec.snake.decodeFromString(PoolOut.serializer(), json)
        assertEquals("a@example.jp", pool.holders.first().email)
        assertEquals("swap", pool.waiting.first().step)
        assertTrue(pool.canOperate)
        assertEquals("1/3 · 待ち 1", ReservationRules.summary(pool))
        assertEquals("待ち 1 番目", ReservationRules.myStatus(pool))
    }

    @Test fun wordsForMembersAndHolders() {
        val whenText: (String?) -> String = { if (it == "2026-10-04T06:00:00Z") "15:00" else "15:15" }
        val holder = row("h1", "alice", status = "holding", pair = "w1", guarantee = "2026-10-04T06:00:00Z")
        val waiter = row("w1", "bob", position = 1, step = "swap", pair = "h1")
        val p = pool(listOf(holder), listOf(waiter), mine = "h1", next = "h1")
        assertEquals("利用中 (保証 15:00 まで)", ReservationRules.myStatus(p, whenText))
        assertFalse(ReservationRules.urgent(p))
        val told = pool(listOf(holder.copy(evictAt = "2026-10-04T06:15:00Z")), listOf(waiter), mine = "h1")
        assertEquals("15:15 以降に外されます", ReservationRules.myStatus(told, whenText))
        assertTrue(ReservationRules.urgent(told))
        val name: (String) -> String = { if (it == "alice") "アリス" else "ボブ" }
        assertEquals("9:00 に予約 · アリス さんの後", ReservationRules.waiterLine(waiter, p, name) { "9:00" })
        assertEquals("次に外す", ReservationRules.holderBadge(holder, p, Instant.EPOCH)?.first)
        val ready = holder.copy(evictAt = "2026-10-04T06:15:00Z", ready = true)
        assertEquals("入れ替えできます" to true, ReservationRules.holderBadge(ready, p))
        assertEquals("返却済み · 外し待ち", ReservationRules.holderBadge(row("r", "x", status = "returning"), p)?.first)
        assertTrue(ReservationRules.early(holder, Instant.EPOCH))
        assertFalse(ReservationRules.early(holder, Instant.parse("2030-01-01T00:00:00Z")))
    }

    @Test fun storePutsAndDropsPools() {
        val store = Store()
        val first = pool(emptyList(), emptyList())
        store.setReservationPools("c1", listOf(first))
        store.putReservationPool(first.copy(holders = listOf(row("h", "u", status = "holding"))))
        assertEquals(1, store.poolsOf("c1").first().holders.size)
        store.dropReservationPool("c1", "p1")
        assertEquals(emptyList<PoolOut>(), store.poolsOf("c1"))
    }

    @Test fun poolsLoadWhenTheConversationOpensAndFollowReservationUpdated() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val channel = server.createChannel("claude", alice.id)
        server.join(channel.id, bob.id)
        server.pools[channel.id] = listOf(pool(emptyList(), emptyList()))
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); engine.idle()
        assertEquals(emptyList<PoolOut>(), store.poolsOf(channel.id)) // not part of bootstrap
        engine.openChannel(channel.id); engine.idle()
        assertEquals(0, store.poolsOf(channel.id).first().waiting.size)
        server.setPools(channel.id, listOf(pool(emptyList(), listOf(row("w1", alice.id, position = 1, step = "assign")))))
        engine.idle()
        assertEquals(listOf("w1"), store.poolsOf(channel.id).first().waiting.map { it.id })
        engine.stop(); scope.cancel()
    }
}
