package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.ui.EmojiOnly
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/** Emoji-only messages (M101, docs/EMOJI.md §7): the tables and cases shared with the web and iOS. */
class EmojiOnlyTest {
    private val shared = Codec.snake.parseToJsonElement(File("../../shared/emoji-only.json").readText()).jsonObject

    @Test fun tablesAreTheSharedOnes() {
        assertEquals(shared.getValue("max_items").jsonPrimitive.int, EmojiOnly.MAX_ITEMS)
        assertEquals(shared.getValue("whitespace").jsonArray.map { it.jsonPrimitive.content.toInt(16) }, EmojiOnly.WHITESPACE)
        val ranges = shared.getValue("pictographic").jsonArray.map { item ->
            val ends = item.jsonPrimitive.content.split("-").map { it.toInt(16) }
            ends[0]..ends.last()
        }
        assertEquals(ranges, EmojiOnly.PICTOGRAPHIC)
    }

    @Test fun sharedCases() {
        val custom = shared.getValue("custom").jsonObject
        fun kind(name: String): EmojiOnly.Kind? {
            val entry = custom[name]?.jsonObject ?: return null
            return when {
                entry.getValue("kind").jsonPrimitive.content == "text" -> EmojiOnly.Kind.TEXT
                entry.getValue("pack").jsonPrimitive.boolean -> EmojiOnly.Kind.PACK
                else -> EmojiOnly.Kind.IMAGE
            }
        }
        for (case in shared.getValue("cases").jsonArray.map { it.jsonObject }) {
            val body = case.getValue("body").jsonPrimitive.content
            val result = EmojiOnly.parse(body, ::kind)
            assertEquals(body, case.getValue("jumbo").jsonPrimitive.boolean, result != null)
            assertEquals(body, case.getValue("kinds").jsonArray.map { it.jsonPrimitive.content }, result?.kinds?.map { it.key } ?: emptyList<String>())
            assertEquals(body, case.getValue("count").jsonPrimitive.int, result?.kinds?.size ?: 0)
            assertEquals(body, case.getValue("stamp").jsonPrimitive.boolean, result?.stamp ?: false)
        }
    }

    @Test fun kindsComeFromTheRows() {
        val bow = CustomEmojiOut(id = "b", name = "hpd-bow", contentType = "image/png", width = 180, height = 180, createdBy = "u", createdAt = "", packId = "p")
        assertEquals(true, EmojiOnly.parse(" :hpd-bow: ", mapOf("hpd-bow" to bow))?.stamp)
        assertNull(EmojiOnly.parse(":hpd-bow: ok", mapOf("hpd-bow" to bow)))
    }
}
