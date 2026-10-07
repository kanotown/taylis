package jp.chikuwachat.android.ui

import java.util.UUID
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ActionInvokeOut
import jp.chikuwachat.android.api.ActionListOut
import jp.chikuwachat.android.api.ActionOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ErrorTexts
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/**
 * M143 (docs/ACTIONS.md §9): the rules of the 操作ボタン apart from how they look (the desktop's ui/actions.ts). A press
 * calls the relay once through the server; only a network failure (no answer from our server) is sent again, with the
 * same `client_invoke_id`, so the server answers with the first result and never calls the relay twice.
 */
object ActionRules {
    /** A group of buttons; [label] null for the buttons without one (drawn last). */
    data class Group(val label: String?, val actions: List<ActionOut>)

    /** The buttons in the administrator's order, grouped by `group_label` (a group where its first button is; ungrouped last). */
    fun groups(actions: List<ActionOut>): List<Group> {
        val grouped = LinkedHashMap<String, MutableList<ActionOut>>()
        val loose = mutableListOf<ActionOut>()
        for (action in actions.sortedBy { it.position }) {
            val label = action.groupLabel?.trim()
            if (label.isNullOrEmpty()) loose += action else grouped.getOrPut(label) { mutableListOf() } += action
        }
        val out = grouped.map { (label, list) -> Group(label, list) }
        return if (loose.isEmpty()) out else out + Group(null, loose)
    }

    /** 「研究室の鍵：開ける」, or the name alone. */
    fun title(action: ActionOut): String =
        action.groupLabel?.trim()?.takeIf { it.isNotEmpty() }?.let { L10n.str(R.string.actions_title, it, action.name) } ?: action.name

    /** The confirmation's sentence: the administrator's, else 「研究室の鍵：開ける を実行しますか？」. */
    fun confirmText(action: ActionOut): String =
        action.confirmText?.trim()?.takeIf { it.isNotEmpty() } ?: L10n.str(R.string.actions_confirm, title(action))

    /** The buttons to draw (none while off, for guests, or when I may press nothing). */
    fun pressable(list: ActionListOut?, myRole: String? = null): List<ActionOut> =
        if (list != null && list.enabled && myRole != "guest") list.actions else emptyList()

    /** The home tile and the page: only while the buttons are on and I may press at least one. */
    fun shown(list: ActionListOut?, myRole: String?): Boolean = pressable(list, myRole).isNotEmpty()

    /** On top of 在室状況 and in its quick-switch sheet too, when the workspace says so (`show_on_attendance`). */
    fun onAttendance(list: ActionListOut?, myRole: String?): List<ActionOut> =
        if (list?.showOnAttendance == true) pressable(list, myRole) else emptyList()

    data class Result(val ok: Boolean, val text: String)

    /** What to say after a press: the relay's message if it gave one, else a sentence for the outcome. */
    fun resultText(out: ActionInvokeOut, action: ActionOut): Result {
        if (out.ok) return Result(true, out.message?.takeIf { it.isNotBlank() } ?: L10n.str(R.string.actions_done, title(action)))
        out.message?.takeIf { it.isNotBlank() }?.let { return Result(false, it) }
        val text = when (out.error) {
            "timeout" -> L10n.str(R.string.actions_error_timeout)
            "network" -> L10n.str(R.string.actions_error_unreachable)
            "interrupted" -> L10n.str(R.string.actions_error_interrupted)
            "secret_missing", "url_not_allowed" -> L10n.str(R.string.actions_error_setup)
            "relay_error" -> L10n.str(R.string.actions_error_relay, out.statusCode?.toString() ?: "?")
            else -> if (out.status == "pending") L10n.str(R.string.actions_error_pending) else L10n.str(R.string.actions_error_failed)
        }
        return Result(false, text)
    }

    /** The text for a press the server refused (429, permission, off) or that could not reach the server. */
    fun refusalText(error: Throwable): String = when (error) {
        is ApiException.Api -> if (error.status == 429) L10n.str(R.string.actions_error_too_fast)
            else ErrorTexts.code(error.code) ?: ErrorTexts.status(error.status) ?: ErrorTexts.unknown
        is ApiException.Network -> ErrorTexts.network
        else -> ErrorTexts.unknown
    }

    /** All the tries of one press: the first and up to two network retries. */
    const val ATTEMPTS = 3

    /**
     * One press: the server calls the relay once. A network failure is sent again with the same id, up to [attempts]
     * times in all (waiting 1 s, then 2 s); any answer of the server (an error too) ends it.
     */
    suspend fun invokeOnce(
        actionId: String,
        invoke: suspend (actionId: String, clientInvokeId: String) -> ActionInvokeOut,
        attempts: Int = ATTEMPTS,
        id: String = UUID.randomUUID().toString(),
        wait: suspend (Long) -> Unit = { delay(it) },
    ): ActionInvokeOut {
        var attempt = 1
        while (true) {
            try {
                return invoke(actionId, id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Network) {
                if (attempt >= attempts) throw e
                wait(1000L * attempt)
                attempt += 1
            }
        }
    }
}
