package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.CanvasMentioned
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import java.time.LocalDate
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M73 (CANVAS.md §18.3 / §18.5): 「タスクにする」 on a canvas's checklist item — what the task form starts with; a port of
 * the desktop's ui/canvasTasks.ts. Pure: the canvas pane and the JVM tests use it.
 *
 * - title: the item's text (the box gone, mentions as names, a `📅 YYYY-MM-DD` taken out), 200 characters at most
 * - due date: the item's `📅 YYYY-MM-DD` (the minutes template's way, §4.12), when it is a real date
 * - assignees: the people the item mentions (groups not expanded), offered where the task is shared
 * - where it goes: the rule of a message's 「タスクにする」 (the channel's board when I may add to it; a DM's canvas: mine,
 *   shared in the DM once someone is assigned)
 */
object CanvasTasks {
    private val DUE = Regex("""📅\s*(\d{4}-\d{2}-\d{2})""")
    private val USER_TOKEN = Regex("""<@([0-9a-f-]{36})>""")

    /**
     * A checklist item: the line as it is in the body (the server finds it there, §18.3; M83: with any task marker),
     * the text after the box (without task markers, §22.7 item 4).
     */
    data class Item(val line: String, val text: String, val done: Boolean)

    /** Line `index` of the body, when it is a checklist item. */
    fun checklistItem(body: String, index: Int): Item? {
        val line = body.split("\n").getOrNull(index) ?: return null
        val match = TASK_LINE.matchEntire(line) ?: return null
        return Item(line, CanvasMarkers.strip(match.groupValues[3]).trim(), match.groupValues[2] != " ")
    }

    /** A real calendar date in `YYYY-MM-DD` (not 2026-02-30). */
    private fun validDay(value: String): Boolean = runCatching { LocalDate.parse(value) }.isSuccess

    /** What the task form starts with for checklist item `index` of the canvas `canvasId` (body `body`) in `channel`. */
    fun taskInit(
        canvasId: String, body: String, index: Int, channel: ChannelState?, users: Map<String, UserPublic>,
        groups: Map<String, GroupOut>, isAdmin: Boolean,
    ): TaskCreateInit? {
        val item = checklistItem(body, index) ?: return null
        val due = DUE.find(item.text)?.groupValues?.get(1)?.takeIf { validDay(it) } ?: ""
        val title = plainText(Mentions.toNames(DUE.replaceFirst(item.text, " "), users, groups), TaskRules.MAX_TITLE)
        val assignees = USER_TOKEN.findAll(item.text).map { it.groupValues[1] }.distinct().filter { it in users }.toList()
        val board = channel?.takeIf { TaskRules.canEditBoard(it, isAdmin) }?.id
        // A DM's (or group DM's) canvas: mine, shared in the DM once someone is assigned (L9).
        val share = channel?.takeIf { !TaskRules.hasBoard(it.channel) && TaskRules.canShareInDm(it) && TaskRules.hasOthers(it) }?.id
        return TaskCreateInit(
            channelId = board,
            title = title,
            boardChoices = listOfNotNull(board),
            dmChannelId = share,
            assigneeIds = if (board != null || share != null) assignees else emptyList(),
            dueOn = due,
            sourceCanvasId = canvasId,
            sourceCanvasLine = item.line,
            sourceCanvasExcerpt = plainText(Mentions.toNames(item.text, users, groups), TaskRules.MAX_TITLE).ifEmpty { null },
        )
    }

    /** The heading the caret is under (`caret` an offset into `text`), for `canvas_presence`'s `section`. */
    fun sectionAt(text: String, caret: Int): String? {
        val line = text.substring(0, caret.coerceIn(0, text.length)).count { it == '\n' }
        return CanvasText.outline(text).lastOrNull { it.line <= line }?.text
    }

    /**
     * canvas.mentioned while the app is open, worded like the server's push: 「〇〇 が「題名」であなたをメンションしました」,
     * with the channel for a channel's canvas (CANVAS.md §18.1).
     */
    fun mentionText(mention: CanvasMentioned, channel: ChannelState?, nameOf: (String) -> String?): String {
        val who = nameOf(mention.byUserId) ?: L10n.str(R.string.common_member)
        val where = channel?.channel?.takeIf { TaskRules.hasBoard(it) && !it.name.isNullOrEmpty() }?.let { " (#${it.name})" } ?: ""
        return L10n.str(R.string.canvas_tasks_mentioned_you_in, who, mention.title, where)
    }
}
