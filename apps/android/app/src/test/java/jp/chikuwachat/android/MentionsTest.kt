package jp.chikuwachat.android

import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.ui.Mentions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MentionsTest {
    private val alice = UserPublic("00000000-0000-7000-8000-000000000001", "alice", "Alice", "member", null, "", "")
    private val bob = UserPublic("00000000-0000-7000-8000-000000000002", "bob.k", "Bob K", "member", null, "", "")
    private val users = listOf(alice, bob)

    @Test fun encodesHandlesToTokens() {
        assertEquals("hi <@${bob.id}> and <!channel>, mail me@x.io @nobody", Mentions.encode("hi @bob.k and @channel, mail me@x.io @nobody", users))
        assertEquals("<@${alice.id}>", Mentions.encode("@Alice", users))
    }

    @Test fun decodesTokensToHandles() {
        val byId = users.associateBy { it.id }
        assertEquals("hi @bob.k <!unknown> @here", Mentions.decode("hi <@${bob.id}> <!unknown> <!here>", byId))
        assertEquals("<@00000000-0000-7000-8000-000000000009>", Mentions.decode("<@00000000-0000-7000-8000-000000000009>", byId))
    }

    @Test fun queryAndCompletion() {
        assertEquals("bo", Mentions.query("hello @bo"))
        assertEquals("", Mentions.query("@"))
        assertNull(Mentions.query("mail me@x"))
        assertNull(Mentions.query("done @bob "))
        assertEquals(listOf("bob.k"), Mentions.candidates("bo", users).map { it.username })
        assertEquals(listOf("alice", "bob.k", "channel", "here"), Mentions.candidates("", users).map { it.username })
        assertEquals("hello @bob.k ", Mentions.complete("hello @bo", "bob.k"))
    }
}
