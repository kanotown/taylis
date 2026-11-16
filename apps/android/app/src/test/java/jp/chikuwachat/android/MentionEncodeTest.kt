package jp.chikuwachat.android

import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.ui.CanvasText
import jp.chikuwachat.android.ui.Mentions
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** M189: `@name` as the stored token against apps/shared/mention-encode.json (the other clients' too). */
class MentionEncodeTest {
    /** The file the other clients test against: from the module (apps/android/app), ../../shared. */
    private val vectors: JsonObject by lazy {
        val file = File("../../shared/mention-encode.json")
        check(file.isFile) { "apps/shared/mention-encode.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun pairs(key: String) = vectors[key]!!.jsonArray.map { pair -> pair.jsonArray.map { it.jsonPrimitive.content } }
    private val users by lazy { pairs("users").map { UserPublic(it[0], it[1], it[1], "member", null, "", "") } }
    private val groups by lazy { pairs("groups").map { GroupOut(it[0], it[1], createdBy = "", createdAt = "", updatedAt = "") } }

    @Test fun theSharedCases() {
        val cases = vectors["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val text = case["text"]!!.jsonPrimitive.content
            val stored = case["stored"]!!.jsonPrimitive.content
            val name = case["name"]!!.jsonPrimitive.content
            assertEquals(name, stored, Mentions.encode(text, users, groups))
            assertEquals(name, stored, CanvasText.encodeMentions(text, users, groups))
        }
    }

    @Test fun anEditedMessageKeepsItsMentionInItalic() {
        val byId = users.associateBy { it.id }
        val groupsById = groups.associateBy { it.id }
        listOf("_確認 <@${users[0].id}>_", "_<@${users[1].id}> 確認_", "_全員 <!here>_", "__<@group:${groups[0].id}>__").forEach { stored ->
            assertEquals(stored, Mentions.encode(Mentions.decode(stored, byId, groupsById), users, groups))
        }
    }
}
