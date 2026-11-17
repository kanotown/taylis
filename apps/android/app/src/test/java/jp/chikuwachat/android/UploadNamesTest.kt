package jp.chikuwachat.android

import jp.chikuwachat.android.ui.CameraCapture
import jp.chikuwachat.android.ui.UploadNamer
import jp.chikuwachat.android.ui.UploadNames
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDateTime

/** Files without a real name get a time name; the cases the desktop and iOS share (apps/shared/upload-names.json). */
class UploadNamesTest {
    private val vectors: JsonObject by lazy {
        val file = File("../../shared/upload-names.json")
        check(file.isFile) { "apps/shared/upload-names.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun list(key: String): List<JsonObject> = vectors[key]!!.jsonArray.map { it.jsonObject }
    private fun strings(key: String): List<String> = vectors[key]!!.jsonArray.map { it.jsonPrimitive.content }
    private fun JsonObject.text(key: String): String = this[key]!!.jsonPrimitive.content
    private fun JsonObject.time(): LocalDateTime = LocalDateTime.parse(text("time"))

    @Test fun sharedNames() {
        val names = list("names")
        assertTrue(names.size > 5)
        names.forEach { case ->
            assertEquals(case.text("name"), case.text("expected"), UploadNames.name(case.text("kind"), case.text("ext"), case.time(), case["index"]!!.jsonPrimitive.int))
        }
    }

    @Test fun sharedSequences() {
        list("sequences").forEach { sequence ->
            val namer = UploadNamer()
            val steps = sequence["steps"]!!.jsonArray.map { it.jsonObject }
            assertEquals(sequence.text("name"), steps.map { it.text("expected") }, steps.map { namer.next(it.text("kind"), it.text("ext"), it.time()) })
        }
    }

    @Test fun sharedKindsAndUnnamed() {
        list("kinds").forEach { assertEquals(it.text("mime"), it.text("kind"), UploadNames.kind(it.text("mime"))) }
        assertEquals("file", UploadNames.kind(null))
        val unnamed = strings("unnamed")
        val named = strings("named")
        assertTrue(unnamed.size > 10 && named.size > 10)
        unnamed.forEach { assertTrue("\"$it\"", UploadNames.isUnnamed(it)) }
        named.forEach { assertFalse("\"$it\"", UploadNames.isUnnamed(it)) }
    }

    /** The camera's name is the same rule. */
    @Test fun cameraFollowsTheRule() {
        val at = LocalDateTime.of(2026, 11, 17, 9, 5, 3)
        assertEquals(UploadNames.name("photo", "jpg", at, 1), CameraCapture.fileName(at))
    }
}
