package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.PeopleText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M27 polls: counts and my votes (DATA_MODEL.md 「投票」) and the poll.mine merge rule (SYNC_PROTOCOL.md §8). */
class PollTest {
    private fun message(updatedSeq: Int, poll: PollOut) = MessageOut(
        id = "m1", channelId = "c1", senderId = "u1", seq = 3, updatedSeq = updatedSeq, body = "📊 ${poll.question}",
        createdAt = "2026-09-29T04:00:00Z", deleted = false, poll = poll,
    )

    private val anonymous = PollOut("どこにする?", listOf("焼き鳥", "中華"), anonymous = true, votes = listOf(emptyList(), emptyList()))

    @Test fun anAnonymousPollCountsFromCountsAndKnowsMyVotesOnlyFromMine() {
        val poll = anonymous.copy(counts = listOf(2, 1), mine = listOf(1))
        assertEquals(listOf(2, 1), poll.options.indices.map { poll.count(it) })
        assertEquals(3, poll.total)
        assertEquals(emptyList<String>(), poll.voters(0))
        assertEquals(setOf(1), poll.mineFor("me"))
        assertEquals(emptySet<Int>(), poll.copy(mine = null).mineFor("me")) // not known yet (an event only)
        // Voter ids an anonymous poll should never carry are not shown either.
        assertEquals(emptyList<String>(), poll.copy(votes = listOf(listOf("x"), emptyList())).voters(0))
    }

    @Test fun aPollFromAServerBeforeM27DecodesAndDerivesCountsAndMineFromVotes() {
        val wire = """{"question": "Q", "options": ["A", "B"], "multiple": true, "closed_at": null, "votes": [["u1", "u2"], ["u2"]]}"""
        val poll = Codec.snake.decodeFromString(PollOut.serializer(), wire)
        assertFalse(poll.anonymous)
        assertNull(poll.mine)
        assertEquals(listOf(2, 1), poll.options.indices.map { poll.count(it) })
        assertEquals(3, poll.total)
        assertEquals(setOf(0, 1), poll.mineFor("u2"))
        assertEquals(listOf("u1", "u2"), poll.voters(0))
    }

    @Test fun aNamedPollReadsItsVotesEvenWhereAKeptMineSaysOtherwise() {
        // My other device took the vote back: the event's votes no longer list me, the mine kept from before still does.
        val poll = PollOut("Q", listOf("A", "B"), votes = listOf(listOf("u1"), emptyList()), counts = listOf(1, 0), mine = listOf(1))
        assertEquals(emptySet<Int>(), poll.mineFor("me"))
        assertEquals(setOf(0), poll.mineFor("u1"))
    }

    @Test fun anEventWithoutMineKeepsMyVotesAndTheLaterResponseStillBringsThem() {
        val persistence = MemoryPersistence()
        val store = Store(persistence)
        // My vote's event lands first (no mine), then its response with the same updated_seq.
        store.upsertMessage(message(4, anonymous.copy(counts = listOf(1, 0))))
        assertNull(store.message("c1", "m1")?.poll?.mine)
        assertTrue(store.upsertMessage(message(4, anonymous.copy(counts = listOf(1, 0), mine = listOf(0)))))
        assertEquals(listOf(0), store.message("c1", "m1")?.poll?.mine)
        assertEquals(listOf(0), persistence.messages["m1"]?.poll?.mine)
        // Someone else votes: a newer event without mine keeps mine and takes the new counts.
        store.upsertMessage(message(5, anonymous.copy(counts = listOf(1, 1))))
        val kept = store.message("c1", "m1")?.poll
        assertEquals(listOf(0), kept?.mine)
        assertEquals(listOf(1, 1), kept?.counts)
        // The same response again changes nothing.
        assertFalse(store.upsertMessage(message(5, anonymous.copy(counts = listOf(1, 1), mine = listOf(0)))))
    }

    @Test fun aResponseBeforeItsEventKeepsMyVotesAndATakenBackVoteClearsThem() {
        val store = Store()
        store.upsertMessage(message(4, anonymous.copy(counts = listOf(1, 0), mine = listOf(0))))
        // The event of the same change arrives after the response: a duplicate, mine stays.
        assertFalse(store.upsertMessage(message(4, anonymous.copy(counts = listOf(1, 0)))))
        assertEquals(listOf(0), store.message("c1", "m1")?.poll?.mine)
        // Taking the vote back answers with an empty mine: that is known, not missing.
        store.upsertMessage(message(6, anonymous.copy(counts = listOf(0, 0), mine = emptyList())))
        assertEquals(emptyList<Int>(), store.message("c1", "m1")?.poll?.mine)
        store.upsertMessage(message(7, anonymous.copy(counts = listOf(0, 1))))
        assertEquals(emptySet<Int>(), store.message("c1", "m1")?.poll?.mineFor("me"))
    }

