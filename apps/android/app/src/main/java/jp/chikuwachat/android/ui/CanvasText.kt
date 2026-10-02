package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import kotlin.math.abs

/**
 * M46: pure text helpers of the canvas screen (CANVAS.md §4.4 / §5), the desktop's src/ui/canvasText.ts: ticking a task
 * line, keeping the caret where it was when the body is replaced by the server's merged one, the headings for the
 * outline, the toolbar's edits and the sections a phone edits one at a time. apps/shared/canvas_markdown.json holds the
 * cases the three clients share (CanvasMarkdownTest).
 */
object CanvasText {
    /** A text and its selection (start ≤ end, UTF-16 offsets like TextRange). */
    data class Edit(val text: String, val start: Int, val end: Int = start)

    /**
     * The body with the task on `line` (0-based) ticked or unticked; null when that line is not a task (any more). Only
     * the box changes, so a member who may only tick (§4.7) sends a body the server accepts from them.
     */
    fun toggleTaskLine(body: String, line: Int, done: Boolean? = null): String? {
        val lines = body.split("\n").toMutableList()
        val current = lines.getOrNull(line) ?: return null
        val match = TASK_LINE.find(current) ?: return null
        val box = match.groupValues[1].length + 3 // "- [" then the mark
        val wasDone = match.groupValues[2] != " "
        val next = done ?: !wasDone
        if (next == wasDone) return body
        lines[line] = current.substring(0, box) + (if (next) "x" else " ") + current.substring(box + 1)
        return lines.joinToString("\n")
    }

    /**
     * Where the caret goes when the editor's text changes from `before` to `after` under it (a merge brought someone
     * else's edits): before the first difference it stays; after the last one it keeps its distance from the end; inside
     * the changed stretch it follows its own line when that line is still there (the nearest copy of it), else it goes to
     * the end of the change.
     */
    fun preserveCaret(before: String, after: String, caret: Int): Int {
        if (before == after) return minOf(caret, after.length)
        val max = minOf(before.length, after.length)
        var prefix = 0
        while (prefix < max && before[prefix] == after[prefix]) prefix++
        var suffix = 0
        while (suffix < max - prefix && before[before.length - 1 - suffix] == after[after.length - 1 - suffix]) suffix++
        if (caret <= prefix) return caret
        if (caret >= before.length - suffix) return maxOf(0, after.length - (before.length - caret))
        // Inside the changed stretch: find the caret's line in the new text, nearest to where it would have moved.
        val lineStart = before.lastIndexOf('\n', caret - 1) + 1
        val lineEndIndex = before.indexOf('\n', caret)
        val lineText = before.substring(lineStart, if (lineEndIndex == -1) before.length else lineEndIndex)
        val column = caret - lineStart
        val beforeLines = before.split("\n")
        val afterLines = after.split("\n")
        val lineIndex = before.substring(0, lineStart).split("\n").size - 1
        val expected = lineIndex + (afterLines.size - beforeLines.size)
        var best = -1
        if (lineText.isNotBlank()) {
            for (k in afterLines.indices) {
                if (afterLines[k] != lineText) continue
                if (best == -1 || abs(k - expected) < abs(best - expected) ||
                    (abs(k - expected) == abs(best - expected) && abs(k - lineIndex) < abs(best - lineIndex))
                ) best = k
            }
        }
        if (best != -1) {
            var offset = 0
            for (k in 0 until best) offset += afterLines[k].length + 1
            return offset + column
        }
        return maxOf(prefix, after.length - suffix)
    }

    data class OutlineEntry(val level: Int, val text: String, val line: Int)

    private val FENCE = Regex("^```")
    private val HEADING_LINE = Regex("""^(#{1,3})\s+(\S.*)$""")

    /** The headings of a body (outside code fences), for the outline of a long canvas. */
    fun outline(body: String): List<OutlineEntry> {
        val entries = ArrayList<OutlineEntry>()
        var fenced = false
        body.split("\n").forEachIndexed { index, line ->
            if (FENCE.containsMatchIn(line)) {
                fenced = !fenced
                return@forEachIndexed
            }
            if (fenced) return@forEachIndexed
            HEADING_LINE.find(line)?.let { entries.add(OutlineEntry(it.groupValues[1].length, CanvasMarkers.stripStandIns(CanvasMarkers.strip(it.groupValues[2])).replace(Regex("[*_~`]"), "").trim(), index)) }
        }
        return entries
    }

