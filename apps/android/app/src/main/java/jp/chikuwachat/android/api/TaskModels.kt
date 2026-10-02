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
)

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
data class TaskDue(val taskId: String, val channelId: String? = null, val channelName: String? = null, val title: String = "", val dueOn: String = "")

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
) {
    val isEmpty: Boolean get() = title == null && !setNotes && status == null && !setDueOn && assigneeIds == null

    fun toJson(): JsonObject = buildJsonObject {
        title?.let { put("title", JsonPrimitive(it)) }
        if (setNotes) put("notes", notes?.let { JsonPrimitive(it) } ?: JsonNull)
        status?.let { put("status", JsonPrimitive(it)) }
        if (setDueOn) put("due_on", dueOn?.let { JsonPrimitive(it) } ?: JsonNull)
        tz?.let { put("tz", JsonPrimitive(it)) }
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
