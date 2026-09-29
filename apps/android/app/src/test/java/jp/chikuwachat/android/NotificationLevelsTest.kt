package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.NotificationLevels
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.ui.NotificationLabels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** M35: the overall setting, a channel's own level and the mute until unmuted (PUSH_NOTIFICATIONS.md §4). */
class NotificationLevelsTest {
    private val now = Instant.parse("2026-09-30T03:00:00Z")

    private fun channel(
        type: String = "public", own: String? = null, resolved: String = "mentions", timesOwner: String? = null,
        mutedUntil: String? = null, muted: Boolean = false, pref: Boolean = true,
    ) = ChannelState(
        channel = ChannelOut(
            id = "c", type = type, name = "c", archived = false, lastSeq = 0, createdAt = "", updatedAt = "", timesOwnerId = timesOwner,
            notification = if (!pref) null else NotificationPreferenceOut("c", own ?: resolved, mutedUntil, followsDefault = own == null, muted = muted),
        ),
        isMember = true, unreadCount = 4, mentionCount = 0,
    )

    @Test fun theResolutionTable() {
        // overall: DM / group DM, someone else's times, any other channel
        val table = mapOf(
            "all" to listOf("all", "mentions", "all"),
            "mentions" to listOf("all", "mentions", "mentions"),
            "none" to listOf("none", "none", "none"),
        )
        for ((overall, row) in table) {
            assertEquals(overall, row[0], NotificationLevels.resolve(null, overall, isDm = true, othersTimes = false))
            assertEquals(overall, row[1], NotificationLevels.resolve(null, overall, isDm = false, othersTimes = true))
            assertEquals(overall, row[2], NotificationLevels.resolve(null, overall, isDm = false, othersTimes = false))
        }
        // A level of its own wins over everything.
        for (own in NotificationLevels.levels) for (overall in NotificationLevels.levels) {
            assertEquals(own, NotificationLevels.resolve(own, overall, isDm = true, othersTimes = false))
            assertEquals(own, NotificationLevels.resolve(own, overall, isDm = false, othersTimes = true))
        }
    }

    @Test fun channelsFollowingTheDefaultShowTheNewOverallSettingAtOnce() {
        // The server resolved "mentions" when it answered; the overall setting has changed since.
        val following = channel(own = null, resolved = "mentions")
        assertEquals("all", NotificationLevels.resolved(following, "all", "me"))
        assertEquals("none", NotificationLevels.resolved(following, "none", "me"))
        val pinned = channel(own = "mentions")
        assertEquals("mentions", NotificationLevels.resolved(pinned, "all", "me"))
        // No preference row at all behaves like following the default.
        assertEquals("all", NotificationLevels.resolved(channel(pref = false), "all", "me"))
        assertEquals("all", NotificationLevels.resolved(channel(type = "group_dm", pref = false), "mentions", "me"))
        // Times: someone else's is mentions, my own is an ordinary channel.
        assertEquals("mentions", NotificationLevels.resolved(channel(timesOwner = "amy", pref = false), "all", "me"))
        assertEquals("all", NotificationLevels.resolved(channel(timesOwner = "me", pref = false), "all", "me"))
    }

    @Test fun theOwnLevelIgnoresTheResolvedOne() {
        assertNull(NotificationLevels.own(channel(own = null, resolved = "none")))
        assertEquals("all", NotificationLevels.own(channel(own = "all")))
        assertNull(NotificationLevels.own(channel(pref = false)))
    }

    @Test fun mutedIsTheOwnNoneTheMuteOrATimedMuteNeverTheOverallSetting() {
        assertFalse(NotificationLevels.isMuted(channel(own = null, resolved = "none"), now)) // overall 「なし」
        assertTrue(NotificationLevels.isMuted(channel(own = "none"), now))
        assertTrue(NotificationLevels.isMuted(channel(muted = true), now))
        assertTrue(NotificationLevels.isMuted(channel(mutedUntil = "2026-09-30T05:00:00Z"), now))
        assertFalse(NotificationLevels.isMuted(channel(mutedUntil = "2026-09-30T01:00:00Z"), now)) // ran out
        // The list's rules follow: a muted channel is unread only with a mention.
        val muted = channel(muted = true)
        assertTrue(Channels.isMuted(muted, now))
        assertFalse(Channels.hasUnread(muted, "me", now))
        assertTrue(Channels.hasUnread(channel(own = null, resolved = "none"), "me", now))
    }

    @Test fun keptTimedMute() {
        assertEquals("2026-09-30T05:00:00Z", NotificationLevels.keptMutedUntil(channel(mutedUntil = "2026-09-30T05:00:00Z"), now))
        assertNull(NotificationLevels.keptMutedUntil(channel(mutedUntil = "2026-09-30T01:00:00Z"), now))
        assertNull(NotificationLevels.keptMutedUntil(channel(pref = false), now))
    }

    @Test fun whatNotifies() {
        val plain = channel(pref = false)
        assertFalse(NotificationLevels.notifies(plain, "mentions", "me", involved = false, now = now))
        assertTrue(NotificationLevels.notifies(plain, "mentions", "me", involved = true, now = now))
        assertTrue(NotificationLevels.notifies(plain, "all", "me", involved = false, now = now))
        assertFalse(NotificationLevels.notifies(plain, "none", "me", involved = true, now = now))
        assertTrue(NotificationLevels.notifies(channel(type = "dm", pref = false), "mentions", "me", involved = false, now = now))
        assertFalse(NotificationLevels.notifies(channel(type = "dm", pref = false), "none", "me", involved = false, now = now))
        // A level of its own beats overall 「なし」; a mute beats everything.
        assertTrue(NotificationLevels.notifies(channel(own = "all"), "none", "me", involved = false, now = now))
        assertFalse(NotificationLevels.notifies(channel(own = "all", muted = true), "all", "me", involved = true, now = now))
        assertFalse(NotificationLevels.notifies(channel(own = "all", mutedUntil = "2026-09-30T05:00:00Z"), "all", "me", involved = true, now = now))
    }

    @Test fun decodingOlderAndNewerPayloads() {
        val old = Codec.snake.decodeFromString(NotificationPreferenceOut.serializer(), """{"channel_id":"c","level":"all","muted_until":null}""")
        assertTrue(old.followsDefault)
        assertFalse(old.muted)
        val new = Codec.snake.decodeFromString(
            NotificationPreferenceOut.serializer(), """{"channel_id":"c","level":"none","muted_until":null,"follows_default":false,"muted":true}""",
        )
        assertEquals("none", new.ownLevel)
        assertTrue(new.muted)
        val me = Codec.snake.decodeFromString(
            UserMe.serializer(), """{"id":"u","username":"u","display_name":"U","role":"member","created_at":"","updated_at":"","must_change_password":false}""",
        )
        assertEquals("mentions", me.notificationDefault)
        val all = Codec.snake.decodeFromString(
            UserMe.serializer(),
            """{"id":"u","username":"u","display_name":"U","role":"member","created_at":"","updated_at":"","must_change_password":false,"notification_default":"all"}""",
        )
        assertEquals("all", all.notificationDefault)
    }

    @Test fun labels() {
        assertEquals(listOf("すべての新着メッセージ", "メンションと DM のみ", "なし"), NotificationLevels.levels.map(NotificationLabels::overallLabel))
        assertEquals(listOf("すべてのメッセージ", "メンションのみ", "通知しない"), NotificationLevels.levels.map(NotificationLabels::label))
        assertEquals("既定 (メンションと DM のみ)", NotificationLabels.defaultChoice("mentions"))
        assertEquals("既定 (なし)", NotificationLabels.defaultChoice("none"))
    }
}
