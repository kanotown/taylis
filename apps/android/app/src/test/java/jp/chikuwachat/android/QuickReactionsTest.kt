package jp.chikuwachat.android

import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.ui.QuickReactions
import org.junit.Assert.assertEquals
import org.junit.Test

/** The sheet's quick reactions put the ones I used last first (tester request; the web's quickReactions rule). */
class QuickReactionsTest {
    private class MemoryStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun getString(key: String): String? = values[key]
        override fun putString(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }

    @Test fun recentFirstThenTheDefaultsWithoutCustomEmoji() {
        assertEquals(listOf("👍", "❤️", "😂", "🎉", "👀", "✅"), QuickReactions.pick(emptyList()))
        val store = MemoryStore()
        QuickReactions.remember(store, "👍")
        QuickReactions.remember(store, ":party:")
        QuickReactions.remember(store, "🙏")
        assertEquals(listOf("🙏", ":party:", "👍"), QuickReactions.read(store))
        assertEquals(listOf("🙏", "👍", "❤️", "😂", "🎉", "👀"), QuickReactions.pick(QuickReactions.read(store)))
        QuickReactions.remember(store, "👍") // used again: first
        assertEquals(listOf("👍", "🙏", "❤️"), QuickReactions.pick(QuickReactions.read(store), 3))
    }
}
