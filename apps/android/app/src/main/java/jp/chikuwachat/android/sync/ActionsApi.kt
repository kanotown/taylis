package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ActionInvokeOut
import jp.chikuwachat.android.api.ActionListOut

/** M143 (docs/ACTIONS.md §7.1): the 操作ボタン I may press, and a press (ApiClient and the test fake). */
interface ActionsApi {
    suspend fun actions(): ActionListOut

    /** One press: the server calls the relay once; the same [clientInvokeId] again answers the first result. */
    suspend fun invokeAction(actionId: String, clientInvokeId: String): ActionInvokeOut
}
