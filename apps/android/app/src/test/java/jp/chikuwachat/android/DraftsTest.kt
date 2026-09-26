package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.introSummary
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId

/** M11h: the drafts list and the channel intro text are pure store reads. */
class DraftsTest {
    @Test fun listDraftsSkipsEmptyOnes() {
        val store = Store()
        store.setDraft("c1") { it.copy(text = "hello") }
        store.setDraft("c1", "m1") { it.copy(text = "a reply") }
        store.setDraft("c2") { it.copy(text = "   ") }
        assertEquals(listOf("c1:-:hello", "c1:m1:a reply"), store.listDrafts().map { "${it.channelId}:${it.parentId ?: "-"}:${it.draft.text}" })
        store.setDraft("c1") { it.copy(text = "") }
        assertEquals(listOf("m1"), store.listDrafts().map { it.parentId })
    }

    @Test fun introSummaryNamesCreatorDateTypeAndCount() {
        val store = Store()
        store.upsertUser(UserPublic(id = "u2", username = "toru", displayName = "Toru", role = "member", deactivatedAt = null, createdAt = "", updatedAt = ""))
        val ops = ChannelOut(id = "c3", type = "private", name = "ops", archived = false, createdBy = "u2", lastSeq = 0,
                             createdAt = "2026-09-27T01:00:00+00:00", updatedAt = "", memberCount = 3)
        val summary = introSummary(ChannelState(ops, isMember = true), store, zone = ZoneId.of("Asia/Tokyo"))
        assertEquals("Toru が2026年9月27日に作成した非公開チャンネルの始まりです。 メンバー 3 人。", summary)
        val unknown = ChannelOut(id = "c4", type = "public", name = "random", archived = false, lastSeq = 0, createdAt = "", updatedAt = "")
        assertEquals("作成した公開チャンネルの始まりです。", introSummary(ChannelState(unknown, isMember = true), store))
    }
}
