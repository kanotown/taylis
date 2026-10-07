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
