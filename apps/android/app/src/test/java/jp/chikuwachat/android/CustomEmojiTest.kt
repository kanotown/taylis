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

    /**
     * 2026-10-05: the activity (and the other compact rows) showed a pack emoji as `:ckw-yay:`. Their excerpts now go
     * through EmojiLineText: standard shortcodes become glyphs, known custom names pieces of their own drawn in a box
     * whose width is known before the image (a wide one 3:1, a text emoji's pill wider than square).
     */
    @Test fun compactRowsDrawCustomEmojiInTheirBoxes() {
        val wide = Codec.snake.decodeFromString(CustomEmojiOut.serializer(), """{"id":"y","name":"ckw-yay","content_type":"image/png","width":96,"height":32,"pack_id":"p1","label":"ちくわ わーい","created_by":"u","created_at":""}""")
        val pill = Codec.snake.decodeFromString(CustomEmojiOut.serializer(), """{"id":"t","name":"ok-text","kind":"text","label":"了解","color":"blue","content_type":"","width":0,"height":0,"created_by":"u","created_at":""}""")
        val custom = mapOf(wide.name to wide, pill.name to pill)
        assertEquals(
            listOf(CustomEmoji.Piece.Text("「やった "), CustomEmoji.Piece.Emoji("ckw-yay"), CustomEmoji.Piece.Text(" "), CustomEmoji.Piece.Emoji("ok-text"), CustomEmoji.Piece.Text(" 👍 :gone:」")),
            CustomEmoji.split(Emoji.replaceShortcodes("「やった :ckw-yay: :ok-text: :+1: :gone:」")) { it in custom },
        )
        assertEquals(3f, CustomEmoji.aspect(wide))
        assertTrue(CustomEmoji.aspect(pill) > 1f)
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
        assertEquals(listOf(EmojiPicker.CUSTOM, "pack:p1"), sections.take(2).map { it.key }) // before the standard categories
    }

    /** A drawn image stand-in (a JVM test has no Bitmap). */
    private object Drawn : androidx.compose.ui.graphics.ImageBitmap {
        override val width = 1
        override val height = 1
        override val colorSpace = androidx.compose.ui.graphics.colorspace.ColorSpaces.Srgb
        override val hasAlpha = true
        override val config = androidx.compose.ui.graphics.ImageBitmapConfig.Argb8888
        override fun readPixels(buffer: IntArray, startX: Int, startY: Int, width: Int, height: Int, bufferOffset: Int, stride: Int) {}
        override fun prepareToDraw() {}
    }

    private fun emoji(id: String, name: String, kind: String = "text", label: String? = "承認", color: String? = "#2e7d32", packId: String? = null) =
        CustomEmojiOut(id = id, name = name, contentType = if (kind == "text") "" else "image/png", width = 32, height = 32, createdBy = "u",
            createdAt = "", kind = kind, label = label, color = color, packId = packId)

    /**
     * Review v0.1.37 #7: a text emoji changed (or removed) while offline, its emoji.updated missed: the bootstrap's list drops
     * the drawn pill so it is drawn again with the new label and colour, like the event would. Unchanged ones keep theirs.
     */
    @Test fun aBootstrapListDropsTheImagesItChanged() {
        val store = jp.chikuwachat.android.sync.Store()
        store.replaceCustomEmoji(listOf(emoji("t1", "ok"), emoji("t2", "same"), emoji("t3", "gone"), emoji("i1", "pic", kind = "image", label = null, color = null),
            emoji("t4", "moved")))
        listOf("t1", "t2", "t3", "i1", "t4").forEach { store.setEmojiImage(it, Drawn) }
        store.replaceCustomEmoji(listOf(emoji("t1", "ok", label = "差戻し", color = "#c62828"), emoji("t2", "same"),
            emoji("i1", "pic", kind = "image", label = null, color = null), emoji("t4", "moved", packId = "p1")))
        assertEquals("差戻し", store.customEmoji["ok"]?.label)
        assertNull(store.emojiImages["t1"]) // label and colour changed: drawn again
        assertNull(store.emojiImages["t3"]) // removed
        assertTrue(store.emojiImages["t2"] === Drawn) // unchanged
        assertTrue(store.emojiImages["i1"] === Drawn) // an image emoji keeps its picture
        assertTrue(store.emojiImages["t4"] === Drawn) // only its pack moved: the pill looks the same
        // a kind change swaps pill and picture
        store.replaceCustomEmoji(listOf(emoji("t2", "same", kind = "image", label = null, color = null)))
        assertNull(store.emojiImages["t2"])
        // the event path agrees
        store.replaceCustomEmoji(listOf(emoji("t5", "ev")))
        store.setEmojiImage("t5", Drawn)
        store.applyCustomEmoji(emoji("t5", "ev", color = "#000000"), deleted = false)
        assertNull(store.emojiImages["t5"])
    }
}
