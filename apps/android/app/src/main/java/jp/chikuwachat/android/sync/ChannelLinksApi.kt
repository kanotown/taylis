package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ChannelLinkOut

/** M15f: a conversation's link bar (ApiClient and the test fake). */
interface ChannelLinksApi {
    suspend fun channelLinks(channelId: String): List<ChannelLinkOut>
}
