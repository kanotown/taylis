package jp.chikuwachat.android

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.PoolOut
import jp.chikuwachat.android.api.ReservationOut
import jp.chikuwachat.android.api.ReservationTodo
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ActivityTarget
import jp.chikuwachat.android.ui.ActivityText
import jp.chikuwachat.android.ui.HomeTile
import jp.chikuwachat.android.ui.HomeTiles
import jp.chikuwachat.android.ui.ReservationRules
import jp.chikuwachat.android.api.ThreadSummary
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
import org.junit.Test

/** M112 (docs/RESERVATIONS.md §6): 「予約」 — decoding, the booking choices, a day's hours, the words, the tile, live reloads. */
class ReservationsTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")
    /** 2026-10-05 (月) 10:20 in Tokyo. */
    private val now = Instant.parse("2026-10-05T01:20:00Z")
    private fun at(hour: Int, day: Int = 5): String = LocalDate.of(2026, 10, day).atStartOfDay(tokyo).plusHours(hour.toLong()).toInstant().toString()

    private fun booking(id: String, user: String, from: Int, to: Int, status: String = "booked") =
        ReservationOut(id = id, userId = user, kind = "booking", status = status, requestedAt = "2026-10-04T00:00:00Z", startAt = at(from), endAt = at(to))

    @Test fun decodesTheServersPool() {
        val json = """
            {"id": "p1", "name": "シート", "capacity": 3, "min_hours": 6, "max_hours": 4, "grace_minutes": 15, "tz": "Asia/Tokyo",
             "enabled": true, "operator_ids": ["u9"], "log_channel_id": null, "visibility": "group", "visibility_channel_id": null,
             "visibility_group_id": "g1", "holders": [], "waiting": [],
             "bookings": [{"id": "b1", "user_id": "u2", "kind": "booking", "status": "booked", "requested_at": "2026-10-04T01:00:00Z",
                           "start_at": "2026-10-05T04:00:00Z", "end_at": "2026-10-05T06:00:00Z", "assigned_at": null, "guarantee_until": null,
                           "returned_at": null, "evict_at": null, "email": null, "position": null, "step": null, "pair_id": null,
                           "ready": false, "until": null, "can_extend": true}],
             "todos": [{"key": "booking:b1", "action": "assign", "reason": "free", "assign_id": "b1", "remove_id": null,
                        "due_at": "2026-10-05T04:00:00Z", "upcoming": true}],
             "next_evict_id": null, "my_reservation_id": null, "can_manage": false, "can_operate": true, "horizon_days": 14,
             "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z"}
        """.trimIndent()
        val pool = Codec.snake.decodeFromString(PoolOut.serializer(), json)
        assertEquals(4, pool.maxHours)
        assertEquals("group", pool.visibility)
        assertTrue(pool.bookings.first().canExtend)
        assertTrue(pool.todos.first().upcoming)
        assertEquals(0, ReservationRules.todoCount(listOf(pool))) // only due to-dos count
    }

    @Test fun startsDurationsAndHours() {
        val pool = PoolOut(id = "p1", name = "シート", capacity = 2, bookings = listOf(booking("b1", "a", 12, 15), booking("b2", "b", 13, 14)))
        val day = LocalDate.of(2026, 10, 5)
        val starts = ReservationRules.starts(pool, day, now, tokyo)
        assertEquals("10:00", ReservationRules.hm(starts.first().start, tokyo))
        assertTrue(starts.first { ReservationRules.hm(it.start, tokyo) == "13:00" }.full)
        assertEquals(listOf(1, 2, 3), ReservationRules.durations(pool, Instant.parse(at(10)), now, tokyo))
        val hours = ReservationRules.hours(pool, day, now, tokyo)
        assertEquals(24, hours.size)
        assertEquals(listOf("b1", "b2"), hours[13].rows.map { it.id })
        assertTrue(hours[15].rows.isEmpty())
        assertEquals(15, ReservationRules.days(now, 14, tokyo).size)
        assertEquals("10/7 (水)", ReservationRules.dayLabel(day.plusDays(2), now, tokyo))
        // a walk-in's guarantee holds its hours
        val walk = ReservationOut(id = "w", userId = "c", kind = "walkin", status = "holding", requestedAt = at(8), assignedAt = at(9), guaranteeUntil = at(11))
        val one = PoolOut(id = "p2", name = "x", capacity = 1, holders = listOf(walk))
        assertFalse(ReservationRules.fits(one, Instant.parse(at(10)), 1, now))
        assertTrue(ReservationRules.fits(one, Instant.parse(at(11)), 1, now))
    }

    @Test fun wordsTodosAndTheTile() {
        val waiting = ReservationOut(id = "q1", userId = "me", kind = "walkin", status = "waiting", requestedAt = at(9), email = "me@example.jp", position = 1, step = "assign", until = at(13))
        val holder = ReservationOut(id = "w1", userId = "bob", kind = "walkin", status = "holding", requestedAt = at(8), assignedAt = at(9), guaranteeUntil = at(12))
        val todos = listOf(
            ReservationTodo(key = "assign:q1", action = "assign", reason = "free", assignId = "q1", dueAt = at(10)),
            ReservationTodo(key = "booking:b1", action = "swap", reason = "guarantee_over", assignId = "b1", removeId = "w1", dueAt = at(12), upcoming = true),
        )
        val pool = PoolOut(id = "p1", name = "シート", capacity = 1, holders = listOf(holder), waiting = listOf(waiting), bookings = listOf(booking("b1", "alice", 12, 15)),
            todos = todos, myReservationId = "q1", canOperate = true)
        val name: (String) -> String = { mapOf("me" to "わたし", "bob" to "ボブ", "alice" to "アリス")[it] ?: "?" }
        assertEquals("q1", ReservationRules.mine(pool, "me").walkin?.id)
        assertEquals("空きあり (〜13:00 まで) · 担当者の割り当て待ち", ReservationRules.walkinText(waiting, pool, now, tokyo))
        assertEquals("わたし さん (me@example.jp) に割り当てる", ReservationRules.todoLine(todos[0], pool, name, now, tokyo))
        assertEquals("12:00 から: ボブ さん を外して アリス さん に割り当てる (保証時間が終了) · 予約 12:00〜15:00", ReservationRules.todoLine(todos[1], pool, name, now, tokyo))
        assertEquals(1, ReservationRules.todoCount(listOf(pool)))
        val tiles = HomeTiles.tiles(ThreadSummary(0, 0), 0, 0, 0, HomeTiles.ReservationTile(1, true))
        val tile = tiles.first { it.tile == HomeTile.RESERVATIONS }
        assertEquals(1, tile.count)
        assertTrue(tile.alert)
        assertEquals(tiles.indexOfFirst { it.tile == HomeTile.DEADLINES } + 1, tiles.indexOf(tile))
        assertNull(HomeTiles.tiles(ThreadSummary(0, 0), 0, 0, 0).firstOrNull { it.tile == HomeTile.RESERVATIONS })
        assertEquals("reservations", HomeTile.RESERVATIONS.navKey)
    }

    @Test fun activityItemOfKindReservation() {
        val json = """
            {"kind": "reservation", "at": "2026-10-05T01:00:00Z", "message": null, "canvas": null, "actor_ids": [], "emojis": [],
             "reservation": {"item_id": "n1", "pool_id": "p1", "pool_name": "シート", "reservation_id": "q1",
                             "text": "🙋 わたし さんに割り当ててください", "operator": true, "done": false, "done_at": null, "done_by": null}}
        """.trimIndent()
        val item = ActivityItem.decodeOrNull(Codec.snake, Codec.snake.parseToJsonElement(json))!!
        assertEquals("reservation:n1", item.key)
        assertEquals("シート · 担当者の作業", ActivityText.lead(item) { it })
        assertEquals("🙋 わたし さんに割り当ててください", ActivityText.excerpt(item, emptySet()) { "" })
        assertEquals(ActivityTarget.Reservations, ActivityText.target(item))
    }

    @Test fun storePutsAndDropsPools() {
        val store = Store()
        assertNull(store.reservationPools)
        val first = PoolOut(id = "p1", name = "シート", capacity = 1)
        store.setReservationPools(listOf(first))
        store.putReservationPool(first.copy(bookings = listOf(booking("b", "u", 12, 13))))
        assertEquals(1, store.reservationPools!!.first().bookings.size)
        store.dropReservationPool("p1")
        assertEquals(emptyList<PoolOut>(), store.reservationPools)
    }

    @Test fun poolsLoadAfterBootstrapAndFollowReservationUpdatedAndNotices() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        server.createChannel("general", alice.id)
        server.pools = listOf(PoolOut(id = "p1", name = "シート", capacity = 1))
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        val notices = mutableListOf<String>()
        engine.onReservationNotice = { notices += it.text }
        engine.start(); engine.idle()
        assertEquals(listOf("シート"), store.reservationPools?.map { it.name })
        val reads = server.poolReads
        server.publishPools(listOf(PoolOut(id = "p1", name = "Claude Premium シート", capacity = 1)))
        server.publishPools(listOf(PoolOut(id = "p1", name = "Claude Premium シート", capacity = 1)))
        engine.idle()
        delay(500)
        assertEquals(listOf("Claude Premium シート"), store.reservationPools?.map { it.name })
        assertEquals(reads + 1, server.poolReads)
        server.noticeReservation(bob.id, "🙋 割り当ててください")
        engine.idle()
        assertEquals(listOf("🙋 割り当ててください"), notices)
        engine.stop(); scope.cancel()
    }
}
