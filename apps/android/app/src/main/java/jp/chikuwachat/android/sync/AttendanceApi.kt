package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.AttendanceBoardOut

/** M140 (docs/PRESENCE.md §3.1): the 在室状況 board (ApiClient and the test fake). */
interface AttendanceApi {
    suspend fun attendance(): AttendanceBoardOut
}
