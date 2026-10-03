package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.NotificationLevels
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.ui.NotificationLabels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import kotlinx.serialization.Serializable
import org.junit.Test
import java.io.File
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
        // A server before M35: its level is the channel's own (a "none" stays muted, as before).
        assertNull(old.followsDefault)
        assertEquals("all", old.ownLevel)
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

    /** One message seen by "me" (apps/shared/notify-rules.json, PUSH_NOTIFICATIONS.md §4). */
    @Serializable
    private data class NotifyCase(
        val name: String, val level: String, val reply: String, val follower: Boolean, val unfollowed: Boolean,
        val mentioned: Boolean, val mentionAll: Boolean, val keyword: Boolean, val expect: NotifyExpected,
    )

    @Serializable
    private data class NotifyExpected(val notify: Boolean)

    @Serializable
    private data class NotifyVectors(val cases: List<NotifyCase>, val systemMessages: SystemVectors? = null)

    /** M88: the `system_messages` section, the same facts plus the message's `type`. */
    @Serializable
    private data class SystemCase(
        val name: String, val type: String, val level: String, val reply: String, val follower: Boolean, val unfollowed: Boolean,
        val mentioned: Boolean, val mentionAll: Boolean, val keyword: Boolean, val expect: NotifyExpected,
    )

    @Serializable
    private data class SystemVectors(val cases: List<SystemCase>)

    /** The file the server and the other clients test against: from the module (apps/android/app), ../../shared. */
    private fun vectorFile(): NotifyVectors {
        val file = File("../../shared/notify-rules.json")
        check(file.isFile) { "apps/shared/notify-rules.json not found from ${File("").absolutePath}" }
        return Codec.snake.decodeFromString(NotifyVectors.serializer(), file.readText())
    }

    private fun notifyVectors(): List<NotifyCase> = vectorFile().cases

    /**
     * M89 (MEMBERSHIP.md §5 item 4): a join / leave line never notifies, whatever else the facts say: from the rule, from
     * the channel entry point and from the facts the engine reads off the message.
     */
    @Test fun sharedSystemMessageRules() {
        val cases = vectorFile().systemMessages?.cases ?: emptyList()
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val facts = NotificationLevels.Facts(
                replyKind(case.reply), follower = case.follower, unfollowed = case.unfollowed,
                mentioned = case.mentioned, mentionAll = case.mentionAll, keyword = case.keyword, system = case.type != "user",
            )
            assertEquals(case.name, case.expect.notify, NotificationLevels.messageNotifies(case.level, facts))
            assertEquals(case.name, case.expect.notify, NotificationLevels.notifies(channel(own = case.level), "mentions", "me", facts, now))
            val message = MessageOut(
                id = "m", channelId = "c", senderId = "alice", seq = 5, updatedSeq = 5, parentId = null,
                body = "Alice が参加しました" + if (case.keyword) " deploy" else "", type = case.type,
                mentionedUserIds = if (case.mentioned) listOf("me") else emptyList(), mentionAll = case.mentionAll,
                createdAt = "2026-10-03T00:00:00Z", deleted = false,
            )
            val read = NotificationLevels.facts(message, "me", listOf("Deploy"), null, followingHeld = false)
            assertTrue(case.name, read.system)
            assertEquals(case.name, case.expect.notify, NotificationLevels.messageNotifies(case.level, read))
        }
    }

    private fun replyKind(reply: String) = when (reply) {
        "none" -> NotificationLevels.Reply.NONE
        "thread_only" -> NotificationLevels.Reply.THREAD_ONLY
        "also_in_channel" -> NotificationLevels.Reply.ALSO_IN_CHANNEL
        else -> error("unknown reply kind $reply")
    }

    @Test fun sharedNotifyRules() {
        val cases = notifyVectors()
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val facts = NotificationLevels.Facts(
                replyKind(case.reply), follower = case.follower, unfollowed = case.unfollowed,
                mentioned = case.mentioned, mentionAll = case.mentionAll, keyword = case.keyword,
            )
            assertEquals(case.name, case.expect.notify, NotificationLevels.messageNotifies(case.level, facts))
            // The same level as a channel's own one, not muted: the channel entry point gives the same answer.
            assertEquals(case.name, case.expect.notify, NotificationLevels.notifies(channel(own = case.level), "mentions", "me", facts, now))
        }
    }

    /**
     * The same cases from what the client really sees: the message and its event's parent_thread. The server auto-follows
     * everyone a reply names (by id or keyword) unless they unfollowed by hand, so such a "me" is in participant_ids
     * unless unfollowed; the facts the engine infers must give the vector's answer.
     */
    @Test fun sharedNotifyRulesFromTheEvent() {
        for (case in notifyVectors()) {
            val kind = replyKind(case.reply)
            val named = case.mentioned || case.keyword
            val inThread = !case.unfollowed && (case.follower || (kind != NotificationLevels.Reply.NONE && named))
            val message = MessageOut(
                id = "m", channelId = "c", senderId = "alice", seq = 5, updatedSeq = 5,
                parentId = if (kind == NotificationLevels.Reply.NONE) null else "p",
                alsoInChannel = kind == NotificationLevels.Reply.ALSO_IN_CHANNEL,
                body = "hello" + if (case.keyword) " deploy" else "", type = "user",
                mentionedUserIds = if (case.mentioned) listOf("me") else emptyList(), mentionAll = case.mentionAll,
                createdAt = "2026-10-02T00:00:00Z", deleted = false,
            )
            val thread = if (kind == NotificationLevels.Reply.NONE) null
            else ParentThread("p", 2, null, 5, participantIds = listOf("alice") + if (inThread) listOf("me") else emptyList())
            val facts = NotificationLevels.facts(message, "me", listOf("Deploy"), thread, followingHeld = false)
            assertEquals(case.name, case.expect.notify, NotificationLevels.messageNotifies(case.level, facts))
        }
    }

    @Test fun factsFromAnEvent() {
        fun reply(mentioned: Boolean = false, also: Boolean = false, parent: String? = "p") = MessageOut(
            id = "m", channelId = "c", senderId = "alice", seq = 5, updatedSeq = 5, parentId = parent, alsoInChannel = also,
            body = "hi", type = "user", mentionedUserIds = if (mentioned) listOf("me") else emptyList(), createdAt = "", deleted = false,
        )
        val without = ParentThread("p", 1, null, 5, participantIds = listOf("alice"))
        val with = ParentThread("p", 1, null, 5, participantIds = listOf("alice", "me"))
        // Named but left out of the followers: unfollowed by hand.
        assertTrue(NotificationLevels.facts(reply(mentioned = true), "me", emptyList(), without, false).unfollowed)
        assertFalse(NotificationLevels.facts(reply(mentioned = true), "me", emptyList(), with, false).unfollowed)
        // A reply also in the channel, or no parent_thread: never inferred.
        assertFalse(NotificationLevels.facts(reply(mentioned = true, also = true), "me", emptyList(), without, false).unfollowed)
        assertFalse(NotificationLevels.facts(reply(mentioned = true), "me", emptyList(), null, false).unfollowed)
        // Without parent_thread the thread state held here says whether I follow.
        assertTrue(NotificationLevels.facts(reply(), "me", emptyList(), null, followingHeld = true).follower)
        assertFalse(NotificationLevels.facts(reply(), "me", emptyList(), null, followingHeld = false).follower)
        assertFalse(NotificationLevels.facts(reply(parent = null), "me", emptyList(), null, followingHeld = true).follower)
    }
}