    /** The first and last line of the selection (or the caret's line), as offsets of their start and end. */
    private fun lineSpan(state: Edit): Pair<Int, Int> {
        val lineStart = state.text.lastIndexOf('\n', state.start - 1) + 1
        val lineEndIndex = state.text.indexOf('\n', maxOf(state.end - 1, state.start))
        return lineStart to (if (lineEndIndex == -1) state.text.length else lineEndIndex)
    }

    /** The caret's line (or the selected lines) as a heading of `level`; the same level again makes it text. */
    fun setHeading(state: Edit, level: Int): Edit {
        val (lineStart, lineEnd) = lineSpan(state)
        val lines = state.text.substring(lineStart, lineEnd).split("\n")
        val marker = "#".repeat(level) + " "
        val same = lines.all { it.startsWith(marker) }
        val next = lines.map { line ->
            val bare = line.replace(Regex("""^#{1,3}\s+"""), "")
            if (same) bare else marker + bare
        }
        val joined = next.joinToString("\n")
        val firstDelta = next[0].length - lines[0].length
        return Edit(state.text.substring(0, lineStart) + joined + state.text.substring(lineEnd), maxOf(lineStart, state.start + firstDelta), state.end + joined.length - (lineEnd - lineStart))
    }

    /** The selected lines as tasks ("- [ ] "; a bullet becomes one), or back to text when they all are tasks already. */
    fun toggleTasks(state: Edit): Edit {
        val (lineStart, lineEnd) = lineSpan(state)
        val lines = state.text.substring(lineStart, lineEnd).split("\n")
        val all = lines.all { TASK_LINE.matches(it) }
        val next = lines.map { line ->
            when {
                all -> line.replaceFirst(Regex("""^(\s*)[-*] \[[ xX]\] ?"""), "$1")
                TASK_LINE.matches(line) -> line
                else -> {
                    val m = Regex("""^(\s*)(?:[-*•]\s+)?(.*)$""").find(line)
                    "${m?.groupValues?.get(1).orEmpty()}- [ ] ${m?.groupValues?.get(2).orEmpty()}"
                }
            }
        }
        val joined = next.joinToString("\n")
        val firstDelta = next[0].length - lines[0].length
        return Edit(
            state.text.substring(0, lineStart) + joined + state.text.substring(lineEnd),
            maxOf(lineStart, state.start + firstDelta),
            maxOf(lineStart, state.end + joined.length - (lineEnd - lineStart)),
        )
    }

    /** Prefix every selected line (or the caret's line) with `marker` ("- "); when all have it already, take it off. */
    fun toggleLinePrefix(state: Edit, marker: String): Edit {
        val (lineStart, lineEnd) = lineSpan(state)
        val lines = state.text.substring(lineStart, lineEnd).split("\n")
        val allHave = lines.all { it.startsWith(marker) }
        val next = lines.joinToString("\n") { if (allHave) it.removePrefix(marker) else marker + it }
        val delta = next.length - (lineEnd - lineStart)
        return Edit(
            state.text.substring(0, lineStart) + next + state.text.substring(lineEnd),
            maxOf(lineStart, state.start + if (allHave) -marker.length else marker.length),
            maxOf(lineStart, state.end + delta),
        )
    }

    /** Wrap the selection in `mark` (bold: "**"), or unwrap it when it is wrapped already. */
    fun toggleWrap(state: Edit, mark: String): Edit {
        val (text, start, end) = state
        val selected = text.substring(start, end)
        val before = text.substring(0, start)
        val after = text.substring(end)
        if (before.endsWith(mark) && after.startsWith(mark)) {
            return Edit(before.dropLast(mark.length) + selected + after.drop(mark.length), start - mark.length, end - mark.length)
        }
        if (selected.length >= mark.length * 2 && selected.startsWith(mark) && selected.endsWith(mark)) {
            val inner = selected.substring(mark.length, selected.length - mark.length)
            return Edit(before + inner + after, start, start + inner.length)
        }
        return Edit(before + mark + selected + mark + after, start + mark.length, end + mark.length)
    }

