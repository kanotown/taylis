package jp.chikuwachat.android

import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.sync.Store
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」 (2026-10-07, user report: a starred conversation moved into a new
 * section seemed to do nothing): a conversation is in お気に入り or in one of my sections, never both. The server applies
 * the rule; AppController applies it in the Store at once (toggleFavorite / createSection / moveToSection).
 */
class SidebarOnePlaceTest {
    private fun section(vararg ids: String) = SidebarSectionOut(id = "s1", name = "研究", position = 0, channelIds = ids.toList())

    @Test
    fun conversationsPutInASectionLeaveFavorites() {
        val store = Store()
        store.replaceFavorites(listOf("c1", "c2", "c3"))
        store.replaceSidebar(listOf(section("c1", "c2")))
        store.leaveFavorites(listOf("c1", "c2"))
        assertEquals(setOf("c3"), store.favorites.toSet())
        assertEquals("s1", store.sectionOf("c1"))
    }

    @Test
    fun starringTakesAConversationOutOfItsSectionAndTheOldListPutsItBack() {
        val store = Store()
        store.replaceSidebar(listOf(section("c1", "c2")))
        store.setFavorite("c1", true)
        val before = store.takeOutOfSections("c1")
        assertNull(store.sectionOf("c1"))
        assertEquals(listOf("c2"), store.sidebarSections.single().channelIds)
        assertTrue(store.isFavorite("c1"))
        // Refused: AppController puts the star and the section back.
        store.setFavorite("c1", false)
        store.replaceSidebar(before)
        assertEquals("s1", store.sectionOf("c1"))
        assertFalse(store.isFavorite("c1"))
        // A conversation in no section: nothing changes.
        assertEquals(store.sidebarSections, store.takeOutOfSections("c9"))
        assertEquals(listOf("c1", "c2"), store.sidebarSections.single().channelIds)
    }
}
