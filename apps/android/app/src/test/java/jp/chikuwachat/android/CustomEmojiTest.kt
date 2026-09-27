package jp.chikuwachat.android

import jp.chikuwachat.android.ui.CustomEmoji
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CustomEmojiTest {
    private val known = setOf("party_parrot", "ok")

    @Test fun exactNamesAndSplitting() {
        assertEquals("party_parrot", CustomEmoji.name(":party_parrot:"))
        assertNull(CustomEmoji.name(":party parrot:"))
        assertNull(CustomEmoji.name("🎉"))
        assertEquals(
            listOf(CustomEmoji.Piece.Text("done "), CustomEmoji.Piece.Emoji("ok"), CustomEmoji.Piece.Text(" and "), CustomEmoji.Piece.Emoji("party_parrot"), CustomEmoji.Piece.Text("!")),
            CustomEmoji.split("done :ok: and :party_parrot:!") { it in known },
        )
        assertEquals(listOf(CustomEmoji.Piece.Text("plain :unknown: text")), CustomEmoji.split("plain :unknown: text") { it in known })
        assertEquals(listOf(CustomEmoji.Piece.Text("no colons")), CustomEmoji.split("no colons") { it in known })
    }
}
