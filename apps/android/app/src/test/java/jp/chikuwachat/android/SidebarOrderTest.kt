package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.ui.SidebarOrder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * DATA_MODEL.md sidebar_sections 「セクションの中の並び順」: the cases the desktop and iOS share
 * (apps/shared/sidebar-order.json).
 */
class SidebarOrderTest {
    private val vectors: JsonObject by lazy {
        val file = File("../../shared/sidebar-order.json")
        check(file.isFile) { "apps/shared/sidebar-order.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.text(key: String): String? = this[key]?.let { if (it is JsonNull) null else it.jsonPrimitive.content }

    private fun row(id: String, type: String, name: String?, last: String?, created: String = "2026-01-01T00:00:00Z") = ChannelState(
        channel = ChannelOut(
            id = id, type = type, name = name, archived = false, lastSeq = 0, createdAt = created, updatedAt = created, lastMessageAt = last,
            dmUserIds = if (name == null) listOf("me", id) else null,
        ),
        isMember = true,
    )

    @Test fun sharedCases() {
        val names = vectors["names"]!!.jsonArray.map { it.jsonObject }
        val sections = vectors["sections"]!!.jsonArray.map { it.jsonObject }
        assertTrue(names.size + sections.size > 10)
        names.forEach { case ->
            val input = case["input"]!!.jsonArray.map { it.jsonPrimitive.content }
            val sorted = case["sorted"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(case.text("name"), sorted, input.sortedWith(SidebarOrder.names))
        }
        sections.forEach { case ->
            val rows = case["conversations"]!!.jsonArray.map { it.jsonObject }.map {
                row(it.text("id")!!, it.text("type")!!, it.text("name"), it.text("last_message_at"), it.text("created_at")!!)
            }
            val order = case["order"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(case.text("name"), order, SidebarOrder.section(rows).map { it.id })
        }
    }

    /** The home's favorites and my own sections follow it (channels by name, then DMs newest first). */
    @Test fun homeUsesIt() {
        val all = listOf(
            row("z", "public", "zeta", null), row("d", "dm", null, "2026-10-01T00:00:00Z"), row("a", "public", "Alpha", null),
            row("k", "public", "カメラ", null), row("i", "public", "いぬ", null), row("d2", "dm", null, "2026-10-02T00:00:00Z"),
        )
        val section = SidebarSectionOut(id = "s1", name = "研究", position = 0, channelIds = listOf("k", "i", "d"))
        val sections = Channels.sections(all, favorites = setOf("z", "a", "d2"), sidebar = listOf(section), meId = "me")
        assertEquals(listOf("a", "z", "d2"), sections.favorites.map { it.id })
        assertEquals(listOf("i", "k", "d"), sections.custom.single().second.map { it.id })
    }
}
