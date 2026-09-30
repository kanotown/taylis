package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.ui.QuickReactions
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    // --- M50: the row I choose (UserMe.quick_reactions) ---

    private fun me(extra: String) = Codec.snake.decodeFromString(UserMe.serializer(), """
        {"id":"u","username":"bob","display_name":"Bob","role":"member","created_at":"","updated_at":"","must_change_password":false$extra}
    """.trimIndent())

    @Test fun decodesAbsentNullAndAList() {
        val older = me("") // a server before M50: the setting is hidden
        assertNull(older.quickReactions)
        assertFalse(older.knowsQuickReactions)
        val unset = me(""","quick_reactions":null""")
        assertNull(unset.quickReactions)
        assertTrue(unset.knowsQuickReactions)
        val chosen = me(""","quick_reactions":["🙏","🍤","👍"]""")
        assertEquals(listOf("🙏", "🍤", "👍"), chosen.quickReactions)
        assertTrue(chosen.knowsQuickReactions)
    }

    @Test fun theStoredMeKeepsTheDifference() {
        // The Store keeps UserMe with Codec.plain across launches (Store.setMe); null must not come back as "unknown".
        for (me in listOf(me(""), me(""","quick_reactions":null"""), me(""","quick_reactions":["🙏"]"""))) {
            val back = Codec.plain.decodeFromString(UserMe.serializer(), Codec.plain.encodeToString(UserMe.serializer(), me))
            assertEquals(me, back)
            assertEquals(me.knowsQuickReactions, back.knowsQuickReactions)
            assertEquals(me.quickReactions, back.quickReactions)
        }
        // And an older UserMe stored before M50 (no key) reads as unknown.
        val old = Codec.plain.encodeToJsonElement(UserMe.serializer(), me("")).jsonObject - "quick_reactions"
        assertFalse(Codec.plain.decodeFromJsonElement(UserMe.serializer(), kotlinx.serialization.json.JsonObject(old)).knowsQuickReactions)
    }

    @Test fun aChosenRowIsExactlyThatElseRecentFirstThenTheDefaults() {
        val recent = listOf("🙏", ":party:", "👍")
        assertEquals(listOf("🍤", "👍", "🎉"), QuickReactions.row(listOf("🍤", "👍", "🎉"), recent)) // not padded, in order
        assertEquals(listOf("🙏", "👍", "❤️", "😂", "🎉", "👀"), QuickReactions.row(null, recent))
        assertEquals(listOf("🙏", "👍", "❤️", "😂", "🎉", "👀"), QuickReactions.row(emptyList(), recent))
        assertEquals(listOf("1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"), QuickReactions.row(listOf("1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"), recent))
    }

    @Test fun aSlotIsReplacedOrSwappedNeverDuplicated() {
        val row = listOf("👍", "❤️", "😂", "🎉", "👀", "✅")
        assertEquals(listOf("🍤", "❤️", "😂", "🎉", "👀", "✅"), QuickReactions.replace(row, 0, "🍤"))
        assertEquals(listOf("✅", "❤️", "😂", "🎉", "👀", "👍"), QuickReactions.replace(row, 0, "✅")) // already there: swap
        assertEquals(row, QuickReactions.replace(row, 2, "😂"))
        assertEquals(listOf("👍", "🙏"), QuickReactions.replace(listOf("👍"), 4, "🙏")) // an empty slot adds at the end
        assertEquals(listOf("👍"), QuickReactions.replace(listOf("👍"), 3, "👍"))
    }
}
