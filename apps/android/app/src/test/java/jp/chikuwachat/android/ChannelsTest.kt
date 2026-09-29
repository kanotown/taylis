package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.Channels
import kotlinx.serialization.Serializable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
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
        level: String? = null, mutedUntil: String? = null, lastMessageAt: String? = null, timesOwner: String? = null,
        muted: Boolean = false,
    ) = ChannelState(
        channel = ChannelOut(
            id = id, type = type, name = id, archived = false, lastSeq = 0, createdAt = "", updatedAt = "", lastMessageAt = lastMessageAt,
            // M35: `level` is the channel's own one; without it the server sends the resolved level with follows_default
            // (here the overall setting "none", to show the rules never read it).
            notification = if (level == null && mutedUntil == null && !muted) null
            else NotificationPreferenceOut(id, level ?: "none", mutedUntil, followsDefault = level == null, muted = muted),
            timesOwnerId = timesOwner,
        ),
        isMember = member, unreadCount = unread, mentionCount = mentions,
    )

    @Test fun mutedChannelsCountOnlyMentions() {
        val muted = channel("a", unread = 5, level = "none")
        assertTrue(Channels.isMuted(muted, now))
        assertFalse(Channels.hasUnread(muted, null, now))
        assertEquals(0, Channels.badgeCount(muted, now))
        val mentioned = channel("b", unread = 5, mentions = 2, level = "mentions", mutedUntil = "2026-09-26T20:00:00Z")
        assertTrue(Channels.hasUnread(mentioned, null, now))
        assertEquals(2, Channels.badgeCount(mentioned, now))
        val expired = channel("c", unread = 1, level = "mentions", mutedUntil = "2026-09-26T01:00:00Z")
        assertFalse(Channels.isMuted(expired, now))
        assertTrue(Channels.hasUnread(expired, null, now))
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

    @Test fun aFoldedSectionKeepsUnreadAndTheOpenConversation() { // M26 (Slack)
        val rows = listOf(channel("read"), channel("unread", unread = 2), channel("open"), channel("dm", type = "dm", unread = 1))
        assertEquals(rows, Channels.shown(rows, collapsed = false, meId = "me", now = now))
        assertEquals(listOf("unread", "open", "dm"), Channels.shown(rows, collapsed = true, meId = "me", currentId = "open", now = now).map { it.id })
        // A muted conversation with posts but no mention is not unread, so it folds away too.
        val muted = channel("muted", unread = 3, level = "none")
        assertEquals(emptyList<ChannelState>(), Channels.shown(listOf(muted), collapsed = true, meId = "me", now = now))
    }

    @Test fun defaultSectionsFoldOnThisDevice() { // M26
        val prefs = MemoryStore()
        assertEquals(emptySet<String>(), jp.chikuwachat.android.ui.FoldedSections.read(prefs))
        assertEquals(setOf("dms"), jp.chikuwachat.android.ui.FoldedSections.toggle(prefs, "dms"))
        assertEquals(setOf("channels", "dms"), jp.chikuwachat.android.ui.FoldedSections.toggle(prefs, "channels"))
        assertEquals(setOf("channels", "dms"), jp.chikuwachat.android.ui.FoldedSections.read(prefs))
        assertEquals(setOf("channels"), jp.chikuwachat.android.ui.FoldedSections.toggle(prefs, "dms"))
        assertEquals(emptySet<String>(), jp.chikuwachat.android.ui.FoldedSections.toggle(prefs, "channels"))
        assertNull(prefs.values["sidebar.folded"]) // nothing folded: nothing stored
    }

    /** One conversation seen by "me" (apps/shared/unread-rules.json, SYNC_PROTOCOL.md §10.5). */
    @Serializable
    private data class UnreadCase(
        val name: String, val type: String, val times: String?, val level: String?, val muted: Boolean,
        val unread: Int, val mentions: Int, val expect: Expected,
    )

    @Serializable
    private data class Expected(val hasUnread: Boolean, val badge: Int, val quiet: Boolean)

    @Serializable
    private data class Vectors(val cases: List<UnreadCase>)

    /** The file the server and the other clients test against: from the module (apps/android/app), ../../shared. */
    private fun vectors(): List<UnreadCase> {
        val file = File("../../shared/unread-rules.json")
        check(file.isFile) { "apps/shared/unread-rules.json not found from ${File("").absolutePath}" }
        return Codec.snake.decodeFromString(Vectors.serializer(), file.readText()).cases
    }

    @Test fun sharedUnreadRules() { // M24
        val cases = vectors()
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            // "muted" is a timed mute still running or (M35) muted until unmuted: both must give the same answers.
            val variants = if (case.muted) listOf("timed" to true, "until unmuted" to false) else listOf("" to false)
            for ((variant, timed) in variants) {
                val row = channel(
                    "c", type = case.type, unread = case.unread, mentions = case.mentions, level = case.level,
                    mutedUntil = if (case.muted && timed) "2026-09-27T00:00:00Z" else null, muted = case.muted && !timed,
                    timesOwner = when (case.times) { "mine" -> "me"; "others" -> "someone"; else -> null },
                )
                val name = "${case.name} $variant".trim()
                assertEquals(name, case.expect.hasUnread, Channels.hasUnread(row, "me", now))
                assertEquals(name, case.expect.badge, Channels.badgeCount(row, now))
                assertEquals(name, case.expect.quiet, Channels.isQuiet(row, "me", now))
                // The faint dot: quiet, something new, and not already shown as unread.
                assertEquals(name, case.expect.quiet && case.unread > 0 && !case.expect.hasUnread, Channels.showsQuietDot(row, "me", now))
            }
        }
    }

    @Test fun timesChannelsHaveTheirOwnSectionMineFirst() { // M24
        val all = listOf(
            channel("general"),
            channel("times-zed", timesOwner = "zed"),
            channel("times-me", timesOwner = "me"),
            channel("times-amy", timesOwner = "amy", unread = 3),
            channel("times-bob", timesOwner = "bob", member = false),
        )
        val sections = Channels.sections(all, now = now, meId = "me")
        assertEquals(listOf("general"), sections.channels.map { it.id })
        assertEquals(listOf("times-me", "times-amy", "times-zed"), sections.times.map { it.id })
        assertEquals(listOf("times-bob"), sections.browse.map { it.id }) // one I am not in is joined from the browse list
        // Quiet unread stays out of the unread filter; a mention brings it in.
        assertEquals(emptyList<ChannelState>(), Channels.sections(all, unreadOnly = true, now = now, meId = "me").times)
        val mentioned = all.map { if (it.id == "times-amy") it.copy(mentionCount = 1) else it }
        assertEquals(listOf("times-amy"), Channels.sections(mentioned, unreadOnly = true, now = now, meId = "me").times.map { it.id })
        // Without knowing who I am, nobody's times comes first.
        assertEquals(listOf("times-amy", "times-me", "times-zed"), Channels.sections(all, now = now).times.map { it.id })
    }

    @Test fun timesOwnerDecodesAndPersists() { // M24
        val wire = """{"id":"c1","type":"public","name":"times-alice","topic":null,"purpose":null,"archived":false,"created_by":"u1",
            "last_seq":0,"last_message_at":null,"created_at":"","updated_at":"","membership":{"role":"owner","joined_at":""},"dm_user_ids":null"""
        val times = Codec.snake.decodeFromString(ChannelOut.serializer(), "$wire,\"times_owner_id\":\"u1\"}")
        assertEquals("u1", times.timesOwnerId)
        assertTrue(times.isTimes)
        val plain = Codec.snake.decodeFromString(ChannelOut.serializer(), "$wire,\"times_owner_id\":null}")
        assertNull(plain.timesOwnerId)
        assertFalse(plain.isTimes)
        assertNull(Codec.snake.decodeFromString(ChannelOut.serializer(), "$wire}").timesOwnerId) // a server before M24

        // The local row (Room, as JSON): kept through a save, and a row saved before M24 still loads.
        val state = ChannelState(times, isMember = true)
        val saved = Codec.plain.encodeToString(ChannelState.serializer(), state)
        assertEquals("u1", Codec.plain.decodeFromString(ChannelState.serializer(), saved).channel.timesOwnerId)
        val old = saved.replace(",\"timesOwnerId\":\"u1\"", "")
        assertFalse(old.contains("timesOwnerId"))
        assertNull(Codec.plain.decodeFromString(ChannelState.serializer(), old).channel.timesOwnerId)
    }
}
