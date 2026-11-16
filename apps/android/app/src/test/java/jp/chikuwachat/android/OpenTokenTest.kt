package jp.chikuwachat.android

import jp.chikuwachat.android.platform.OpenToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 2026-11-16 (a hostile-server review): the exported MainActivity acts on a notification's or widget's extras only when
 * the intent carries this install's token (a web page's `intent:` link or another app cannot know it).
 */
class OpenTokenTest {
    @Test fun aTokenIsMadeOnceAndKept() {
        val store = MemoryStore()
        val token = OpenToken(store)
        val value = token.value()
        assertTrue(value, Regex("^[A-Za-z0-9_-]{43}$").matches(value)) // 32 random bytes
        assertEquals(value, token.value())
        assertEquals(value, OpenToken(store).value()) // the next start reads the same one
        assertEquals(value, store.getString(OpenToken.KEY))
        assertNotEquals(value, OpenToken(MemoryStore()).value()) // another install
    }

    @Test fun onlyThisInstallsTokenMatches() {
        val store = MemoryStore()
        val token = OpenToken(store)
        assertTrue(token.matches(token.value()))
        assertFalse(token.matches(null)) // a web page's intent: link, another app, an intent from before the token
        assertFalse(token.matches(""))
        assertFalse(token.matches(token.value().dropLast(1)))
        assertFalse(token.matches(OpenToken(MemoryStore()).value()))
    }

    @Test fun aDamagedTokenIsReplaced() {
        val store = MemoryStore(mapOf(OpenToken.KEY to "short"))
        val value = OpenToken(store).value()
        assertNotEquals("short", value)
        assertFalse(OpenToken(store).matches("short"))
    }
}
