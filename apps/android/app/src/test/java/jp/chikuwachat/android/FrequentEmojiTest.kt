package jp.chikuwachat.android

import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.ui.FrequentEmoji
import jp.chikuwachat.android.ui.QuickReactions
import jp.chikuwachat.android.ui.TextEmojiPill
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** 「よく使う」 (docs/EMOJI.md §9.4): the cases shared with the web and iOS (apps/shared/emoji-frequent.json). */
class FrequentEmojiTest {
    private class MemoryStore : KeyValueStore {
        val map = mutableMapOf<String, String>()
        override fun getString(key: String) = map[key]
        override fun putString(key: String, value: String?) {
            if (value == null) map.remove(key) else map[key] = value
        }
    }

    private val doc: JsonObject by lazy {
        val file = File("../../shared/emoji-frequent.json")
        check(file.isFile) { "apps/shared/emoji-frequent.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.arr(key: String) = getValue(key).jsonArray
    private fun JsonArray.strings() = map { it.jsonPrimitive.content }

    @Test fun constants() {
        assertEquals(doc.getValue("half_life_ms").jsonPrimitive.long, FrequentEmoji.HALF_LIFE_MS)
        assertEquals(doc.getValue("kept").jsonPrimitive.int, FrequentEmoji.KEPT)
        assertEquals(doc.getValue("rows").jsonPrimitive.int, FrequentEmoji.ROWS)
    }

    @Test fun rank() {
        for (c in doc.arr("rank").map { it.jsonObject }) {
            var entries = emptyList<FrequentEmoji.Entry>()
            for (use in c.arr("uses")) {
                val (glyph, at) = use.jsonArray
                entries = FrequentEmoji.record(entries, glyph.jsonPrimitive.content, at.jsonPrimitive.long)
            }
            assertEquals(c.str("name"), c.arr("ranked").strings(), FrequentEmoji.ranked(entries).map { it.glyph })
        }
    }

    @Test fun kept() {
        val k = doc.getValue("kept_case").jsonObject
        val start = k.getValue("start").jsonPrimitive.long
        val step = k.getValue("step").jsonPrimitive.long
        var entries = emptyList<FrequentEmoji.Entry>()
        repeat(k.getValue("uses_count").jsonPrimitive.int) { i -> entries = FrequentEmoji.record(entries, "e$i", start + i * step) }
        assertEquals(k.getValue("count").jsonPrimitive.int, entries.size)
        assertFalse(entries.any { it.glyph == k.str("forgotten") })
        assertEquals(k.str("first"), FrequentEmoji.ranked(entries).first().glyph)
    }

    @Test fun seed() {
        for (c in doc.arr("seed").map { it.jsonObject }) {
            val legacy = c.arr("legacy").map { it.jsonObject.str("glyph") to it.jsonObject["count"]?.jsonPrimitive?.intOrNull }
            val expected = c.arr("entries").map {
                val e = it.jsonObject
                FrequentEmoji.Entry(e.str("glyph"), e.getValue("score").jsonPrimitive.double, e.getValue("last").jsonPrimitive.long)
            }
            assertEquals(c.str("name"), expected, FrequentEmoji.seed(legacy, c.getValue("now").jsonPrimitive.long))
        }
    }

    @Test fun spanAndPillEstimate() {
        for (c in doc.arr("span").map { it.jsonObject }) {
            val n = { key: String -> c.getValue(key).jsonPrimitive.double }
            assertEquals(c.toString(), c.getValue("span").jsonPrimitive.int,
                FrequentEmoji.span(n("pill"), n("cell"), n("gap"), c.getValue("columns").jsonPrimitive.int))
        }
        for (c in doc.arr("pill_aspect").map { it.jsonObject }) {
            assertEquals(c.str("label"), c.getValue("aspect").jsonPrimitive.double, TextEmojiPill.aspect(c.str("label")).toDouble(), 1e-4)
        }
    }

    @Test fun fill() {
        for (c in doc.arr("fill").map { it.jsonObject }) {
            val items = c.arr("items").map { it.jsonObject.str("glyph") to (it.jsonObject["span"]?.jsonPrimitive?.intOrNull ?: 1) }
            val rows = FrequentEmoji.fill(items, c.getValue("columns").jsonPrimitive.int, c.getValue("rows").jsonPrimitive.int) { it.second }
            assertEquals(c.str("name"), c.arr("expected").map { it.jsonArray.strings() }, rows.map { row -> row.map { it.first } })
        }
    }

    @Test fun startsFromTheRecentListThenCountsEachUse() {
        val store = MemoryStore()
        store.putString("reactions.recent", "🎉\n👍")
        assertEquals(listOf("🎉", "👍"), FrequentEmoji.read(store))
        QuickReactions.remember(store, "👍")
        assertEquals(listOf("👍", "🎉"), FrequentEmoji.read(store))
        assertEquals(listOf("👍", "🎉"), QuickReactions.read(store))
        store.putString("emoji.frequent", "{broken")
        assertEquals(emptyList<String>(), FrequentEmoji.read(store))
    }
}
