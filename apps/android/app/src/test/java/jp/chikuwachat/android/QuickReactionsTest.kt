package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.ui.QuickReactions
import jp.chikuwachat.android.ui.REACTION_PALETTE
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.jsonObject
import java.io.File
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

    // --- the shared cases (apps/shared/quick-reactions.json, the file Desktop / Web and iOS test against too) ---

    @Serializable
    private data class RuleCase(val name: String, val chosen: List<String>? = null, val recent: List<String>, val count: Int, val expected: List<String>)

    @Serializable
    private data class Cases(val defaults: List<String>, val rule: List<RuleCase>)

    /** From the module (apps/android/app), ../../shared (as PresenceTest reads presence-rules.json). */
    private fun cases(): Cases {
        val file = File("../../shared/quick-reactions.json")
        check(file.isFile) { "apps/shared/quick-reactions.json not found from ${File("").absolutePath}" }
        return Codec.snake.decodeFromString(Cases.serializer(), file.readText())
    }

    @Test fun sharedRuleCases() {
        val v = cases()
        assertEquals(v.defaults, REACTION_PALETTE)
        assertTrue(v.rule.isNotEmpty())
        for (case in v.rule) assertEquals(case.name, case.expected, QuickReactions.row(case.chosen, case.recent, case.count))
    }

    @Test fun aChosenCustomEmojiShowsWhileTheWorkspaceHasIt() { // 2026-10-13
        val knows = QuickReactions.knownIn(setOf("hanpen"))
        assertEquals(listOf(":hanpen:", "👍"), QuickReactions.row(listOf(":hanpen:", "👍"), emptyList(), knows = knows))
        // Deleted since: skipped where shown, the others keep their order.
        assertEquals(listOf("👍", "🎉"), QuickReactions.row(listOf(":gone:", "👍", ":hanpen-old:", "🎉"), emptyList(), knows = knows))
        assertEquals(listOf("👍", "🎉"), QuickReactions.shown(listOf(":gone:", "👍", "🎉"), knows))
        // None left: as if nothing were chosen.
        assertEquals(listOf("🙏", "👍", "❤️"), QuickReactions.row(listOf(":gone:"), listOf("🙏"), 3, knows))
        // A plain emoji is always known; a custom one picked swaps like any other.
        assertTrue(knows("👍"))
        assertFalse(knows(":gone:"))
        assertEquals(listOf(":hanpen:", "❤️", "👍"), QuickReactions.replace(listOf("👍", "❤️", ":hanpen:"), 0, ":hanpen:"))
        assertEquals(listOf("👍", ":hanpen:"), QuickReactions.replace(listOf("👍"), 1, ":hanpen:"))
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
