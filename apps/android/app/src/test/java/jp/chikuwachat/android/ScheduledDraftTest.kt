package jp.chikuwachat.android

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.Draft
import jp.chikuwachat.android.ui.restoreScheduledDraft
import org.junit.Assert.assertEquals
import org.junit.Test

class ScheduledDraftTest {
    @Test fun preservesCurrentTextAttachmentsAndMetadataAndRestoresEditableMentions() {
        val user = UserPublic("00000000-0000-7000-8000-000000000001", "yamada", "山田", "member", null, "", "")
        val group = GroupOut("00000000-0000-7000-8000-000000000002", "lab", "研究室", listOf(user.id), user.id, "", "")
        val attachment = AttachmentOut("file", "notes.txt", "text/plain", 20)
        val draft = Draft("書きかけ", listOf(attachment), dirty = true, syncedAt = "saved-version")
        val restored = restoreScheduledDraft(draft, "<@${user.id}> <@group:${group.id}> <!channel>", mapOf(user.id to user), mapOf(group.id to group))
        assertEquals(draft.copy(text = "書きかけ\n@yamada @lab @channel"), restored)
    }

    @Test fun handlesEmptyDraftTrailingNewlineAndAttachmentOnlyReservation() {
        fun restore(current: String, body: String = "予約文") = restoreScheduledDraft(Draft(current), body, emptyMap(), emptyMap()).text
        assertEquals("予約文", restore("  \n"))
        assertEquals("書きかけ\n予約文", restore("書きかけ\n"))
        assertEquals("書きかけ", restore("書きかけ", ""))
    }
}
