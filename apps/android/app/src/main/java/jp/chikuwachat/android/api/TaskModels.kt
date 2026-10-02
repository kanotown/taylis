package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/*
 * Tasks and kanban (TASKS.md; the server and web in M55, this client in M56). The shapes are openapi.json's TaskOut /
 * TaskSourceOut / TaskCreate / TaskUpdate / TaskMove and ws-events.json's task.* data. Decoding is tolerant (defaults for
 * what a field-by-field reader could miss), like the calendar's.
 */

/** The task's columns (TASKS.md §1), in board order. */
object TaskStatus {
    const val TODO = "todo"
    const val DOING = "doing"
    const val DONE = "done"
    val all: List<String> = listOf(TODO, DOING, DONE)
}

/** L9 (REVIEWS.md §2.2, §7 3.): what a task is — made with 「タスクにする」 or 「レビューを依頼」 (only the wording differs). */
object TaskKind {
    const val TASK = "task"
    const val REVIEW = "review"
}

/**
 * L9 (REVIEWS.md §2.2): a shared task made from a message, as MessageOut.tasks carries it (the chip under the message).
 * Personal tasks never show here. Lenient like the rest: a missing field takes its default.
 */
@Serializable
data class MessageTaskOut(
    val id: String,
    val kind: String = TaskKind.TASK,
    val status: String = TaskStatus.TODO,
    val assigneeIds: List<String> = emptyList(),
    /** "YYYY-MM-DD". */
    val dueOn: String? = null,
    val ownerId: String = "",
    /** M84 (TASKS.md §11.3): the due time (UTC), when it has one. */
    val dueAt: String? = null,
)

/**
 * The message a task was made from: `message_id` and `excerpt` become null once that message is deleted (「元のメッセージは
 * 削除されました」, TASKS.md §8 1.); `excerpt` alone is null when I can no longer read it.
 */
@Serializable
data class TaskSourceOut(val messageId: String? = null, val channelId: String = "", val excerpt: String? = null)

/**
 * M73 (TASKS.md §10, CANVAS.md §18.3): the canvas checklist item a task was made from. `canvas_id` is null once the canvas
 * was purged from the trash (「元のキャンバスは削除されました」); `excerpt` is the item's text as it was then.
 */
@Serializable
data class TaskCanvasSourceOut(val canvasId: String? = null, val excerpt: String? = null)

/**
 * A task as I see it. `channel_id` null: a personal task (only its owner sees it). task.updated carries the same shape
 * without `can_delete` (it differs per person): it is filled in from `deleter_ids` here (TASKS.md §8 4.).
 */
@Serializable
data class TaskOut(
    val id: String,
    val channelId: String? = null,
    val channelName: String? = null,
    val ownerId: String = "",
    val title: String,
    val notes: String? = null,
    val status: String = TaskStatus.TODO,
    val position: Double = 0.0,
    /** "YYYY-MM-DD" (a date only, no time). */
    val dueOn: String? = null,
    val assigneeIds: List<String> = emptyList(),
    val source: TaskSourceOut? = null,
    val completedAt: String? = null,
    val completedBy: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
    val canDelete: Boolean = false,
    /** L9: "task" or "review" (a server before M63 sends none: "task"). */
    val kind: String = TaskKind.TASK,
    /** M73: made from a canvas's checklist item (apart from `source`, which phones before M73 read as a message). */
    val canvasSource: TaskCanvasSourceOut? = null,
    /**
     * M84 (TASKS.md §11.3): the due time (UTC; null = the whole day `due_on`) and the zone its wall clock is read in
     * (`due_on` is its date there). A server before M81 sends none of these: the defaults are what it means.
     */
    val dueAt: String? = null,
    val dueTz: String? = null,
    /** M84: the one-level checklist, in order (「☑ 2/5」). */
    val subtasks: List<SubtaskOut> = emptyList(),
    /** M84: the repeat rule (CALENDAR.md §10.1's subset; the server makes the next one on completion). */
    val rrule: String? = null,
    /** M84: an added column of the board; null = the built-in column of `status` (which keeps its three values). */
    val columnId: String? = null,
)

