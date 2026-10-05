package jp.chikuwachat.android.sync
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/*
 * M73 (CANVAS.md §18.2 / §18.5): 「編集中」 on a canvas — the volatile `canvas_presence` frames, a port of the desktop's
 * src/sync/canvasPresence.ts. Pure, so the JVM tests read them.
 *
 * Sending: `editing: true` while the editor has the focus and is used, again when the caret's heading changes (at most
 * every 2 s), else every 20 s; `editing: false` when it stops (blur, the editor closed, the app in the background) — only
 * after a true went out. Receiving: an editor shows until 45 s pass without a refresh (or a false arrives).
 */

const val CANVAS_PRESENCE_REFRESH_MS = 20_000L
const val CANVAS_PRESENCE_TTL_MS = 45_000L

/** A heading change waits this long after the last frame (the server relays the same canvas at most every 2 s too). */
const val CANVAS_PRESENCE_MIN_INTERVAL_MS = 2_000L

/** The longest `section` the server takes. */
const val CANVAS_PRESENCE_SECTION_MAX = 120

/** A frame this device sends. */
data class CanvasPresenceOut(val canvasId: String, val editing: Boolean, val section: String?)

/** What this device last said per canvas; decides which frames go out. */
class CanvasPresenceSender {
    private data class Sent(val section: String?, val at: Long)

    private val sent = LinkedHashMap<String, Sent>()

    /** The frame to send for this state now, or null (nothing new to say yet). */
    fun next(canvasId: String, editing: Boolean, section: String?, now: Long): CanvasPresenceOut? {
        val last = sent[canvasId]
        if (!editing) {
            if (last == null) return null
            sent.remove(canvasId)
            return CanvasPresenceOut(canvasId, false, null)
        }
        val shown = normalize(section)
        if (last != null) {
            val since = now - last.at
            if (last.section == shown && since < CANVAS_PRESENCE_REFRESH_MS) return null
            // Another heading: said soon, but not on every caret move (the editor asks again every 2 s while focused).
            if (last.section != shown && since < CANVAS_PRESENCE_MIN_INTERVAL_MS) return null
        }
        sent[canvasId] = Sent(shown, now)
        return CanvasPresenceOut(canvasId, true, shown)
    }

    /** The canvases a true went out for (the app goes to the background: each gets its false). */
    fun editing(): List<String> = sent.keys.toList()

    /** A new connection: the server knows nothing of before, so the next true goes out at once. */
    fun reset() = sent.clear()

    companion object {
        /** One line, trimmed, 120 characters at most; blank is none. */
        fun normalize(section: String?): String? =
            section?.trim()?.replace(Regex("\\s+"), " ")?.take(CANVAS_PRESENCE_SECTION_MAX)?.ifEmpty { null }
    }
}

data class CanvasEditor(val userId: String, val section: String?)

/** Who edits which canvas, as the frames said (kept by the Store; expired entries are skipped when read). */
class CanvasEditors {
    private class Entry(val section: String?, val until: Long)

    private val byCanvas = HashMap<String, LinkedHashMap<String, Entry>>()

    /** A frame from someone else: true (re)starts their entry for 45 s, false ends it. Returns whether to redraw. */
    fun note(canvasId: String, userId: String, editing: Boolean, section: String?, now: Long): Boolean {
        val users = byCanvas[canvasId] ?: LinkedHashMap()
        users.entries.removeAll { it.value.until <= now } // keep the map small
        val changed: Boolean
        if (editing) {
            val before = users[userId]
            changed = before == null || before.section != section
            users[userId] = Entry(section, now + CANVAS_PRESENCE_TTL_MS)
        } else {
            changed = users.remove(userId) != null
        }
        if (users.isEmpty()) byCanvas.remove(canvasId) else byCanvas[canvasId] = users
        return changed || editing
    }

    /** Those editing the canvas now, in the order they started. */
    fun of(canvasId: String, now: Long): List<CanvasEditor> =
        byCanvas[canvasId]?.filter { it.value.until > now }?.map { CanvasEditor(it.key, it.value.section) } ?: emptyList()

    /** The soonest moment an entry of this canvas expires (to redraw then), or null. */
    fun nextExpiry(canvasId: String, now: Long): Long? = byCanvas[canvasId]?.values?.map { it.until }?.filter { it > now }?.minOrNull()

    fun clear() = byCanvas.clear()

    companion object {
        /** 「〇〇 が編集中」, 「〇〇、△△ が編集中」, 「〇〇 ほか N 人が編集中」. */
        fun label(names: List<String>): String = when {
            names.isEmpty() -> ""
            names.size <= 2 -> names.joinToString(L10n.str(R.string.common_list_separator)) + L10n.str(R.string.canvas_presence_editing)
            else -> L10n.str(R.string.canvas_presence_and_others_editing, names[0], names.size - 1)
        }
    }
}
