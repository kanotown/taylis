package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.Channels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ChannelsTest {
    @Test fun announcementChannelsLetOwnersAndAdminsPost() { // M15a
        val open = channel("a")
        assertTrue(open.canPostTopLevel(isAdmin = false))
        val announce = open.copy(channel = open.channel.copy(postingPolicy = "owners", membership = MembershipOut("member", "")))
        assertFalse(announce.canPostTopLevel(isAdmin = false))
        assertTrue(announce.canPostTopLevel(isAdmin = true))
        assertTrue(announce.copy(channel = announce.channel.copy(membership = MembershipOut("owner", ""))).canPostTopLevel(isAdmin = false))
    }

    private val now = Instant.parse("2026-09-26T12:00:00Z")

    private fun channel(
        id: String, type: String = "public", unread: Int = 0, mentions: Int = 0, member: Boolean = true,
        level: String? = null, mutedUntil: String? = null, lastMessageAt: String? = null,
    ) = ChannelState(
        channel = ChannelOut(
            id = id, type = type, name = id, archived = false, lastSeq = 0, createdAt = "", updatedAt = "", lastMessageAt = lastMessageAt,
            notification = level?.let { NotificationPreferenceOut(id, it, mutedUntil) },
        ),
        isMember = member, unreadCount = unread, mentionCount = mentions,
    )

    @Test fun mutedChannelsCountOnlyMentions() {
        val muted = channel("a", unread = 5, level = "none")
        assertTrue(Channels.isMuted(muted, now))
        assertFalse(Channels.hasUnread(muted, now))
        assertEquals(0, Channels.badgeCount(muted, now))
        val mentioned = channel("b", unread = 5, mentions = 2, level = "mentions", mutedUntil = "2026-09-26T20:00:00Z")
        assertTrue(Channels.hasUnread(mentioned, now))
        assertEquals(2, Channels.badgeCount(mentioned, now))
        val expired = channel("c", unread = 1, level = "mentions", mutedUntil = "2026-09-26T01:00:00Z")
        assertFalse(Channels.isMuted(expired, now))
        assertTrue(Channels.hasUnread(expired, now))
        assertEquals(3, Channels.badgeCount(channel("d", type = "dm", unread = 3), now))
    }

    @Test fun unreadFilterKeepsTheOpenConversation() {
        val all = listOf(
            channel("general"),
            channel("random", unread = 2),
            channel("dm", type = "dm", lastMessageAt = "2026-09-26T00:00:00Z"),
            channel("public", member = false),
        )
        val filtered = Channels.sections(all, unreadOnly = true, currentId = "general", now = now)
        assertEquals(listOf("general", "random"), filtered.channels.map { it.id })
        assertEquals(emptyList<ChannelState>(), filtered.dms)
        assertEquals(emptyList<ChannelState>(), filtered.browse)
        assertEquals(listOf("public"), Channels.sections(all, now = now).browse.map { it.id })
    }

    @Test fun customSectionsTakeTheirConversationsFavoritesFirst() {
        val all = listOf(
            channel("alpha"), channel("beta"), channel("gamma", type = "private"),
            channel("d1", type = "dm", lastMessageAt = "2026-09-26T01:00:00Z"), channel("d2", type = "dm", lastMessageAt = "2026-09-26T02:00:00Z"),
        )
        val sidebar = listOf(
            jp.chikuwachat.android.api.SidebarSectionOut("s1", "プロジェクト", 0, listOf("gamma", "d1", "beta")),
            jp.chikuwachat.android.api.SidebarSectionOut("s2", "空", 1, emptyList()),
        )
        val sections = Channels.sections(all, now = now, favorites = setOf("beta"), sidebar = sidebar)
        assertEquals(listOf("beta"), sections.favorites.map { it.id })
        assertEquals(listOf("プロジェクト" to listOf("gamma", "d1"), "空" to emptyList<String>()), sections.custom.map { (section, rows) -> section.name to rows.map { it.id } })
        assertEquals(listOf("alpha"), sections.channels.map { it.id })
        assertEquals(listOf("d2"), sections.dms.map { it.id })
    }
}
