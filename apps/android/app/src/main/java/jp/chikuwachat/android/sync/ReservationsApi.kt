package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.PoolOut

/** M112: the workspace's reservation pools (ApiClient and the test fake). */
interface ReservationsApi {
    suspend fun reservationPools(): List<PoolOut>
}
