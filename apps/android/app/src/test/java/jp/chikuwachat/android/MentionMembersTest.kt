package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.Mentions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** MOBILE_UI.md §23: a channel's members, read for the @ list, rank before the others; a failed read keeps the order. */
class MentionMembersTest {
    private fun store(type: String = "public"): Store {
        val store = Store()
        listOf("u1" to "alice", "u2" to "bob", "u3" to "carol").forEach { (id, name) -> store.upsertUser(UserPublic(id, name, name, "member", null, "", "")) }
        store.upsertChannel(
            ChannelOut(id = "c1", type = type, name = "general", archived = false, lastSeq = 0, createdAt = "", updatedAt = "", dmUserIds = if (type == "public") null else listOf("u1", "u3")),
            isMember = true,
        )
        return store
    }

    private fun names(store: Store) = Mentions.candidates("", store.users.values, context = Mentions.context(store, "c1", null)).map { it.username }

    @Test fun membersComeBeforeTheOthersOnceRead() = runBlocking {
        val store = store()
        assertEquals(listOf("alice", "bob", "carol", "channel", "here"), names(store))
        var reads = 0
        Mentions.readMembers(store, "c1", now = 0) { reads++; Result.success(listOf("u3")) }
        assertEquals(listOf("carol", "alice", "bob", "channel", "here"), names(store))
        assertEquals(listOf("u3"), Mentions.documentContext(store, "c1").members) // a channel canvas too
        // Held: not read again, until the members change or the read is old.
        Mentions.readMembers(store, "c1", now = 1000) { reads++; Result.success(emptyList()) }
        assertEquals(1, reads)
        store.membersChanged("c1")
        Mentions.readMembers(store, "c1", now = 2000) { reads++; Result.success(listOf("u2", "u3")) }
        assertEquals(2, reads)
        assertEquals(listOf("bob", "carol", "alice", "channel", "here"), names(store))
        Mentions.readMembers(store, "c1", now = 2000 + Mentions.MEMBERS_MAX_AGE_MS) { reads++; Result.success(listOf("u2")) }
        assertEquals(3, reads)
    }

    @Test fun aFailedReadKeepsTheOrder() = runBlocking {
        val store = store()
        var reads = 0
        Mentions.readMembers(store, "c1", now = 0) { reads++; Result.failure(RuntimeException("offline")) }
        assertNull(store.mentionMembers.ids("c1"))
        assertEquals(listOf("alice", "bob", "carol", "channel", "here"), names(store))
        Mentions.readMembers(store, "c1", now = Mentions.MEMBERS_RETRY_MS - 1) { reads++; Result.failure(RuntimeException("offline")) }
        assertEquals("not tried again at once", 1, reads)
        // Members held, then a failed read again: what was there stays.
        Mentions.readMembers(store, "c1", now = Mentions.MEMBERS_RETRY_MS) { Result.success(listOf("u3")) }
        store.membersChanged("c1")
        Mentions.readMembers(store, "c1", now = Mentions.MEMBERS_RETRY_MS + 1) { Result.failure(RuntimeException("offline")) }
        assertEquals(listOf("carol", "alice", "bob", "channel", "here"), names(store))
    }

    @Test fun aDmIsNotRead() = runBlocking {
        val store = store("dm")
        Mentions.readMembers(store, "c1") { error("read") }
        assertEquals(listOf("alice", "carol", "bob", "channel", "here"), names(store))
    }
}
