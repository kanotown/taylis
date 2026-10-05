package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.paragraphLayout
import jp.chikuwachat.android.ui.parseBlocks
import jp.chikuwachat.android.ui.visibleText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 2026-10-05: blank lines in a body are one paragraph gap, not empty lines — the shared cases in
 * apps/shared/body-paragraphs.json, as the desktop's bodySpacing.test.tsx and iOS's BodyParagraphsFixtureTests read them.
 */
class BodyParagraphsTest {
    @Test
    fun theSharedCases() {
        val file = File("../../shared/body-paragraphs.json")
        check(file.isFile) { "apps/shared/body-paragraphs.json not found from ${File("").absolutePath}" }
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val c = case.jsonObject
            val got = JsonArray(parseBlocks(c["body"]!!.jsonPrimitive.content).filterIsInstance<BodyBlock.Paragraph>().map { block ->
                val layout = paragraphLayout(block.lines)
                buildJsonObject {
                    put("gap_before", layout.gapBefore)
                    put("gap_after", layout.gapAfter)
                    put("groups", buildJsonArray { layout.groups.forEach { group -> add(buildJsonArray { group.forEach { add(JsonPrimitive(visibleText(it))) } }) } })
                }
            })
            assertEquals(c["name"]!!.jsonPrimitive.content, c["paragraphs"], got)
        }
    }
}
