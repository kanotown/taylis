package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.PoolOut

/** M99: a channel's reservation pools (ApiClient and the test fake). */
interface ReservationsApi {
    suspend fun reservationPools(channelId: String): List<PoolOut>
}
