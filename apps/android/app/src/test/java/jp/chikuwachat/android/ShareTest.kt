package jp.chikuwachat.android

import jp.chikuwachat.android.ui.Share
import org.junit.Assert.assertEquals
import org.junit.Test

class ShareTest {
    private val link = "https://chat.example.com/m/01a0df3f-14b2-7d1a-8759-53c8a8d8a198"

    @Test fun quotesTheOriginalUnderTheCommentAndEndsWithThePermalink() {
        assertEquals("見てください\n> first line\n> second\n$link", Share.body("first line\nsecond", link, "見てください"))
        assertEquals("> plain\n$link", Share.body("plain", link, ""))
    }

    @Test fun clipsLongBodiesAndStandsInForAttachmentOnlyMessages() {
        val long = "あ".repeat(400)
        assertEquals("> " + "あ".repeat(300) + "…\n$link", Share.body(long, link, ""))
        assertEquals("資料です\n> (添付ファイル)\n$link", Share.body("   ", link, "資料です"))
    }
}
