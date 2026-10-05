package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.app.Workspace
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.ui.SectionLetterIcon
import jp.chikuwachat.android.ui.TextEmojiPill
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** M114: section letter badges (apps/shared/section-icons.json) and the switcher's order on the phone. */
class SectionLetterIconTest {
    @Test fun lettersFollowTheSharedCases() {
        val file = File("../../shared/section-icons.json")
        check(file.isFile) { "apps/shared/section-icons.json not found from ${File("").absolutePath}" }
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.size > 10)
        for (case in cases) {
            val icon = case.jsonObject["icon"]!!.jsonPrimitive.content
            val letter = case.jsonObject["letter"]!!
            val expected = if (letter is JsonNull) null else SectionLetterIcon(letter.jsonObject["text"]!!.jsonPrimitive.content, letter.jsonObject["color"]!!.jsonPrimitive.content)
            assertEquals(icon, expected, SectionLetterIcon.parse(icon))
            if (expected != null) assertEquals(icon, expected.icon)
        }
    }

    @Test fun coloursAreTheTextEmojiPalette() {
        assertEquals(TextEmojiPill.PALETTE.keys.toList(), SectionLetterIcon.COLORS.map { it.first })
    }

    @Test fun fullWidthLettersAndHalfWidthKanaBecomeTheirUsualForm() {
        assertEquals("M", SectionLetterIcon.normalize(" Ｍ "))
        assertEquals("ア", SectionLetterIcon.normalize("ｱ"))
    }

    @Test fun workspacesMoveAStepUpOrDown() {
        val list = listOf("a", "b", "c").map { Workspace(serverUrl = "https://$it", name = it, username = "u") }
        fun names(moved: List<Workspace>) = moved.joinToString("") { it.name }
        assertEquals("acb", names(Workspaces.moved(list, "https://c", -1)))
        assertEquals("bac", names(Workspaces.moved(list, "https://a", 1)))
        assertEquals("abc", names(Workspaces.moved(list, "https://a", -1))) // the top stays
        assertEquals("abc", names(Workspaces.moved(list, "https://c", 1)))
        assertEquals("abc", names(Workspaces.moved(list, "https://x", 1)))
    }
}