    @Test fun myVoteResponseOvertakenBySomeoneElsesEventStillSetsMine() {
        val persistence = MemoryPersistence()
        val store = Store(persistence)
        store.upsertMessage(message(4, anonymous.copy(counts = listOf(0, 0))))
        // Someone else's vote (updated_seq 6) lands before the response to mine (5).
        store.upsertMessage(message(6, anonymous.copy(counts = listOf(1, 1))))
        store.applyMyPollResponse(message(5, anonymous.copy(counts = listOf(0, 1), mine = listOf(1))))
        val stored = store.message("c1", "m1")!!
        assertEquals(6, stored.updatedSeq)
        assertEquals(listOf(1), stored.poll?.mine)
        assertEquals(listOf(1, 1), stored.poll?.counts) // the newer row's counts
        assertEquals(listOf(1), persistence.messages["m1"]?.poll?.mine)
        // Taking it back the same way: an empty mine is set too.
        store.upsertMessage(message(8, anonymous.copy(counts = listOf(1, 0))))
        store.applyMyPollResponse(message(7, anonymous.copy(counts = listOf(1, 0), mine = emptyList())))
        assertEquals(emptyList<Int>(), store.message("c1", "m1")?.poll?.mine)
    }

    @Test fun aMessageWithoutAPollIsUntouchedByTheRule() {
        val store = Store()
        val plain = MessageState.from(message(4, anonymous)).copy(poll = null)
        store.upsertMessage(plain)
        assertFalse(store.upsertMessage(plain.copy(body = "same seq")))
        assertEquals(plain.body, store.message("c1", "m1")?.body)
    }

    /** Through the engine with the fake server, which (like the real one) sends mine only in responses. */
    @Test fun myVotesInAnAnonymousPollSurviveOthersVotingInBothOrders() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(sleep = {}, random = { 0.5 }))
        engine.isActive = { false }
        suspend fun settle() = repeat(10) { engine.idle(); yield() }
        engine.start(); engine.openChannel(channel.id); settle()
        val poll = server.postPoll(channel.id, alice.id, "どこにする?", listOf("焼き鳥", "中華"), anonymous = true)
        settle()
        assertEquals(listOf(emptyList<String>(), emptyList()), store.message(channel.id, poll.id)?.poll?.votes)

        // Event first, then the response (AppController.vote applies it with applyMyPollResponse).
        val first = server.vote(channel.id, bob.id, poll.id, 0, true)
        settle()
        assertNull(store.message(channel.id, poll.id)?.poll?.mine) // the event names nobody's votes
        store.applyMyPollResponse(first)
        assertEquals(setOf(0), store.message(channel.id, poll.id)?.poll?.mineFor(bob.id))

        // Response first, then its event.
        server.holdEvents = true
        val second = server.vote(channel.id, bob.id, poll.id, 1, true) // single answer: the vote moves
        store.applyMyPollResponse(second)
        server.holdEvents = false
        server.release(); settle()
        assertEquals(setOf(1), store.message(channel.id, poll.id)?.poll?.mineFor(bob.id))

        // Someone else's vote: new counts, my vote kept, still no names.
        server.vote(channel.id, alice.id, poll.id, 1, true); settle()
        val shown = store.message(channel.id, poll.id)?.poll!!
        assertEquals(listOf(0, 2), shown.options.indices.map { shown.count(it) })
        assertEquals(setOf(1), shown.mineFor(bob.id))
        assertEquals(emptyList<String>(), shown.voters(1))

        // My vote taken back, but someone else's vote event lands before the response (a newer row without mine).
        server.holdEvents = true
        val third = server.vote(channel.id, bob.id, poll.id, 1, false)
        server.vote(channel.id, alice.id, poll.id, 0, true)
        server.holdEvents = false
        server.release(); settle()
        assertEquals(setOf(1), store.message(channel.id, poll.id)?.poll?.mineFor(bob.id)) // stale until the response
        store.applyMyPollResponse(third)
        val last = store.message(channel.id, poll.id)!!
        assertEquals(emptySet<Int>(), last.poll?.mineFor(bob.id))
        assertEquals(third.updatedSeq + 1, last.updatedSeq)
        assertEquals(listOf(1, 0), last.poll!!.options.indices.map { last.poll!!.count(it) })
        engine.stop(); scope.cancel()
    }

    @Test fun peopleAreShortenedAfterThreeNames() {
        assertEquals("", PeopleText.compact(emptyList()))
        assertEquals("山田、佐藤", PeopleText.compact(listOf("山田", "佐藤")))
        assertEquals("山田、佐藤、鈴木", PeopleText.compact(listOf("山田", "佐藤", "鈴木")))
        assertEquals("山田、佐藤、鈴木 ほか 2 人", PeopleText.compact(listOf("山田", "佐藤", "鈴木", "田中", "高橋")))
        assertEquals("山田、佐藤 が確認", PeopleText.acknowledged(listOf("山田", "佐藤")))
        assertEquals("山田、佐藤、鈴木 ほか 1 人が確認", PeopleText.acknowledged(listOf("山田", "佐藤", "鈴木", "田中")))
    }
}
