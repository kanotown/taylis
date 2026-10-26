package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.LendingLoanOut
import jp.chikuwachat.android.api.LendingSettingsOut
import jp.chikuwachat.android.api.LendingSummaryOut

/**
 * M172 (docs/LENDING.md §9): what the engine reads again after `lending.updated` / `lending.notice` for the 「備品」
 * tile's numbers — M173: GET /lending/summary; on a server before M173 the settings (on / off, keeper) and the loans
 * (ApiClient and the test fake).
 */
interface LendingApi {
    suspend fun lendingSettings(): LendingSettingsOut

    /**
     * M173 (§5.1, §17.8): the bootstrap's `lending` on its own; null where the bootstrap has null (409 lending_disabled,
     * 403 guest_restricted). A server before M173 throws 404 not_found ([LendingSummary.isMissingRoute]).
     */
    suspend fun lendingSummary(): LendingSummaryOut?

    /** `scope`: mine (the default) / active / overdue (keepers) / approved (the teacher named). */
    suspend fun lendingLoans(scope: String): List<LendingLoanOut>
}

/**
 * M172: the bootstrap's `lending` numbers worked out again from the settings and the loans — since M173 only for a
 * server without GET /lending/summary (§5.1, §17.8): `mine` = scope=mine, `active` = scope=active (keepers only, else null). The keepers' number counts
 * the same loans as their morning summary (§17.2): at least keeper_overdue_days past due, or the borrower deactivated.
 */
object LendingSummary {
    /** M173: a route this server does not have (404 not_found, or 405): GET /lending/summary before M173. */
    fun isMissingRoute(e: Throwable): Boolean =
        e is ApiException.Api && ((e.status == 404 && (e.code == "not_found" || e.code == "http_404")) || e.status == 405)

    fun of(settings: LendingSettingsOut, mine: List<LendingLoanOut>, active: List<LendingLoanOut>?, deactivated: (String) -> Boolean): LendingSummaryOut? {
        if (!settings.enabled) return null
        val myActive = mine.filter { it.status == "active" }
        val attention = if (settings.isKeeper) {
            (active ?: emptyList()).count { it.status == "active" && (it.overdueDays >= settings.keeperOverdueDays || deactivated(it.borrowerId)) }
        } else 0
        return LendingSummaryOut(
            enabled = true,
            isKeeper = settings.isKeeper,
            myActiveCount = myActive.size,
            myOverdueCount = myActive.count { it.overdueDays > 0 },
            keeperAttentionCount = attention,
            settingsUpdatedAt = settings.updatedAt,
        )
    }
}
