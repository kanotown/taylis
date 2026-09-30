package jp.chikuwachat.android

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.attachmentSummary
import jp.chikuwachat.android.ui.messageLine
import org.junit.Assert.assertEquals
import org.junit.Test

/** The one line of a message with no text but attachments (the same rule on desktop, iOS and the server). */
class AttachmentSummaryTest {
    @Test fun imagesVideosAndOtherFilesAreCountedWithTheirOwnCounter() {
        assertEquals("", attachmentSummary(emptyList()))
        assertEquals("画像を送信しました", attachmentSummary(listOf("image/png")))
        assertEquals("画像を 3 枚送信しました", attachmentSummary(listOf("image/png", "image/jpeg", "image/heic")))
        assertEquals("動画を送信しました", attachmentSummary(listOf("video/mp4")))
        assertEquals("動画を 2 本送信しました", attachmentSummary(listOf("video/mp4", "video/quicktime")))
        assertEquals("ファイルを送信しました", attachmentSummary(listOf("application/pdf")))
        assertEquals("ファイルを 4 件送信しました", attachmentSummary(listOf("text/plain", "application/zip", "audio/mpeg", "application/pdf")))
    }

    @Test fun aMixOfKindsIsFiles() {
        assertEquals("ファイルを 2 件送信しました", attachmentSummary(listOf("image/png", "video/mp4")))
        assertEquals("ファイルを 2 件送信しました", attachmentSummary(listOf("image/png", "application/pdf")))
        // Only the type's own prefix counts: "image" without the slash, or a suffix, is not an image.
        assertEquals("ファイルを送信しました", attachmentSummary(listOf("application/x-image")))
    }

    @Test fun textWinsOverTheSummary() {
        val store = Store()
        val photo = AttachmentOut(id = "a1", filename = "p.png", contentType = "image/png", sizeBytes = 10)
        val clip = AttachmentOut(id = "a2", filename = "c.mp4", contentType = "video/mp4", sizeBytes = 10)
        assertEquals("見て", messageLine("見て", listOf(photo), store))
        assertEquals("画像を 2 枚送信しました", messageLine("", listOf(photo, photo.copy(id = "a3")), store))
        assertEquals("ファイルを 2 件送信しました", messageLine("  \n ", listOf(photo, clip), store))
        assertEquals("", messageLine("", emptyList(), store))
    }
}
