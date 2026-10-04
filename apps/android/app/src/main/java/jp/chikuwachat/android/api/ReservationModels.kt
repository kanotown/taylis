package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

/** M99 (docs/RESERVATIONS.md §3): one member's request in a pool, as the server shows it to me. */
@Serializable
data class ReservationOut(
    val id: String,
    val userId: String,
    /** waiting / holding / returning */
    val status: String,
    val requestedAt: String,
    val assignedAt: String? = null,
    val guaranteeUntil: String? = null,
    val returnedAt: String? = null,
    /** A holder past the guarantee whom a waiting member needs: when the grace period ends. */
    val evictAt: String? = null,
    /** Only for those who can operate the pool. */
    val email: String? = null,
    val position: Int? = null,
    /** A waiting member: assign (a seat is free) / swap (takes pairId's seat) / wait. */
    val step: String? = null,
    val pairId: String? = null,
    val ready: Boolean = false,
)

/** M99: a channel's reservation pool (shared, limited seats with a queue). */
@Serializable
data class PoolOut(
    val id: String,
    val channelId: String,
    val name: String,
    val capacity: Int,
    val minHours: Int,
    val graceMinutes: Int,
    val tz: String,
    val enabled: Boolean,
    val operatorIds: List<String> = emptyList(),
    val botUserId: String? = null,
    val holders: List<ReservationOut> = emptyList(),
    val waiting: List<ReservationOut> = emptyList(),
    val nextEvictId: String? = null,
    val myReservationId: String? = null,
    val canManage: Boolean = false,
    val canOperate: Boolean = false,
    val createdAt: String,
    val updatedAt: String,
)
