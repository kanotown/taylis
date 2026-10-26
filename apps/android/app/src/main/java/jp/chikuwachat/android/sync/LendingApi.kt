package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.LendingLoanOut
import jp.chikuwachat.android.api.LendingSettingsOut
import jp.chikuwachat.android.api.LendingSummaryOut

/**
 * M172 (docs/LENDING.md §9): what the engine reads again after `lending.updated` for the 「備品」 tile's numbers — the
 * settings (on / off, keeper) and the loans (ApiClient and the test fake).
 */
interface LendingApi {
    suspend fun lendingSettings(): LendingSettingsOut

    /** `scope`: mine (the default) / active / overdue (keepers) / approved (the teacher named). */
    suspend fun lendingLoans(scope: String): List<LendingLoanOut>
}

/**
 * M172: the bootstrap's `lending` numbers worked out again from the settings and the loans (the server has no call for
 * them alone; §5.1): `mine` = scope=mine, `active` = scope=active (keepers only, else null). The keepers' number counts
 * the same loans as their morning summary (§17.2): at least keeper_overdue_days past due, or the borrower deactivated.
 */
object LendingSummary {
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
