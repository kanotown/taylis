package jp.chikuwachat.android.ui

/**
 * M83 (CANVAS.md §22, §22.9): the hidden marker ` <!--task:<id>-->` the server puts at the end of a checklist item that a
 * task was made from (server/app/modules/canvases/markers.py); a port of the desktop's ui/canvasMarkers.ts. With it the
 * box and the task's completion follow each other. The app never shows it — not in the view, the history, the conflict
 * panel, a copy or the editor — and keeps it through edits. apps/shared/canvas_task_markers.json holds the cases the
 * three clients share (CanvasTaskMarkersTest).
 *
 * The editor shows each marker as one invisible character: a Unicode tag character (U+E0020 + n, default-ignorable,
 * drawn as nothing), n being the marker's place in a table the editor keeps. The character moves with its line through
 * typing and merges coming in; on the way back each one becomes its marker again at the end of its line. A table holds
 * 95 markers; more stay as text (still kept, just visible). Positions are UTF-16 (a stand-in is a surrogate pair), as
 * Compose's TextRange counts them. No regex touches the stand-ins (Android's ICU regex differs from the JVM's on
 * supplementary characters); the marker's pattern is plain ASCII.
 */
object CanvasMarkers {
    /** One marker, with the space before it (taken out with it). The id is lower-case, as the server writes it. */
    val TASK_MARKER = Regex(""" ?<!--task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-->""")

    private const val FIRST = 0xE0020
    private const val SLOTS = 95 // U+E0020 … U+E007E

    /** A stand-in's length in UTF-16 units (a surrogate pair). */
    const val STAND_IN_LENGTH = 2

    /** The text as a reader sees it: without markers. */
    fun strip(text: String): String = if (text.contains("<!--task:")) TASK_MARKER.replace(text, "") else text

    /** The ids of the tasks the text's markers name, in order. */
    fun ids(text: String): List<String> = TASK_MARKER.findAll(text).map { it.groupValues[1] }.toList()

    private fun isStandIn(codePoint: Int) = codePoint >= FIRST && codePoint < FIRST + SLOTS

    /** Whether the editor text has one of the stand-ins at `index` (UTF-16). */
    fun standInAt(text: String, index: Int): Boolean {
        if (index < 0 || index + STAND_IN_LENGTH > text.length) return false
        return Character.isHighSurrogate(text[index]) && isStandIn(text.codePointAt(index))
    }

    /** Whether the text holds any stand-in. */
    fun hasStandIns(text: String): Boolean {
        var i = 0
        while (i < text.length) {
            if (standInAt(text, i)) return true
            i++
        }
        return false
    }

    /** The editor's text without the stand-ins (what a copy puts on the clipboard). */
    fun stripStandIns(shown: String): String {
        if (!hasStandIns(shown)) return shown
        val out = StringBuilder(shown.length)
        var i = 0
        while (i < shown.length) {
            if (standInAt(shown, i)) { i += STAND_IN_LENGTH; continue }
            out.append(shown[i])
            i++
        }
        return out.toString()
    }

    /** The editor's table: which task each stand-in is. One per editor; the same id always gets the same character. */
    class Table {
        private val ids = ArrayList<String>()

        /** The stored text as the editor shows it: each marker (and the space before it) as its stand-in. */
        fun hide(wire: String): String {
            if (!wire.contains("<!--task:")) return wire
            return TASK_MARKER.replace(wire) { match ->
                val id = match.groupValues[1]
                var slot = ids.indexOf(id)
                if (slot == -1) {
                    if (ids.size >= SLOTS) return@replace match.value // past the table: left as text
                    ids.add(id)
                    slot = ids.size - 1
                }
                String(Character.toChars(FIRST + slot))
            }
        }

        /** The editor's text as stored: on each line the stand-ins go, and their markers follow at its end. */
        fun show(shown: String): String {
            if (!hasStandIns(shown)) return shown
            return shown.split("\n").joinToString("\n") { line ->
                val found = ArrayList<String>()
                val bare = StringBuilder(line.length)
                var i = 0
                while (i < line.length) {
                    if (standInAt(line, i)) {
                        val id = ids.getOrNull(line.codePointAt(i) - FIRST)
                        if (id != null && id !in found) found.add(id)
                        i += STAND_IN_LENGTH
                        continue
                    }
                    bare.append(line[i])
                    i++
                }
                if (found.isEmpty()) bare.toString() else bare.toString() + " " + found.joinToString(" ") { "<!--task:$it-->" }
            }
        }
    }

