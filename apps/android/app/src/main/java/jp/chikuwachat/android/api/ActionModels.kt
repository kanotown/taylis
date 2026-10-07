package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

/**
 * M143 (docs/ACTIONS.md §7.1): one 操作ボタン I may press. Never carries the relay's URL, `action_key` or who may press:
 * the server checks that at every press. `icon`: a key of apps/shared/attendance-icons.json (ui/AttendanceIcons);
 * `emoji` the fallback. `confirmText` null = the app's sentence (「研究室の鍵：開ける を実行しますか？」).
 */
@Serializable
data class ActionOut(
    val id: String,
    val name: String,
    val groupLabel: String? = null,
    val icon: String? = null,
    val emoji: String? = null,
    val confirm: Boolean = true,
    val confirmText: String? = null,
    val position: Int = 0,
    /** §12: this button gives its group's state (one per group); "状態を確認中…" until the first answer. */
    val providesStatus: Boolean = false,
)

/**
 * M143: GET /actions and bootstrap's `actions` (null there for guests, while off and from a server before M143).
 * `showOnAttendance`: the buttons also go on top of 在室状況 and in the quick-switch sheet (§2 D17).
 */
@Serializable
data class ActionListOut(
    val enabled: Boolean,
    val showOnAttendance: Boolean = false,
    val actions: List<ActionOut> = emptyList(),
)

/**
 * M143 (§4): the answer of POST /actions/{id}/invoke. A relay that failed is still HTTP 200 with `ok: false`; `error`:
 * timeout / network / relay_error / url_not_allowed / secret_missing / interrupted. `repeated`: the server answered a
 * repeated `client_invoke_id` with the first result (the relay was not called again).
 */
@Serializable
data class ActionInvokeOut(
    val invokeId: String,
    val actionId: String,
    val ok: Boolean,
    /** succeeded / failed / pending */
    val status: String,
    val statusCode: Int? = null,
    val error: String? = null,
    val message: String? = null,
    val at: String,
    val repeated: Boolean = false,
)

/** §12.2: one line of a state's details (「電池」「85%」). */
@Serializable
data class ActionStatusDetail(val label: String, val value: String)

/** §12.2: what the relay said: `tone` ok / warn / alert / neutral (unknown = neutral), `state` a short word, ≤ 6 details. */
@Serializable
data class ActionStatusValue(
    val text: String,
    val tone: String = "neutral",
    val state: String? = null,
    val details: List<ActionStatusDetail> = emptyList(),
)

/**
 * §12.3: a group's state. `actionId` is the button that gives it (maybe one I may not press: match by `groupLabel`, or by
 * `actionId` for a button without a group). `ok: false` with `error` (timeout / network / relay_error / invalid_answer /
 * url_not_allowed / secret_missing) and the relay's `message`. Also `actions.status_updated`'s data.
 */
@Serializable
data class ActionStatusOut(
    val actionId: String,
    val groupLabel: String? = null,
    val ok: Boolean,
    val status: ActionStatusValue? = null,
    val error: String? = null,
    val message: String? = null,
    val fetchedAt: String,
)

/** §12.3: GET /actions/status (`enabled: false` while off; empty for guests). */
@Serializable
data class ActionStatusListOut(
    val enabled: Boolean,
    val statuses: List<ActionStatusOut> = emptyList(),
)
