package jp.chikuwachat.android.ui

import jp.chikuwachat.android.platform.KeyValueStore
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlin.math.ceil
import kotlin.math.ln
import kotlin.math.pow

/**
 * The emoji picker's 「よく使う」 (docs/EMOJI.md §9.4): the emoji I use on this device, ranked by frecency (each use
 * counts 1 and halves every two weeks), in the prefs as JSON. The rule and its cases are shared with the web and iOS:
 * apps/shared/emoji-frequent.json (FrequentEmojiTest runs them). A use is what [QuickReactions.remember] is told: a
 * reaction I add (any way), an emoji put in the composer from the picker or the `:` completion. The quick reactions keep
 * their own recent list ([QuickReactions.read]).
 */
object FrequentEmoji {
    @Serializable
    data class Entry(val glyph: String, val score: Double, val last: Long)

    const val HALF_LIFE_MS = 14L * 24 * 3600 * 1000
    /** Entries remembered; a new one past this replaces the lowest ranked. */
    const val KEPT = 64
    /** Rows 「よく使う」 fills. */
    const val ROWS = 2
    private const val SEED_STEP_MS = 1000L
    private const val KEY = "emoji.frequent"

    private fun rankKey(e: Entry): Double = ln(e.score) / ln(2.0) + e.last.toDouble() / HALF_LIFE_MS

    /** Highest first: the order of the scores decayed to any one moment; then the latest; then the glyph (UTF-16). */
    fun ranked(entries: List<Entry>): List<Entry> =
        entries.sortedWith(compareByDescending<Entry> { rankKey(it) }.thenByDescending { it.last }.thenBy { it.glyph })

    /** One use of [glyph] at [now]. */
    fun record(entries: List<Entry>, glyph: String, now: Long): List<Entry> {
        if (glyph.isEmpty()) return entries
        val at = entries.indexOfFirst { it.glyph == glyph }
        if (at >= 0) {
            val e = entries[at]
            val decayed = e.score * 2.0.pow(-(maxOf(0L, now - e.last)).toDouble() / HALF_LIFE_MS)
            return entries.toMutableList().also { it[at] = Entry(glyph, decayed + 1, maxOf(e.last, now)) }
        }
        val kept = if (entries.size >= KEPT) ranked(entries).take(KEPT - 1) else entries
        return kept + Entry(glyph, 1.0, now)
    }

    /** Without a stored list: what was kept before (newest first, a count where known), each once, a second apart. */
    fun seed(legacy: List<Pair<String, Int?>>, now: Long): List<Entry> {
        val out = mutableListOf<Entry>()
        val seen = mutableSetOf<String>()
        for ((glyph, count) in legacy) {
            if (glyph.isEmpty() || !seen.add(glyph)) continue
            out += Entry(glyph, maxOf(1, count ?: 1).toDouble(), now - out.size * SEED_STEP_MS)
        }
        return ranked(out).take(KEPT)
    }

    /** Cells a pill [pill] wide takes in columns [cell] wide and [gap] apart (n cells span n·cell + (n−1)·gap). */
    fun span(pill: Double, cell: Double, gap: Double, columns: Int): Int =
        ceil((pill + gap) / (cell + gap) - 1e-9).toInt().coerceIn(1, columns)

    /**
     * 「よく使う」's rows: in rank order each item goes in the first row with its [span] of cells free, and is left out
     * when no row has room, until every row is full — whole rows when there are enough, whatever the pills' widths.
     */
    fun <T> fill(items: List<T>, columns: Int, rows: Int = ROWS, span: (T) -> Int = { 1 }): List<List<T>> {
        val free = IntArray(rows) { columns }
        val out = List(rows) { mutableListOf<T>() }
        for (item in items) {
            if (free.all { it == 0 }) break
            val s = span(item).coerceIn(1, columns)
            val row = free.indexOfFirst { it >= s }
            if (row < 0) continue
            out[row] += item
            free[row] -= s
        }
        return out.filter { it.isNotEmpty() }
    }

    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(Entry.serializer())

    /** The stored entries; never stored yet (or unreadable), started from the quick reactions' recent list. */
    fun entries(store: KeyValueStore, now: Long = System.currentTimeMillis()): List<Entry> {
        val raw = store.getString(KEY)
        val parsed = raw?.let { runCatching { json.decodeFromString(serializer, it) }.getOrNull() }
        return parsed?.filter { it.glyph.isNotEmpty() && it.score > 0 }?.take(KEPT)
            ?: if (raw == null) seed(QuickReactions.read(store).map { it to null }, now) else emptyList()
    }

    /** This device's 「よく使う」, best first. */
    fun read(store: KeyValueStore): List<String> = ranked(entries(store)).map { it.glyph }

    /** Counts one use (from [QuickReactions.remember]). */
    fun note(store: KeyValueStore, glyph: String, now: Long = System.currentTimeMillis()) {
        store.putString(KEY, json.encodeToString(serializer, record(entries(store, now), glyph, now)))
    }
}
