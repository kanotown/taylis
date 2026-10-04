package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.EmojiPackOut
import jp.chikuwachat.android.ui.CustomEmoji
import jp.chikuwachat.android.ui.Emoji
import jp.chikuwachat.android.ui.EmojiPicker
import jp.chikuwachat.android.ui.TextEmojiPill
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

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

    // --- M100 (docs/EMOJI.md) -------------------------------------------------------------------

    private fun emoji(name: String, w: Int = 180, h: Int = 180, label: String? = null, keywords: List<String> = emptyList(), packId: String? = null, position: Int = 0) =
        CustomEmojiOut(name, name, "image/png", w, h, "u", "", label = label, keywords = keywords, packId = packId, position = position)

    @Test fun wideEmojiKeepTheirShapeUpToThreeToOne() {
        assertEquals(1.5f, CustomEmoji.aspect(emoji("a", 96, 64)), 0.001f)
        assertEquals(3f, CustomEmoji.aspect(emoji("b", 400, 50)), 0.001f)
        assertEquals(1f, CustomEmoji.aspect(emoji("c", 32, 64)), 0.001f) // a tall one in a square box
    }

    @Test fun textEmojiDecodeAndAreAsWideAsTheirLabel() {
        val text = Codec.snake.decodeFromString(
            CustomEmojiOut.serializer(),
            """{"id":"t1","name":"kakunin","kind":"text","label":"確認しました","color":"green","content_type":"","width":0,"height":0,"keywords":["了解"],"pack_id":null,"position":0,"created_by":"u","created_at":""}""",
        )
        assertTrue(text.isText)
        assertEquals(listOf("了解"), text.keywords)
        assertEquals(6 * 0.68f + 0.56f, CustomEmoji.aspect(text), 0.001f)
        val old = Codec.snake.decodeFromString(CustomEmojiOut.serializer(), """{"id":"e","name":"e","content_type":"image/png","width":1,"height":1,"created_by":"u","created_at":""}""")
        assertFalse(old.isText)
        assertEquals(1f, TextEmojiPill.aspect("o"), 0.001f) // never narrower than square
    }

    @Test fun textPaletteIsTheSharedOne() {
        val file = File("../../shared/text-emoji.json")
        val shared = Codec.snake.parseToJsonElement(file.readText()).jsonObject
        val colors = shared.getValue("colors").jsonObject
        assertEquals(colors.keys.toList(), TextEmojiPill.PALETTE.keys.toList())
        fun hex(value: Long) = "#%06X".format(value)
        for ((key, pair) in TextEmojiPill.PALETTE) {
            val c = colors.getValue(key).jsonObject
            assertEquals(c.getValue("light").jsonObject.getValue("bg").jsonPrimitive.content, hex(pair.first.first))
            assertEquals(c.getValue("light").jsonObject.getValue("fg").jsonPrimitive.content, hex(pair.first.second))
            assertEquals(c.getValue("dark").jsonObject.getValue("bg").jsonPrimitive.content, hex(pair.second.first))
            assertEquals(c.getValue("dark").jsonObject.getValue("fg").jsonPrimitive.content, hex(pair.second.second))
        }
        assertEquals(shared.getValue("label_max").jsonPrimitive.content.toInt(), TextEmojiPill.LABEL_MAX)
    }

    @Test fun customEmojiAreFoundByLabelAndKeywords() {
        val bow = emoji("hpd-bow", label = "おじぎ", keywords = listOf("ありがとう", "ぺこり"))
        val parrot = emoji("parrot")
        assertEquals(listOf("hpd-bow"), CustomEmoji.candidates("ありがとう", listOf(parrot, bow)).map { it.name })
        assertEquals(listOf("hpd-bow"), CustomEmoji.candidates("アリガトウ", listOf(parrot, bow)).map { it.name })
        assertEquals(listOf("parrot"), CustomEmoji.candidates("par", listOf(parrot, bow)).map { it.name })
        assertEquals("ありがとう", Emoji.query("どうも :ありがとう"))
        assertEquals("了解", Emoji.query("：了解"))
        assertNull(Emoji.query("例：説明"))
        assertNull(Emoji.query("hello :t"))
        assertEquals(":hpd-bow:", EmojiPicker.search("ぺこり", listOf(parrot, bow)).first())
    }

    @Test fun packsGetTheirOwnSectionsAndCustomKeepsTheUngrouped() {
        val pack = EmojiPackOut("p1", "ドットはんぺん", position = 0)
        val custom = listOf(emoji("hpd-bow", packId = "p1", position = 1), emoji("hpd-plain", packId = "p1", position = 0), emoji("parrot"), emoji("lost", packId = "gone"))
        val (ungrouped, packs) = EmojiPicker.customAndPacks(custom, listOf(pack))
        assertEquals(listOf("lost", "parrot"), ungrouped)
        assertEquals(listOf(":hpd-plain:", ":hpd-bow:"), packs.single().cells)
        val sections = EmojiPicker.sections(emptyList(), ungrouped, packs)
        assertEquals(listOf(EmojiPicker.CUSTOM, "pack:p1"), sections.takeLast(2).map { it.key })
    }
}
