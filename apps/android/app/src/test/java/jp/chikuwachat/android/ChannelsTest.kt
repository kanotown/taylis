package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.Channels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ChannelsTest {
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
}
