package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

/*
 * M172 (docs/LENDING.md §5, L6): 「備品」 — the equipment ledger, loans and notices as the server shows them to me. States,
 * scopes and roles are plain strings: a value this app does not know never fails the decode (LendingRules shows it as
 * 「（不明）」 or leaves it out). The phones never edit the ledger (§12.3).
 */

/** GET /lending/settings: readable by every person (also while off); guests get 403 guest_restricted. */
@Serializable
data class LendingSettingsOut(
    val enabled: Boolean = false,
    val keeperIds: List<String> = emptyList(),
    val defaultMaxDays: Int = 14,
    val maxExtensions: Int = 2,
    val keeperOverdueDays: Int = 3,
    val noticeMinute: Int = 540,
    /** The zone of the due dates (a loan is due by the end of `due_on` there, §8.1). */
    val tz: String = "Asia/Tokyo",
    val isKeeper: Boolean = false,
    val updatedAt: String? = null,
)

/** The bootstrap's `lending` (null for guests, while the feature is off and from a server before M167): the tile's numbers. */
@Serializable
data class LendingSummaryOut(
    val enabled: Boolean = true,
    val isKeeper: Boolean = false,
    val myActiveCount: Int = 0,
    val myOverdueCount: Int = 0,
    /** Keepers only (0 for others): loans keeper_overdue_days or more past due, and loans of deactivated people. */
    val keeperAttentionCount: Int = 0,
    val settingsUpdatedAt: String? = null,
)

/** GET /lending/categories. */
@Serializable
data class LendingCategoryOut(
    val id: String,
    val name: String,
    val position: Int = 0,
    val requiresPermission: Boolean = false,
    val maxDays: Int? = null,
    val itemCount: Int = 0,
)

/** An item's `loan` and `recent_loans`: who has (had) it and until when. No purpose; `permission_state` only for those who see the details. */
@Serializable
data class LendingLoanBriefOut(
    val id: String,
    val borrowerId: String,
    val borrowedAt: String = "",
    /** "2026-10-30" in the workspace's zone. */
    val dueOn: String,
    val overdueDays: Int = 0,
    val permissionState: String? = null,
    /** active / returned */
    val status: String = "active",
    val returnedAt: String? = null,
    /** ok / issue (the 🔧 mark is shown to everyone) */
    val returnCondition: String? = null,
)

/**
 * GET /lending/items (a list) and GET /lending/items/{id} (LendingItemDetailOut: also [recentLoans] and [watcherCount],
 * left at their defaults in the list).
 */
@Serializable
data class LendingItemOut(
    val id: String,
    val name: String,
    val categoryId: String? = null,
    val code: String? = null,
    val location: String? = null,
    val notes: String? = null,
    val photo: AttachmentOut? = null,
    /** available / on_loan / in_repair / retired */
    val status: String = "available",
    val statusNote: String? = null,
    /** In effect (item → category → false). */
    val requiresPermission: Boolean = false,
    /** In effect (item → category → settings): the latest due date is today + this. */
    val maxDays: Int = 14,
    val loan: LendingLoanBriefOut? = null,
    val watching: Boolean = false,
    val createdAt: String = "",
    val updatedAt: String = "",
    val recentLoans: List<LendingLoanBriefOut> = emptyList(),
    /** How many people wait to be told it is back (the extend dialog's 「待っている人がいます」). */
    val watcherCount: Int = 0,
)

/**
 * A loan (OpenAPI LendingLoanOut). [purpose], [approverId], the permission's state, time and note and [returnNote] are
 * null for anyone but the borrower, the teacher named, the keepers and the administrators ([detailsHidden]).
 */
@Serializable
data class LendingLoanOut(
    val id: String,
    val itemId: String,
    val itemName: String = "",
    val itemCode: String? = null,
    val borrowerId: String,
    /** active / returned */
    val status: String = "active",
    val borrowedAt: String = "",
    val dueOn: String,
    val originalDueOn: String? = null,
    val overdueDays: Int = 0,
    val extensionCount: Int = 0,
    /** Whether I may extend it now (the borrower within the limits, or a keeper). */
    val canExtend: Boolean = false,
    /** The latest date the borrower may extend to (today + the item's max_days). */
    val latestDueOn: String? = null,
    val purpose: String? = null,
    val permissionRequired: Boolean = false,
    val approverId: String? = null,
    /** claimed / confirmed / denied (null when not required, or hidden) */
    val permissionState: String? = null,
    val permissionDecidedAt: String? = null,
    val permissionNote: String? = null,
    val returnedAt: String? = null,
    val returnedBy: String? = null,
    val returnCondition: String? = null,
    val returnNote: String? = null,
    val detailsHidden: Boolean = false,
)

/** GET /lending/approvers: the teachers I may name (§6.4); my supervisor first when a candidate; `self_approved` = I need none. */
@Serializable
data class LendingApproversOut(
    val userIds: List<String> = emptyList(),
    val suggestedIds: List<String> = emptyList(),
    val selfApproved: Boolean = false,
)

/** `lending.notice` (user): a new activity item of kind lending for me — the push's words while the app is open. */
@Serializable
data class LendingNotice(
    val itemId: String,
    val lendingItemId: String? = null,
    val loanId: String? = null,
    /** borrower / approver / keeper / watcher */
    val role: String = "borrower",
    val text: String,
    val at: String = "",
)

/**
 * M169: an activity item of kind `lending` (asked for with `include=lending`). It opens the loan, else the item, else
 * (the keepers' morning summary) the overdue list. The teacher's to-do (`role = approver`) is [done] once decided.
 */
@Serializable
data class ActivityLending(
    val itemId: String,
    val lendingItemId: String? = null,
    val loanId: String? = null,
    val itemName: String? = null,
    val role: String = "borrower",
    val text: String = "",
    val done: Boolean = false,
    val doneAt: String? = null,
    val doneBy: String? = null,
)
