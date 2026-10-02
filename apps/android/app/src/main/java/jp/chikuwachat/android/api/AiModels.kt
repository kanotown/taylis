package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

// M66 (docs/AI.md §5): the AI bot and private summaries. Every field has a default so a server that adds or leaves out
// a key still decodes (Codec.snake ignores unknown keys).

/** An AI bot as everyone sees it: `bot_user_id` is its user (role "bot"), shown with 「AI」 instead of 「BOT」. */
@Serializable
data class AiAgentPublic(val id: String, val botUserId: String, val name: String = "", val model: String = "")

/** GET /ai/status. `summary_available`: AI is on and this month's budget is not spent. */
@Serializable
data class AiStatusOut(val available: Boolean = false, val summaryAvailable: Boolean = false, val agents: List<AiAgentPublic> = emptyList())

/** A summary (or mention) run; `output` is Markdown once `status` is "done", `error` when "failed". */
@Serializable
data class AiRunOut(
    val id: String,
    val kind: String = "summary",
    val status: String = "pending",
    val channelId: String? = null,
    val threadId: String? = null,
    val scope: String? = null,
    val days: Int? = null,
    val output: String? = null,
    val error: String? = null,
    val omittedCount: Int = 0,
    val createdAt: String = "",
    val finishedAt: String? = null,
    /** Review v0.1.18 #2: where the run is sent ("anthropic" | "openai"), fixed when asked. Null on an older server. */
    val provider: String? = null,
    val model: String? = null,
) {
    /** "done" and "failed" are final: nothing changes the run after them. */
    val finished: Boolean get() = status == "done" || status == "failed"
}

/**
 * GET /ai/summaries/target?channel_id= (review v0.1.18 #2, docs/AI.md §5): where a summary of this conversation would go.
 * `reason` (ai_unavailable / ai_private_not_allowed / ai_budget_exceeded) when it cannot be asked for now. Lenient: a
 * missing `available` counts as true (nothing disabled by mistake), the rest null.
 */
@Serializable
data class AiSummaryTargetOut(
    val available: Boolean = true,
    val provider: String? = null,
    val model: String? = null,
    val agentName: String? = null,
    val reason: String? = null,
)

/** POST /ai/summaries. Absent fields are left out (Codec.snake drops nulls). */
@Serializable
data class AiSummaryIn(
    val channelId: String,
    val scope: String,
    val threadId: String? = null,
    val days: Int? = null,
    val tzOffsetMinutes: Int? = null,
)

/** The ai.run_updated event (to the person who asked only). */
@Serializable
data class AiRunUpdated(val run: AiRunOut)