/** M84 (TASKS.md §11.2): one item of a task's checklist. */
@Serializable
data class SubtaskOut(val id: String, val title: String, val done: Boolean = false)

/** M84: an item as sent with the whole list (`id` null, left out: a new one). */
@Serializable
data class SubtaskIn(val id: String? = null, val title: String, val done: Boolean = false)

/**
 * M84 (TASKS.md §11.2, §11.5): a column of a channel's board, belonging to one of the three statuses (its cards have that
 * status). The three built-in ones cannot be deleted. A server before M81 has no columns: TaskRules.FALLBACK_COLUMNS.
 */
@Serializable
data class TaskColumnOut(
    val id: String,
    val channelId: String = "",
    val name: String,
    val status: String = TaskStatus.TODO,
    val builtin: Boolean = false,
    val position: Double = 0.0,
)

/** task.columns.updated: a board's columns, all of them. */
@Serializable
data class TaskColumnsUpdated(val channelId: String, val columns: List<TaskColumnOut> = emptyList())

/** task.updated: the task as everyone who sees it sees it, and who may delete it. */
@Serializable
data class TaskUpdated(val task: TaskOut, val deleterIds: List<String> = emptyList())

/** task.deleted. */
@Serializable
data class TaskDeleted(val id: String, val channelId: String? = null)

/** task.assigned (to me only): someone else added me to a shared task's assignees. */
@Serializable
data class TaskAssigned(
    val taskId: String, val channelId: String, val channelName: String = "", val title: String = "", val byUserId: String = "",
    /** L9: "review" words it 「〇〇 がレビューを依頼しました」. */
    val kind: String = TaskKind.TASK,
)

/** task.review_done (to the requester only, L9 REVIEWS.md §4): an assignee completed my review request. */
@Serializable
data class TaskReviewDone(val taskId: String, val channelId: String, val channelName: String = "", val title: String = "", val byUserId: String = "")

/** task.due (to me only): one of my open tasks is due today (8:00 in my zone), sent once. */
@Serializable
data class TaskDue(
    val taskId: String, val channelId: String? = null, val channelName: String? = null, val title: String = "", val dueOn: String = "",
    /** M84: a due time (the notification went out at it) and the zone it is read in. */
    val dueAt: String? = null, val tz: String? = null,
)

/**
 * POST /tasks. `client_task_id` makes a retry return the same task; `tz` is the zone the due date's 8:00 is read in
 * (TASKS.md §8 2.). Absent fields are left out (Codec.snake drops nulls).
 */
@Serializable
data class TaskCreate(
    val channelId: String? = null,
    val title: String,
    val notes: String? = null,
    val status: String = TaskStatus.TODO,
    val dueOn: String? = null,
    val assigneeIds: List<String>? = null,
    val sourceMessageId: String? = null,
    val clientTaskId: String? = null,
    val tz: String? = null,
    /** L9: "review" for 「レビューを依頼」 (needs `source_message_id`); left out for a plain task (the server's default). */
    val kind: String? = null,
    /** M73 (TASKS.md §10): a canvas's checklist item — the canvas and the line as it is in its body (`- [ ] …`), together. */
    val sourceCanvasId: String? = null,
    val sourceCanvasLine: String? = null,
    /** M84: a due time with the device's offset (the server takes `due_on` from it), the rule, the checklist. */
    val dueAt: String? = null,
    val rrule: String? = null,
    val subtasks: List<SubtaskIn>? = null,
)

/**
 * PATCH /tasks/{id}: only what changed. `notes` and `due_on` can be cleared, so whether they are sent is apart from their
 * value (`setNotes` / `setDueOn`: sent, null written out). `assignee_ids` replaces the whole list.
 */
