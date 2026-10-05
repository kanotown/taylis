package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.NavItem
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.ui.HomeTile
import jp.chikuwachat.android.ui.HomeTiles
import jp.chikuwachat.android.ui.NavItems
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.boolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * M111: the home tiles I chose (UserMe.nav_items) — the catalogue and the rule against apps/shared/nav-items.json (the
 * desktop's navItems.test.tsx and iOS's NavItemsFixtureTests read it too), the tile row, and the field's three states.
 */
class NavItemsTest {
    private val shared = run {
        val file = File("../../shared/nav-items.json")
        check(file.isFile) { "apps/shared/nav-items.json not found from ${File("").absolutePath}" }
        Codec.plain.parseToJsonElement(file.readText()).jsonObject
    }

    private fun items(element: JsonElement?): List<NavItem>? =
        if (element == null || element is JsonNull) null
        else element.jsonArray.map { NavItem(it.jsonObject["key"]!!.jsonPrimitive.content, it.jsonObject["visible"]!!.jsonPrimitive.boolean) }

    private fun strings(element: JsonElement?): List<String> = element!!.jsonArray.map { it.jsonPrimitive.content }

    private fun platform(key: String) = NavItems.Platform.entries.first { it.key == key }

    @Test
    fun catalogueIsTheSharedOne() {
        val sharedItems = shared["items"]!!.jsonArray.map { it.jsonObject }
        assertEquals(sharedItems.map { it["key"]!!.jsonPrimitive.content }, NavItems.catalogue.map { it.key })
        NavItems.catalogue.zip(sharedItems).forEach { (entry, item) ->
            assertEquals(item["label"]!!.jsonPrimitive.content, entry.label)
            assertEquals(item["mobile_label"]?.jsonPrimitive?.content, entry.mobileLabel)
            assertEquals(item["visible"]!!.jsonPrimitive.boolean, entry.visible)
            assertEquals(strings(item["platforms"]), entry.platforms.map { it.key })
        }
        val order = shared["order"]!!.jsonObject
        assertEquals(strings(order["desktop"]), NavItems.order[NavItems.Platform.DESKTOP])
        assertEquals(strings(order["mobile"]), NavItems.order[NavItems.Platform.MOBILE])
        HomeTile.entries.forEach { tile ->
            assertTrue(tile.name, sharedItems.any { it["key"]!!.jsonPrimitive.content == tile.navKey && "mobile" in strings(it["platforms"]) })
        }
    }

    @Test
    fun theSharedCases() {
        for (case in shared["cases"]!!.jsonArray.map { it.jsonObject }) {
            val name = case["name"]!!.jsonPrimitive.content
            val p = platform(case["platform"]!!.jsonPrimitive.content)
            val full = NavItems.full(items(case["stored"]), p)
            assertEquals(name, items(case["full"]), full)
            assertEquals(name, items(case["shown"]), NavItems.shown(full, p, strings(case["implemented"])))
        }
        for (case in shared["reorder"]!!.jsonArray.map { it.jsonObject }) {
            val p = platform(case["platform"]!!.jsonPrimitive.content)
            val got = NavItems.reorder(NavItems.full(items(case["stored"]), p), strings(case["order"]), p, strings(case["implemented"]))
            assertEquals(case["name"]!!.jsonPrimitive.content, items(case["full"]), got)
        }
    }

    @Test
    fun tilesFollowMyListAndKeepTheirNumbers() {
        val threads = ThreadSummary(unreadCount = 3, mentionCount = 1)
        assertEquals(HomeTiles.tiles(threads, 1, 2, 0).map { it.tile }, HomeTiles.tiles(threads, 1, 2, 0, navItems = null).map { it.tile })
        val mine = HomeTiles.tiles(threads, 1, 2, 0, navItems = listOf(
            NavItem("calendar", true), NavItem("activity", false), NavItem("times-feed", false),
            NavItem("some-future-page", true), NavItem("threads", true), NavItem("files", false),
        ))
        assertEquals(
            listOf(HomeTile.CALENDAR, HomeTile.THREADS, HomeTile.DRAFTS, HomeTile.SAVED, HomeTile.REMINDERS, HomeTile.TASKS, HomeTile.DEADLINES, HomeTile.CANVASES),
            mine.map { it.tile },
        )
        val tile = mine.first { it.tile == HomeTile.THREADS }
        assertEquals(3, tile.count)
        assertTrue(tile.alert)
    }

    @Test
    fun moveSwapsAmongTheShownOnly() {
        val full = NavItems.full(listOf(NavItem("activity", true), NavItem("threads", true), NavItem("polls", true)))
        val moved = NavItems.move(full, "times-feed", -1)
        assertEquals(listOf("activity", "times-feed", "polls", "threads"), moved.take(4).map { it.key })
        assertEquals(full, NavItems.move(full, "threads", -1))  // already first among the shown
    }

    @Test
    fun theFieldsThreeStates() {
        val base = """"id":"u","username":"u","display_name":"U","role":"member","created_at":"","updated_at":"","must_change_password":false"""
        val absent = Codec.snake.decodeFromString(UserMe.serializer(), "{$base}")
        assertFalse(absent.knowsNavItems)
        assertNull(absent.navItems)
        val unset = Codec.snake.decodeFromString(UserMe.serializer(), """{$base,"nav_items":null}""")
        assertTrue(unset.knowsNavItems)
        assertNull(unset.navItems)
        val chosen = Codec.snake.decodeFromString(UserMe.serializer(), """{$base,"nav_items":[{"key":"files","visible":false}]}""")
        assertEquals(listOf(NavItem("files", false)), chosen.navItems)
        // The store's cache (encoded and read back) keeps the three apart.
        for (me in listOf(absent, unset, chosen)) {
            val again = Codec.plain.decodeFromString(UserMe.serializer(), Codec.plain.encodeToString(UserMe.serializer(), me))
            assertEquals(me.knowsNavItems, again.knowsNavItems)
            assertEquals(me.navItems, again.navItems)
        }
    }
}
