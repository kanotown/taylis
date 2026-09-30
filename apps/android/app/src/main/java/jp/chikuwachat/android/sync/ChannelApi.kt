package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ChannelOut

/** M49: one channel as its member sees it (GET /channels/{id}, with `last_message`); ApiClient and the test fake. */
interface ChannelApi {
    suspend fun channel(id: String): ChannelOut
}
