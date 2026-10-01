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

    /** 2026-10-02: a custom emoji in a status showed as its `:name:`; the status views draw the one that exists as its image. */
    @Test fun aStatusEmojiFindsItsCustomEmoji() {
        val custom = mapOf("party_parrot" to "image-1")
        assertEquals("image-1", CustomEmoji.of(":party_parrot:", custom))
        assertEquals("image-1", CustomEmoji.of(" :party_parrot: ", custom))
        assertNull(CustomEmoji.of("🎉", custom))
        assertNull(CustomEmoji.of(":gone:", custom))
        assertNull(CustomEmoji.of(":party_parrot: 会議中", custom))
        assertNull(CustomEmoji.of(":party_parrot:", emptyMap<String, String>()))
        // The DM header and the directory join the status into a line: the custom emoji is a piece of its own there.
        assertEquals(
            listOf(CustomEmoji.Piece.Text("オンライン · "), CustomEmoji.Piece.Emoji("party_parrot"), CustomEmoji.Piece.Text(" 会議中")),
            CustomEmoji.split("オンライン · :party_parrot: 会議中") { it in custom },
        )
    }
}
