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
 *
 * CANVAS.md §25: the frame also carries where the caret is (`caret`, in the stored body's terms); one that only moved goes
 * out at most every 300 ms (the editor's [CanvasCaretThrottle] sends the last position when the time is up).
 */

const val CANVAS_PRESENCE_REFRESH_MS = 20_000L
const val CANVAS_PRESENCE_TTL_MS = 45_000L

/** A heading change waits this long after the last frame (the server relays the same canvas at most every 2 s too). */
const val CANVAS_PRESENCE_MIN_INTERVAL_MS = 2_000L

/** The longest `section` the server takes. */
const val CANVAS_PRESENCE_SECTION_MAX = 120

/** CANVAS.md §25: a caret that moved goes out at most this often (the editor sends the last one when the time is up). */
const val CANVAS_CARET_INTERVAL_MS = 300L

/** Below this the sender holds a moved caret back whoever asks (timers fire a little early or late). */
private const val CARET_MIN_GAP_MS = 250L

/**
 * CANVAS.md §25: a caret in the stored body (mentions as `<@uuid>`, task markers included): the 0-based line and the
 * column in UTF-16 units.
 */
data class CanvasCaret(val line: Int, val column: Int)

/** A frame this device sends. */
data class CanvasPresenceOut(val canvasId: String, val editing: Boolean, val section: String?, val caret: CanvasCaret? = null)

/** What this device last said per canvas; decides which frames go out. */
class CanvasPresenceSender {
    private data class Sent(val section: String?, val caret: CanvasCaret?, val at: Long)

    private val sent = LinkedHashMap<String, Sent>()

    /**
     * The frame to send for this state now, or null (nothing new to say yet). A caret that only moved goes out once
     * 250 ms passed since the last frame (the editor asks every 300 ms at most, with the caret as it is by then).
     */
    fun next(canvasId: String, editing: Boolean, section: String?, now: Long, caret: CanvasCaret? = null): CanvasPresenceOut? {
        val last = sent[canvasId]
        if (!editing) {
            if (last == null) return null
            sent.remove(canvasId)
            return CanvasPresenceOut(canvasId, false, null)
        }
        val shown = normalize(section)
        if (last != null) {
            val since = now - last.at
            if (last.section == shown) {
                if (last.caret == caret) {
                    if (since < CANVAS_PRESENCE_REFRESH_MS) return null
                } else if (since < CARET_MIN_GAP_MS) return null
            }
            // Another heading: said soon, but not on every caret move (the editor asks again every 2 s while focused).
            if (last.section != shown && since < CANVAS_PRESENCE_MIN_INTERVAL_MS) return null
        }
        sent[canvasId] = Sent(shown, caret, now)
        return CanvasPresenceOut(canvasId, true, shown, caret)
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

/**
 * CANVAS.md §25: the editor's side of the caret frames — a moved caret goes out at most every 300 ms, and the last
 * position always does (trailing edge). Pure: the editor schedules the send [moved] asks for, and calls [sent] then.
 */
class CanvasCaretThrottle(private val intervalMs: Long = CANVAS_CARET_INTERVAL_MS) {
    private var lastSent: Long? = null
    private var scheduled = false

    /** The caret moved at `now`: how long to wait before sending it (0: now), or null when a send is already on its way. */
    fun moved(now: Long): Long? {
        if (scheduled) return null
        scheduled = true
        val last = lastSent ?: return 0
        return maxOf(0L, last + intervalMs - now)
    }

    /** The scheduled send went out at `now` (with the caret as it was then). */
    fun sent(now: Long) {
        scheduled = false
        lastSent = now
    }

    /** The editor stopped (blur, closed): nothing is on its way. */
    fun reset() {
        scheduled = false
    }
}

data class CanvasEditor(val userId: String, val section: String?, val caret: CanvasCaret? = null)

/** Who edits which canvas, as the frames said (kept by the Store; expired entries are skipped when read). */
class CanvasEditors {
    private class Entry(val section: String?, val caret: CanvasCaret?, val until: Long)

    private val byCanvas = HashMap<String, LinkedHashMap<String, Entry>>()

    /** A frame from someone else: true (re)starts their entry for 45 s, false ends it. Returns whether to redraw. */
    fun note(canvasId: String, userId: String, editing: Boolean, section: String?, now: Long, caret: CanvasCaret? = null): Boolean {
        val users = byCanvas[canvasId] ?: LinkedHashMap()
        users.entries.removeAll { it.value.until <= now } // keep the map small
        val changed: Boolean
        if (editing) {
            val before = users[userId]
            changed = before == null || before.section != section || before.caret != caret
            users[userId] = Entry(section, caret, now + CANVAS_PRESENCE_TTL_MS)
        } else {
            changed = users.remove(userId) != null
        }
        if (users.isEmpty()) byCanvas.remove(canvasId) else byCanvas[canvasId] = users
        return changed || editing
    }

    /** Those editing the canvas now, in the order they started. */
    fun of(canvasId: String, now: Long): List<CanvasEditor> =
        byCanvas[canvasId]?.filter { it.value.until > now }?.map { CanvasEditor(it.key, it.value.section, it.value.caret) } ?: emptyList()

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

/**
 * CANVAS.md §25: carets between the stored body (what travels) and the text an editor shows (mentions as `@name`, task
 * markers as stand-ins, perhaps only a section's lines from `firstLine` on). The desktop's ui/remoteCarets.tsx
 * storedCaret / shownOffset. Approximate on purpose: the other person's unsaved typing is not here yet.
 */
object CanvasCarets {
    /** Readable on the light and the dark canvas (the desktop's palette); a person keeps theirs (by their id). */
    val COLORS = longArrayOf(0xFFE5484D, 0xFF0090FF, 0xFF30A46C, 0xFFF76B15, 0xFF8E4EC6, 0xFFD6409F, 0xFF12A594, 0xFFAD7F58)

    /** The colour (ARGB) of this person's caret: the desktop's hash, so a person has the same colour everywhere. */
    fun color(userId: String): Long {
        var hash = 0L
        for (ch in userId) hash = (hash * 31 + ch.code) and 0xFFFFFFFFL
        return COLORS[(hash % COLORS.size).toInt()]
    }

    /**
     * My caret (an offset into the text as shown) in the stored body's terms. `firstLine`: the stored line the shown text
     * starts on (a section); `encodeLine` writes the start of a shown line as stored.
     */
    fun storedCaret(shown: String, offset: Int, firstLine: Int, encodeLine: (String) -> String): CanvasCaret {
        val at = offset.coerceIn(0, shown.length)
        val lineStart = shown.lastIndexOf('\n', at - 1) + 1
        val line = shown.substring(0, lineStart).count { it == '\n' }
        return CanvasCaret(firstLine + line, encodeLine(shown.substring(lineStart, at)).length)
    }

    /**
     * Someone's caret (stored terms) as an offset into the text as shown here (its lines from the stored body's line
     * `firstLine`); null when their line is not shown here. `decodeLine` turns the start of a stored line into what it
     * looks like here; the column is clamped to the line.
     */
    fun shownOffset(stored: String, shown: String, firstLine: Int, caret: CanvasCaret, decodeLine: (String) -> String): Int? {
        val storedLines = stored.split("\n")
        val shownLines = shown.split("\n")
        val line = caret.line - firstLine
        if (caret.line < 0 || caret.line >= storedLines.size || line < 0 || line >= shownLines.size) return null
        val storedLine = storedLines[caret.line]
        val prefix = storedLine.substring(0, caret.column.coerceIn(0, storedLine.length))
        val column = minOf(decodeLine(prefix).length, shownLines[line].length)
        var offset = 0
        for (k in 0 until line) offset += shownLines[k].length + 1
        return offset + column
    }
}
