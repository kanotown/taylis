package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

/**
 * M140 (docs/PRESENCE.md §3.1): one 「在室状況」 state. `ownerId` null = the workspace's (everyone's buttons), else the person
 * whose own state it is (their buttons, their row on the board). `kind`: in_room / on_site / off_site / gone; `color`: a
 * key of apps/shared/text-emoji.json. `archived`: deleted but someone still has it (shown on the board, never offered).
 */
@Serializable
data class AttendanceStateOut(
    val id: String,
    val ownerId: String? = null,
    val label: String,
    /** M140 §2.1 (migration 0101): a key of apps/shared/attendance-icons.json (ui/AttendanceIcons); null or unknown = the emoji. */
    val icon: String? = null,
    val emoji: String? = null,
    val color: String = "gray",
    val kind: String,
    val position: Int = 0,
    val archived: Boolean = false,
)

/** M140: one person's current state (the board's row; also `attendance.updated`'s data and PUT /attendance/me's answer). */
@Serializable
data class AttendanceEntryOut(
    val userId: String,
    val stateId: String,
    /** When this state began (a note-only change keeps it). */
    val since: String,
    val note: String? = null,
    /** app / admin / integration / auto */
    val source: String = "app",
)

/**
 * M140: GET /attendance and bootstrap's `attendance` (null there for guests, while off, and from a server before M140).
 * `entries` holds only the people who have a state; `canPersonalize`: I may add my own states.
 */
@Serializable
data class AttendanceBoardOut(
    val enabled: Boolean,
    val states: List<AttendanceStateOut> = emptyList(),
    val entries: List<AttendanceEntryOut> = emptyList(),
    val canPersonalize: Boolean = false,
)
