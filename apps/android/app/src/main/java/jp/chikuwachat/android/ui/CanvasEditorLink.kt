package jp.chikuwachat.android.ui

import jp.chikuwachat.android.sync.CanvasSaver

/**
 * The canvas editor's tie to its save loop (CanvasEditorField): the stored body the editor last showed or wrote
 * ([wire]), the section's lines in it ([range], null: the whole body), and (CANVAS.md §24.3) the saver's generation of
 * that body ([lineage], [CanvasSaver.textLineage]).
 *
 * The loop may put a new body in (a merge landed, someone else's version was read) a frame before the editor takes it
 * (Compose's next LaunchedEffect), and never under an open IME composition. A keystroke in between is written on the
 * body the editor shows: every edit names that body's generation, so the loop saves it on that body's version and the
 * server merges it with the newer one again — instead of a direct save over the newer body, which took the other
 * people's merged edits back out. A section's lines go back into [wire] (the body its range belongs to), never into a
 * newer body the loop holds.
 */
internal class EditorLink(var wire: String, var range: IntRange?, var lineage: Int) {
    /**
     * The editor's text changed (`encoded`: in the stored form): the whole body it makes, the section's lines put back
     * into [wire]. Null: a section editor without its section.
     */
    fun written(encoded: String, section: Boolean): String? {
        val stored = if (!section) encoded else {
            val at = range ?: return null
            val lines = if (encoded.isEmpty()) 0 else encoded.split("\n").size
            range = at.first until at.first + lines
            CanvasSections.replace(wire, at, encoded)
        }
        wire = stored
        return stored
    }

    /** [written], handed to the loop with the generation it was written on. */
    fun commit(saver: CanvasSaver, encoded: String, section: Boolean) {
        val stored = written(encoded, section) ?: return
        saver.edit(stored, basedOn = lineage)
    }

    /**
     * The loop's state changed: whether the editor is to take the loop's body now (then [took]). The same body: nothing
     * to show, it is this generation's now. Not while an IME composition is open (asked again when it ends).
     */
    fun shouldTake(saver: CanvasSaver, composing: Boolean): Boolean {
        if (saver.text == wire) {
            lineage = saver.textLineage
            return false
        }
        return !composing
    }

    /** The editor shows the loop's body `stored` (its section at `section`). */
    fun took(stored: String, generation: Int, section: IntRange?) {
        wire = stored
        lineage = generation
        range = section
    }
}
