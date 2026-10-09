package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/*
 * Workflows (M94 server and desktop, M95 here; docs/WORKFLOWS.md). The shapes are openapi.json's WorkflowOut /
 * WorkflowField / FieldDefault / MessageWorkflowOut. Phones only run workflows (§8 5.): nothing here writes one.
 */

/** `MessageOut.workflow`: the workflow whose form posted the message, by its name when it was posted (「⚡ name」). */
@Serializable
data class MessageWorkflowOut(val id: String, val name: String)

/**
 * What a field starts with (§3.1), filled in by this device: `literal` (`value`: a string, or a boolean for a checkbox),
 * `today`, `me`, or `next_weekday` (`weekday` 0 = Monday, today included). `time` goes with today / next_weekday on a
 * datetime field (09:00 when left out).
 */
@Serializable
data class FieldDefault(val kind: String, val value: JsonElement? = null, val weekday: Int? = null, val time: String? = null)

/** One field of the form (§3.1); `type` is text / textarea / date / time / datetime / select / user / checkbox. */
@Serializable
data class WorkflowField(
    val key: String,
    val label: String,
    val type: String,
    val required: Boolean = false,
    val help: String = "",
    val options: List<String> = emptyList(),
    val multiple: Boolean = false,
    val default: FieldDefault? = null,
)

/**
 * A workflow as GET /channels/{id}/workflows and GET /workflows/{id} return it. `runBlocked`: why I cannot submit it
 * (disabled / archived / not_a_member / posting_restricted), null when I can.
 */
@Serializable
data class WorkflowOut(
    val id: String,
    val name: String,
    val emoji: String? = null,
    val description: String = "",
    val channelId: String,
    val offeredChannelIds: List<String> = emptyList(),
    val fields: List<WorkflowField> = emptyList(),
    val template: String = "",
    val enabled: Boolean = true,
    /** 「確認を求める」 (WORKFLOWS.md §11). An older server leaves it out, and those workflows always asked. */
    val confirm: Boolean = true,
    val createdBy: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val canManage: Boolean = false,
    val canRun: Boolean = false,
    val runBlocked: String? = null,
) {
    /** Choosing it posts at once, without the form: 「確認」 off, nothing to fill, and I can run it (as on the desktop). */
    val postsWithoutAsking: Boolean get() = !confirm && fields.isEmpty() && canRun && runBlocked == null
}