    /** A Markdown link around the selection (or 「リンク」), the url part selected. */
    fun insertLink(state: Edit, url: String = "https://"): Edit {
        val selected = state.text.substring(state.start, state.end).ifEmpty { "リンク" }
        val inserted = "[$selected]($url)"
        val urlStart = state.start + selected.length + 3
        return Edit(state.text.substring(0, state.start) + inserted + state.text.substring(state.end), urlStart, urlStart + url.length)
    }

    /** An `@` at the caret (after a space when it follows a word), for the mention completion. */
    fun insertMention(state: Edit): Edit {
        val lead = if (state.start > 0 && !state.text[state.start - 1].isWhitespace()) " @" else "@"
        val at = state.start + lead.length
        return Edit(state.text.substring(0, state.start) + lead + state.text.substring(state.end), at, at)
    }

    /** A rule ("---") on a line of its own between blank lines, after the caret's line; the caret goes below it. */
    fun insertRule(state: Edit): Edit {
        val lineEndIndex = state.text.indexOf('\n', state.end)
        val at = if (lineEndIndex == -1) state.text.length else lineEndIndex
        val before = state.text.substring(0, at)
        val after = state.text.substring(at)
        val lead = when {
            before.isEmpty() -> ""
            before.endsWith("\n\n") -> ""
            before.endsWith("\n") -> "\n"
            else -> "\n\n"
        }
        val inserted = "$lead---\n\n"
        val rest = if (after.startsWith("\n")) after.drop(1) else after
        val caret = before.length + inserted.length
        return Edit(before + inserted + rest, caret)
    }

    private val TASK_ITEM = Regex("""^(\s*)([-*]) \[[ xX]\](?: (.*))?$""")
    private val LIST_LINE = Regex("""^(\s*)(?:([-*•])|(\d{1,3})\.)\s(.*)$""")
    private val QUOTE_LINE = Regex("""^(>\s?)(.*)$""")

    /**
     * Enter inside a list, a checklist or a quote: continue it on the next line (a new open box, numbers counting up);
     * Enter on an empty item ends it instead. Null when Enter should just break the line.
     */
    fun continueStructure(state: Edit): Edit? {
        val (text, start) = state
        val lineStart = text.lastIndexOf('\n', start - 1) + 1
        val line = text.substring(lineStart, start)
        fun end() = Edit(text.substring(0, lineStart) + text.substring(start), lineStart)
        fun insert(marker: String): Edit {
            val inserted = "\n" + marker
            return Edit(text.substring(0, start) + inserted + text.substring(start), start + inserted.length)
        }
        TASK_ITEM.find(line)?.let { m ->
            return if (m.groupValues[3].isBlank()) end() else insert("${m.groupValues[1]}${m.groupValues[2]} [ ] ")
        }
        LIST_LINE.find(line)?.let { m ->
            if (m.groupValues[4].isBlank()) return end()
            val bullet = m.groupValues[2]
            return insert(if (bullet.isNotEmpty()) "${m.groupValues[1]}$bullet " else "${m.groupValues[1]}${m.groupValues[3].toInt() + 1}. ")
        }
        QUOTE_LINE.find(line)?.let { m -> return if (m.groupValues[2].isBlank()) end() else insert(m.groupValues[1]) }
        return null
    }

    /** `@name` after anything but a letter, digit, `.`, `_`, `-` or `@` (an e-mail address stays text). */
    private val CANVAS_HANDLE = Regex("""(^|[^A-Za-z0-9._@<-])@([A-Za-z0-9._-]+)""")

