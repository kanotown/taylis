package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

/**
 * M99, M112 (docs/RESERVATIONS.md §3): one member's request in a pool — a booking (kind "booking": a slot of whole hours)
 * or a walk-in (kind "walkin": the 「今すぐ」 queue) — as the server shows it to me.
 */
@Serializable
data class ReservationOut(
    val id: String,
    val userId: String,
    /** walkin / booking */
    val kind: String = "walkin",
    /** waiting / booked / holding / returning / done */
    val status: String,
    val requestedAt: String,
    /** A booking's slot. */
    val startAt: String? = null,
    val endAt: String? = null,
    val assignedAt: String? = null,
    val guaranteeUntil: String? = null,
    val returnedAt: String? = null,
    /** A walk-in someone needs: when its seat goes (it was told). */
    val evictAt: String? = null,
    /** Only for those who can operate the pool. */
    val email: String? = null,
    val position: Int? = null,
    /** A waiting walk-in or a started booking: assign (a seat is free) / swap (takes pairId's seat) / wait. */
    val step: String? = null,
    val pairId: String? = null,
    val ready: Boolean = false,
    /** A waiting walk-in with a free seat: a booking needs it from then (「〜13:00 まで」). */
    val until: String? = null,
    /** My booking can grow by an hour. */
    val canExtend: Boolean = false,
)

/** M112: something an operator does in the resource's own console, then presses here. */
@Serializable
data class ReservationTodo(
    val key: String,
    /** assign / swap / remove */
    val action: String,
    /** free / returned / booking_ended / guarantee_over */
    val reason: String,
    val assignId: String? = null,
    val removeId: String? = null,
    val dueAt: String,
    /** A booking starting within 10 minutes: not yet. */
    val upcoming: Boolean = false,
)

/** M112: a reservation pool of the workspace (shared, limited seats booked by the hour or queued for). */
@Serializable
data class PoolOut(
    val id: String,
    val name: String,
    val capacity: Int,
    val minHours: Int = 6,
    val maxHours: Int = 6,
    val graceMinutes: Int = 15,
    val tz: String = "Asia/Tokyo",
    val enabled: Boolean = true,
    val operatorIds: List<String> = emptyList(),
    val logChannelId: String? = null,
    val visibility: String = "all",
    val visibilityChannelId: String? = null,
    val visibilityGroupId: String? = null,
    val holders: List<ReservationOut> = emptyList(),
    val waiting: List<ReservationOut> = emptyList(),
    val bookings: List<ReservationOut> = emptyList(),
    val todos: List<ReservationTodo> = emptyList(),
    val nextEvictId: String? = null,
    val myReservationId: String? = null,
    /** The caller's one active reservation in the pool (waiting, booked, on a seat, returned but not yet removed). */
    val myActiveId: String? = null,
    val canManage: Boolean = false,
    val canOperate: Boolean = false,
    val horizonDays: Int = 14,
    val createdAt: String = "",
    val updatedAt: String = "",
)

/** M112: `reservation.notice` — a new activity item about reservations for me (the push's words while the app is open). */
@Serializable
data class ReservationNotice(
    val itemId: String,
    val poolId: String,
    val reservationId: String? = null,
    val text: String,
    val operator: Boolean = false,
    val at: String,
)

/** M112: a reservation item's notice (activity kind `reservation`); it opens 「予約」. */
@Serializable
data class ActivityReservation(
    val itemId: String,
    val poolId: String,
    val poolName: String = "",
    val reservationId: String? = null,
    val text: String = "",
    val operator: Boolean = false,
    val done: Boolean = false,
    val doneAt: String? = null,
    val doneBy: String? = null,
)
