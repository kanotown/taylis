package jp.chikuwachat.android

import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.ui.Mentions
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** MOBILE_UI.md §23: the order of the @ suggestions against apps/shared/mention-rank.json (the other clients' too). */
class MentionRankTest {
    /** The file the other clients test against: from the module (apps/android/app), ../../shared. */
    private val vectors: JsonObject by lazy {
        val file = File("../../shared/mention-rank.json")
        check(file.isFile) { "apps/shared/mention-rank.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.text(key: String) = this[key]!!.jsonPrimitive.content
    private fun JsonObject.textOrNull(key: String) = this[key]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
    private fun JsonObject.list(key: String) = this[key]!!.jsonArray.map { it.jsonPrimitive.content }
    private fun JsonObject.flag(key: String) = this[key]?.jsonPrimitive?.booleanOrNull == true

    @Test fun sharedRecentVectors() {
        val cap = vectors["recent_messages"]!!.jsonPrimitive.int
        assertEquals(cap, Mentions.RECENT_MESSAGES)
        val cases = vectors["recent"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        fun spoken(case: JsonObject, key: String) = case[key]!!.jsonArray.map { it.jsonObject }
            .map { Mentions.Spoken(it.text("sender_id"), it.flag("deleted"), it.textOrNull("type") ?: "user") }
        cases.forEach { case ->
            val got = Mentions.recentSpeakers(spoken(case, "channel"), spoken(case, "thread"), case["cap"]?.jsonPrimitive?.intOrNull ?: cap)
            assertEquals(case.text("name"), case.list("speakers"), got)
        }
    }

    @Test fun sharedRankVectors() {
        val rank = vectors["rank"]!!.jsonObject
        val users = rank["users"]!!.jsonArray.map { it.jsonObject }.map { u ->
            UserPublic(
                id = u.text("id"), username = u.text("username"), displayName = u.text("display_name"),
                role = if (u.flag("ai") || u.flag("bot")) "bot" else "member",
                deactivatedAt = if (u.flag("deactivated")) "2026-01-01T00:00:00Z" else null,
                createdAt = "", updatedAt = "", botKind = if (u.flag("ai")) "ai" else null,
            )
        }
        val groups = rank["groups"]!!.jsonArray.map { it.jsonObject }.map { g ->
            GroupOut(g.text("id"), g.text("name"), g.textOrNull("description"), g.list("member_ids"), "u1", "", "")
        }
        val cases = rank["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val context = Mentions.Context(case.list("recent"), case.list("members"), case.textOrNull("me"))
            val got = Mentions.candidates(case.text("query"), users, groups, limit = case["limit"]!!.jsonPrimitive.int, context = context)
            assertEquals(case.text("name"), case.list("expected"), got.map { it.username })
        }
    }
}
