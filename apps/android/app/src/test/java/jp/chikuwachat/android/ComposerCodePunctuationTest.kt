package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.BodyToken
import jp.chikuwachat.android.ui.straightenCode
import jp.chikuwachat.android.ui.tokenizeInline
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 2026-10-06: a keyboard's curly quotes and dashes go back to what was typed inside code before sending — the shared
 * cases in apps/shared/composer-code-punctuation.json, as iOS's StraightenCodeTests read them.
 */
class ComposerCodePunctuationTest {
    @Test
    fun theSharedCases() {
        val file = File("../../shared/composer-code-punctuation.json")
        check(file.isFile) { "apps/shared/composer-code-punctuation.json not found from ${File("").absolutePath}" }
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val c = case.jsonObject
            assertEquals(c["name"]!!.jsonPrimitive.content, c["output"]!!.jsonPrimitive.content, straightenCode(c["input"]!!.jsonPrimitive.content))
        }
    }

    @Test
    fun theCodeStillRendersAsCode() {
        assertEquals(listOf(BodyToken.Code("it's"), BodyToken.Text(" ”x”")), tokenizeInline(straightenCode("`it’s` ”x”")))
    }
}