    /** A text and its caret (UTF-16), the result of a deletion. */
    data class Caret(val text: String, val caret: Int)

    /**
     * Backspace (`backward`) or Delete next to a stand-in, with nothing selected: the visible character beside the caret
     * goes and the stand-ins stay. The caret ends after any stand-ins that follow it. Null when no stand-in is involved
     * (the platform's own deletion is right). The desktop's deleteBesideStandIns, case for case (the `delete` fixture).
     */
    fun deleteBeside(text: String, caret: Int, backward: Boolean): Caret? {
        if (backward) {
            var end = caret
            while (end >= STAND_IN_LENGTH && standInAt(text, end - STAND_IN_LENGTH)) end -= STAND_IN_LENGTH
            if (end == caret && !standInAt(text, end)) return null
            if (end == 0) return Caret(text, caret)
            val start = end - (if (end >= 2 && Character.isLowSurrogate(text[end - 1])) 2 else 1)
            return settle(text.substring(0, start) + text.substring(end), start + (caret - end))
        }
        var start = caret
        while (standInAt(text, start)) start += STAND_IN_LENGTH
        if (start >= text.length) return if (start == caret) null else Caret(text, start)
        val end = start + (if (Character.isHighSurrogate(text[start]) && start + 1 < text.length) 2 else 1)
        if (start == caret && !standInAt(text, end)) return null
        return settle(text.substring(0, start) + text.substring(end), caret)
    }

    private fun settle(text: String, caret: Int): Caret {
        var at = caret
        while (standInAt(text, at)) at += STAND_IN_LENGTH
        return Caret(text, at)
    }

    /**
     * The editor's onValueChange (§22.7 item 2): a deletion with nothing selected that took a stand-in (Compose's
     * Backspace takes a character together with the tag characters after it — one grapheme — and an IME may take only
     * the invisible one, or half of it) is redone so the stand-ins stay. `before` / `caret`: the text and the collapsed
     * caret before; `after` / `afterCaret`: what the field offers. Null: not such a deletion (take the field's value).
     * When the caret did not move as a Backspace or Delete would (an IME's own idea of it), the one run taken out is
     * found by comparing the texts, and taken as a Backspace (on the emulator an IME once left half a stand-in).
     *
     * - the visible part went with the stand-ins: the same deletion, the stand-ins put back where it was
     * - only stand-ins went: [deleteBeside] (the visible character beside them goes instead)
     */
    fun fixDeletion(before: String, caret: Int, after: String, afterCaret: Int): Caret? {
        val removed = before.length - after.length
        if (removed <= 0 || caret < 0 || caret > before.length || !hasStandIns(before)) return null
        var from: Int
        val backward: Boolean
        when {
            afterCaret == caret - removed && caret - removed >= 0 &&
                before.regionMatches(0, after, 0, afterCaret) && before.regionMatches(caret, after, afterCaret, before.length - caret) -> {
                backward = true; from = caret - removed
            }
            afterCaret == caret && caret + removed <= before.length &&
                before.regionMatches(0, after, 0, caret) && before.regionMatches(caret + removed, after, caret, after.length - caret) -> {
                backward = false; from = caret
            }
            else -> {
                // The caret moved otherwise (an IME working on a selection it last saw): any one run taken out.
                var prefix = 0
                while (prefix < after.length && before[prefix] == after[prefix]) prefix++
                if (!before.regionMatches(prefix + removed, after, prefix, after.length - prefix)) return null
                from = prefix
                backward = caret > from // most often a Backspace
            }
        }
        var to = from + removed
        // Stand-ins the deletion touched, widened to whole ones (an IME may cut a surrogate pair).
        if (from > 0 && standInAt(before, from - 1)) from -= 1
        if (to < before.length && to > 0 && standInAt(before, to - 1)) to += 1
        val anchor = if (backward) to else from
        val kept = StringBuilder()
        var visible = 0
        var i = from
        while (i < to) {
            if (standInAt(before, i)) { kept.append(before, i, i + STAND_IN_LENGTH); i += STAND_IN_LENGTH; continue }
            visible++
            i++
        }
        if (kept.isEmpty()) return null
        if (visible == 0) return deleteBeside(before, anchor, backward) ?: Caret(before.substring(0, from) + kept + before.substring(to), from + kept.length)
        return settle(before.substring(0, from) + kept + before.substring(to), from + kept.length)
    }
}
