package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.ui.PreviewJoin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The preview of a channel I have not joined (M27): an archived one offers no 「参加する」 (the server answers 409). */
class PreviewJoinTest {
    private fun channel(archived: Boolean) =
        ChannelOut(id = "c", type = "public", name = "times-alice", archived = archived, lastSeq = 0, createdAt = "", updatedAt = "")

    @Test fun anOpenChannelOffersJoining() {
        assertTrue(PreviewJoin.canJoin(channel(archived = false)))
    }

    @Test fun anArchivedChannelShowsANoteInstead() {
        assertFalse(PreviewJoin.canJoin(channel(archived = true)))
        assertEquals("アーカイブされたチャンネルです（読むだけ）", PreviewJoin.ARCHIVED_NOTE)
    }
}
