package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.SidebarDefaultOut
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.ui.MainTabs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** M118 (DATA_MODEL.md sidebar_sections 「DM の固定」): pinned DMs first in pin order, then each list's own order. */
class DmPinsTest {
    private fun dm(id: String, last: String, users: List<String> = listOf("me", id), type: String = "dm") = ChannelState(
        ChannelOut(id = id, type = type, archived = false, lastSeq = 1, createdAt = "2026-01-01T00:00:00Z", updatedAt = "t", lastMessageAt = last, dmUserIds = users),
        isMember = true,
    )

    private fun channel(id: String, name: String) = ChannelState(
        ChannelOut(id = id, type = "public", name = name, archived = false, lastSeq = 1, createdAt = "t", updatedAt = "t"),
        isMember = true,
    )

    private val self = dm("self", "2026-10-01T00:00:00Z", listOf("me"))
    private val a = dm("a", "2026-10-05T00:00:00Z")
    private val b = dm("b", "2026-10-04T00:00:00Z")
    private val c = dm("c", "2026-10-03T00:00:00Z")
    private val g = dm("g", "2026-10-02T00:00:00Z", listOf("me", "x", "y"), type = "group_dm")
    private val all = listOf(self, a, b, c, g)
    private val titles = mapOf("self" to "わたし", "a" to "あおき", "b" to "いとう", "c" to "うえだ", "g" to "えのもと")
    private fun title(row: ChannelState) = titles[row.id] ?: ""

    @Test fun theDmTabPutsThePinsFirstThenMyOwnDmThenTheNewest() {
        assertEquals(listOf("self", "a", "b", "c", "g"), MainTabs.dmList(all, ::title, "me").map { it.id })
        assertEquals(listOf("g", "c", "self", "a", "b"), MainTabs.dmList(all, ::title, "me", dmPins = listOf("g", "c")).map { it.id })
        // My own DM pinned: where its pin puts it.
        assertEquals(listOf("b", "self", "a", "c", "g"), MainTabs.dmList(all, ::title, "me", dmPins = listOf("b", "self")).map { it.id })
        // A pin of a conversation not in the list (left, or filtered out) is skipped.
        assertEquals(listOf("b", "self", "a", "c", "g"), MainTabs.dmList(all, ::title, "me", dmPins = listOf("gone", "b")).map { it.id })
        // The filter keeps a pinned row first among the ones it keeps (「う」: いとう and うえだ).
        assertEquals(listOf("c", "b"), MainTabs.dmList(all, ::title, "me", query = "う", dmPins = listOf("c")).map { it.id })
    }

    @Test fun theHomeSectionsFollowEachSort() {
        fun dms(sort: String, manual: List<String> = emptyList(), pins: List<String>) =
            Channels.sections(all, meId = "me", defaults = listOf(SidebarDefaultOut("dms", sort, manual)), title = ::title, dmPins = pins).dms.map { it.id }
        assertEquals(listOf("c", "self", "a", "b", "g"), dms("recent", pins = listOf("c")))
        assertEquals(listOf("c", "self", "a", "b", "g"), dms("name", pins = listOf("c")))
        assertEquals(listOf("g", "a", "self", "b", "c"), dms("name", pins = listOf("g", "a")))
        // 「手動」: the pins still first; the hand-made order is for the rest.
        assertEquals(listOf("b", "g", "self", "a", "c"), dms("manual", manual = listOf("g", "self", "b"), pins = listOf("b")))
        // In one of my sections, and among the favourites; never a channel.
        val section = SidebarSectionOut("s1", "研究", 0, channelIds = listOf("a", "b", "ch"), sort = "name")
        val sections = Channels.sections(all + channel("ch", "general"), meId = "me", sidebar = listOf(section), favorites = setOf("c", "g"), title = ::title, dmPins = listOf("b", "g", "ch"))
        assertEquals(listOf("b", "ch", "a"), sections.custom.single().second.map { it.id })
        assertEquals(listOf("g", "c"), sections.favorites.map { it.id })
    }

    @Test fun theHomeDmSectionAlwaysShowsThePins() {
        val many = all + (1..8).map { dm("d$it", "2026-09-%02dT00:00:00Z".format(20 - it)) }
        val pins = listOf("d8", "d7")
        val dms = Channels.sections(many, meId = "me", title = ::title, dmPins = pins).dms
        val home = Channels.dmSection(dms, "me", dmPins = pins)
        assertEquals(listOf("d8", "d7", "self", "a", "b", "c", "g", "d1"), home.rows.map { it.id })
        assertTrue(home.more)
    }

    @Test fun theStoreKeepsPinOrderLikeTheServer() {
        val store = Store()
        assertFalse(store.dmPinsKnown)
        store.replaceDmPins(listOf("a", "b"))
        assertTrue(store.dmPinsKnown)
        store.setDmPin("a", true) // already pinned: keeps its place
        store.setDmPin("c", true)
        assertEquals(listOf("a", "b", "c"), store.dmPins)
        store.setDmPin("a", false)
        store.setDmPin("a", true) // pinned again: last
        assertEquals(listOf("b", "c", "a"), store.dmPins)
        store.restoreDmPins(listOf("a", "b", "c"))
        assertEquals(listOf("a", "b", "c"), store.dmPins)
        store.replaceDmPins(null) // a server before M118
        assertFalse(store.dmPinsKnown)
        assertTrue(store.dmPins.isEmpty())
    }
}