    /**
     * The editor's `@username` back to the stored `<@uuid>` (§4.2). Unlike the composer's [Mentions.encode] (a mention
     * after a space or "("), a handle right after Japanese text counts too: the editor shows every stored mention as
     * `@username` (「…まとめます。@android2 さん」), and the composer's rule turned such a mention into plain text at the
     * first save after any edit (M46, found on the emulator; the desktop's encodeMentions has the same rule).
     */
    fun encodeMentions(text: String, users: Collection<UserPublic>, groups: Collection<GroupOut> = emptyList()): String {
        val byName = HashMap<String, String>()
        users.forEach { byName[it.username.lowercase()] = "<@${it.id}>" }
        groups.forEach { byName[it.name.lowercase()] = "<@group:${it.id}>" }
        return CANVAS_HANDLE.replace(text) { match ->
            val lead = match.groupValues[1]
            val name = match.groupValues[2].lowercase()
            when {
                name == "channel" || name == "here" -> "$lead<!$name>"
                byName[name] != null -> lead + byName.getValue(name)
                else -> match.value
            }
        }
    }

    /** Task counts as the server makes them for a list (the "3/8" beside a canvas). */
    fun taskProgress(total: Int, done: Int): String? = if (total > 0) "$done/$total" else null

    /** The canvas the tab opens on: the conversation's tab canvas, else the most recently updated one. */
    fun defaultCanvasId(list: List<CanvasMeta>): String? = (list.firstOrNull { it.isChannelTab } ?: list.firstOrNull())?.id

    // --- images (M58, CANVAS.md §4.10; the desktop's M44 canvasText.ts) ---------------------------

    /** How many attachments one canvas may name (the server's `too_many_canvas_images`). */
    const val MAX_IMAGES = 100

    private val ATTACHMENT_REF = Regex("""\(attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)""", RegexOption.IGNORE_CASE)

    /** The distinct attachments a body names (`attachment:<id>`, as the server counts them when it binds). */
    fun attachmentRefs(body: String): Set<String> = ATTACHMENT_REF.findAll(body).map { it.groupValues[1].lowercase() }.toSet()

    /** Whether `adding` more images keep the body within [MAX_IMAGES] (else nothing is uploaded). */
    fun imagesFit(body: String, adding: Int): Boolean = attachmentRefs(body).size + adding <= MAX_IMAGES

    /**
     * An image `![alt](attachment:<id>)` on a line of its own at the caret (replacing a selection); the caret goes to the
     * line after it. The same text the desktop's insertImageLine makes.
     */
    fun insertImageLine(state: Edit, attachmentId: String, alt: String = ""): Edit {
        val text = state.text
        val start = state.start.coerceIn(0, text.length)
        val end = state.end.coerceIn(start, text.length)
        val before = text.substring(0, start)
        val after = text.substring(end)
        val lead = if (before.isEmpty() || before.endsWith("\n")) "" else "\n"
        val trail = if (after.startsWith("\n")) "" else "\n"
        val line = "![" + alt.replace(Regex("[\\]\n]"), " ") + "](attachment:" + attachmentId + ")"
        val caret = before.length + lead.length + line.length + 1
        return Edit(before + lead + line + trail + after, caret)
    }

    /** The server's excerpt is the body's plain text: an image reference reads as 「[画像]」 instead of its id. */
    fun readableSnippet(snippet: String): String =
        snippet.replace(Regex("""!\[([^\]\n]*)\]\(attachment:[0-9a-fA-F-]*\)?""")) { match ->
            val alt = match.groupValues[1]
            if (alt.isNotEmpty()) "[画像: $alt]" else "[画像]"
        }
}

/**
 * M46 (CANVAS.md §5 Android 「既定はセクション編集」): a phone edits a long canvas one heading at a time. A section is a
 * heading line (outside code fences) and the lines up to the next heading of any level; the text before the first
 * heading is not a section (the whole-body editor covers it). The section's body is put back into the whole body, which
 * is what is saved (§4.4): the server merges it with what others changed meanwhile, in this section or another.
 */
object CanvasSections {
    /** Which section: its heading line as written, and which of the headings with that line it is (0 = the first). */
    data class Key(val heading: String, val occurrence: Int)

    private val HEADING_LINE = Regex("""^#{1,3}\s+\S""")