data class TaskUpdate(
    val title: String? = null,
    val setNotes: Boolean = false,
    val notes: String? = null,
    val status: String? = null,
    val setDueOn: Boolean = false,
    val dueOn: String? = null,
    val tz: String? = null,
    val assigneeIds: List<String>? = null,
    /** M84: `due_at` (null written out: back to the whole day, the date kept). */
    val setDueAt: Boolean = false,
    val dueAt: String? = null,
    /** M84: `rrule` (null written out: stop repeating). */
    val setRrule: Boolean = false,
    val rrule: String? = null,
    /** M84: the whole checklist (known ids kept). */
    val subtasks: List<SubtaskIn>? = null,
) {
    val isEmpty: Boolean
        get() = title == null && !setNotes && status == null && !setDueOn && assigneeIds == null && !setDueAt && !setRrule && subtasks == null

    fun toJson(): JsonObject = buildJsonObject {
        title?.let { put("title", JsonPrimitive(it)) }
        if (setNotes) put("notes", notes?.let { JsonPrimitive(it) } ?: JsonNull)
        status?.let { put("status", JsonPrimitive(it)) }
        if (setDueOn) put("due_on", dueOn?.let { JsonPrimitive(it) } ?: JsonNull)
        if (setDueAt) put("due_at", dueAt?.let { JsonPrimitive(it) } ?: JsonNull)
        tz?.let { put("tz", JsonPrimitive(it)) }
        if (setRrule) put("rrule", rrule?.let { JsonPrimitive(it) } ?: JsonNull)
        subtasks?.let { items -> put("subtasks", JsonArray(items.map { Codec.snake.encodeToJsonElement(SubtaskIn.serializer(), it) })) }
        assigneeIds?.let { ids -> put("assignee_ids", JsonArray(ids.map { JsonPrimitive(it) })) }
    }
}

/** Where a moved card lands in its column: the card just above it (`after_id`) and just below (`before_id`). */
data class TaskNeighbors(val afterId: String?, val beforeId: String?) {
    companion object {
        /** Neither: the server's default place (the bottom of todo / doing, the top of done). */
        val NONE = TaskNeighbors(null, null)
    }
}

/** POST /tasks/{id}/move's body (the server picks the position). */
fun taskMoveJson(status: String, neighbors: TaskNeighbors): JsonObject = buildJsonObject {
    put("status", JsonPrimitive(status))
    put("after_id", neighbors.afterId?.let { JsonPrimitive(it) } ?: JsonNull)
    put("before_id", neighbors.beforeId?.let { JsonPrimitive(it) } ?: JsonNull)
}

/** M84: POST /tasks/{id}/move into a column of the board (the card takes the column's status). */
fun taskColumnMoveJson(columnId: String, neighbors: TaskNeighbors): JsonObject = buildJsonObject {
    put("column_id", JsonPrimitive(columnId))
    put("after_id", neighbors.afterId?.let { JsonPrimitive(it) } ?: JsonNull)
    put("before_id", neighbors.beforeId?.let { JsonPrimitive(it) } ?: JsonNull)
}

/** M84: POST /tasks/columns (no `after_id`: the right end). */
fun taskColumnCreateJson(channelId: String, name: String, status: String, afterId: String? = null): JsonObject = buildJsonObject {
    put("channel_id", JsonPrimitive(channelId))
    put("name", JsonPrimitive(name))
    put("status", JsonPrimitive(status))
    afterId?.let { put("after_id", JsonPrimitive(it)) }
}

/** M84: PATCH /tasks/columns/{id}: a new name and / or a place (`move`: `after_id` sent, null = the left end). */
fun taskColumnUpdateJson(name: String? = null, move: Boolean = false, afterId: String? = null): JsonObject = buildJsonObject {
    name?.let { put("name", JsonPrimitive(it)) }
    if (move) put("after_id", afterId?.let { JsonPrimitive(it) } ?: JsonNull)
}
