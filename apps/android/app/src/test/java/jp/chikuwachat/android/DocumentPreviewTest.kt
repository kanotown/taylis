package jp.chikuwachat.android

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.DocumentCards
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M108 (docs/PREVIEWS.md §5): document cards from the server's preview; older servers keep the plain row. */
class DocumentPreviewTest {
    private val head = """{"id":"d","filename":"議事録.docx","content_type":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","size_bytes":2048,"width":null,"height":null,"has_thumbnail":false,"status":"attached","created_at":"2026-10-05T00:00:00Z""""

    private fun decode(tail: String): AttachmentOut = Codec.snake.decodeFromString(AttachmentOut.serializer(), "$head$tail}")

    @Test fun anOldServersAttachmentHasNoPreviewAndKeepsThePlainRow() {
        val old = decode("")
        assertNull(old.preview)
        assertFalse(DocumentCards.showsCard(old))
        assertNull(DocumentCards.thumbHeight(old.preview))
        assertFalse(DocumentCards.showsCard(decode(""","preview":null""")))
        val failed = decode(""","preview":{"status":"failed","pages":null,"width":null,"height":null}""")
        assertFalse(DocumentCards.showsCard(failed))
        assertEquals("2 KB", DocumentCards.detail(failed))
    }

    @Test fun aPendingPreviewSaysItIsBeingMade() {
        val pending = decode(""","preview":{"status":"pending","pages":null,"width":null,"height":null}""")
        assertTrue(DocumentCards.showsCard(pending))
        assertNull(DocumentCards.thumbHeight(pending.preview)) // no box until it is ready
        assertEquals("プレビューを作成中…", DocumentCards.detail(pending))
    }

    @Test fun aReadyPreviewHasItsBoxFromTheServersNumbers() {
        val page = decode(""","preview":{"status":"ready","pages":3,"width":800,"height":1132}""")
        assertTrue(DocumentCards.showsCard(page))
        assertEquals(DocumentCards.MAX_THUMB_HEIGHT, DocumentCards.thumbHeight(page.preview)) // a portrait page: its top
        assertEquals("2 KB · 3 ページ", DocumentCards.detail(page))
        val slide = decode(""","preview":{"status":"ready","pages":1,"width":800,"height":450}""")
        assertEquals(146, DocumentCards.thumbHeight(slide.preview)) // 260 × 450 / 800, whole
        // The message cache stores attachments as JSON: the preview survives the round trip.
        val stored = Codec.plain.encodeToString(AttachmentOut.serializer(), slide)
        assertEquals(slide, Codec.plain.decodeFromString(AttachmentOut.serializer(), stored))
    }

    @Test fun thePreviewPdfIsCachedInTheAttachmentsOwnFolder() {
        assertEquals("d/preview.pdf", DocumentCards.cachePath("d"))
        assertEquals("_x_/preview.pdf", DocumentCards.cachePath("/x/"))
    }
}