    /** The heading lines of a body, outside code fences. */
    fun headingLines(body: String): List<Int> {
        val result = ArrayList<Int>()
        var fenced = false
        body.split("\n").forEachIndexed { index, line ->
            if (line.startsWith("```")) fenced = !fenced
            else if (!fenced && HEADING_LINE.containsMatchIn(line)) result.add(index)
        }
        return result
    }

    /** The key of the section whose heading is on `line`; null when that line is no heading. */
    fun keyAt(body: String, line: Int): Key? {
        val lines = body.split("\n")
        val headings = headingLines(body)
        if (line !in headings) return null
        val heading = lines[line]
        return Key(heading, headings.filter { it < line }.count { lines[it] == heading })
    }

    /**
     * The lines under the heading of the section `key` names, up to the next heading ([start, end); empty when none).
     * The heading itself is not edited in the section's sheet, so the section keeps its name while it is open. Null when
     * no heading with that line is left (someone else changed or removed it).
     */
    fun find(body: String, key: Key): IntRange? {
        val lines = body.split("\n")
        val headings = headingLines(body)
        val same = headings.filter { lines[it] == key.heading }
        val heading = same.getOrNull(key.occurrence) ?: same.lastOrNull() ?: return null
        val end = headings.firstOrNull { it > heading } ?: lines.size
        return heading + 1 until end
    }

    /** The section's text (its lines joined). */
    fun text(body: String, range: IntRange): String = body.split("\n").subList(range.first, range.last + 1).joinToString("\n")

    /** The body with the section's lines replaced by `section` (an emptied section takes its lines away). */
    fun replace(body: String, range: IntRange, section: String): String {
        val lines = body.split("\n")
        val middle = if (section.isEmpty()) emptyList() else section.split("\n")
        return (lines.subList(0, range.first) + middle + lines.subList(range.last + 1, lines.size)).joinToString("\n")
    }
}

/**
 * M46: who may do what with a conversation's canvases (CANVAS.md §4.7), as the server decides it
 * (server/app/modules/canvases/service.py), the desktop's src/ui/canvasAccess.ts. The screen only hides what would be
 * refused; the server checks every call.
 */
data class CanvasRights(
    /** Make a canvas in the conversation. */
    val create: Boolean = false,
    /** Change the body (the editor). */
    val edit: Boolean = false,
    /** Tick tasks (everyone but guests, whatever edit_policy says; in a DM its members). */
    val tick: Boolean = false,
    /** Title, edit_policy, the conversation's tab. */
    val manage: Boolean = false,
    /** To the trash and back. */
    val trash: Boolean = false,
    /** M58: erase a version's body (§4.7: owners and administrators; in a DM its creator). */
    val erase: Boolean = false,
    /** M58: 「会話に共有」 (posting the link is posting a message: not where only owners post, unless one). */
    val share: Boolean = false,
) {
    /** Ticking is all this member may do (the conflict choice is then only 「相手の版」). */
    val tickOnly: Boolean get() = tick && !edit

    companion object {
        val NONE = CanvasRights()

        /** Rights in the conversation for a canvas (null: only whether one can be made). `role`: my system role. */
        fun of(channel: ChannelState, myId: String?, role: String?, canvas: CanvasMeta?): CanvasRights {
            if (!channel.isMember || channel.channel.archived) return NONE // an archived conversation's canvases are read only
            if (channel.channel.isDm) {
                val creator = canvas != null && canvas.createdBy == myId
                return CanvasRights(create = true, edit = true, tick = true, manage = true, trash = canvas != null && creator, erase = creator, share = canvas != null)
            }
            val guest = role == "guest"
            val manager = role == "admin" || channel.channel.membership?.role == "owner"
            val create = !guest && (channel.channel.postingPolicy != "owners" || manager)
            if (canvas == null) return NONE.copy(create = create)
            val creator = canvas.createdBy == myId
            val edit = if (canvas.editPolicy == "owners") !guest && (creator || manager) else create
            val manage = !guest && (creator || manager)
            // Sharing posts a message: whoever may post at the top level (a guest may post in a channel they are in).
            val share = channel.channel.postingPolicy != "owners" || manager
            return CanvasRights(create = create, edit = edit, tick = edit || !guest, manage = manage, trash = manage, erase = manager, share = share)
        }
    }
}
