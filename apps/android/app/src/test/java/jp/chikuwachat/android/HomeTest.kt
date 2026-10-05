package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.ui.HomeTile
import jp.chikuwachat.android.ui.HomeTiles
import jp.chikuwachat.android.ui.Jump
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.RecentConversations
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.TileState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** M37 (MOBILE_UI.md §6.1, §6.2): the phone home's pure parts: sections, DM rows, tiles, recent conversations, jumping. */
class HomeTest {
    private val me = "me"
    private val now = Instant.parse("2026-09-30T03:00:00Z")

    private fun channel(
        id: String, type: String = "public", unread: Int = 0, mentions: Int = 0, member: Boolean = true, level: String? = null,
        users: List<String>? = null, last: String? = null, archived: Boolean = false, name: String? = id,
    ) = ChannelState(
        channel = ChannelOut(
            id = id, type = type, name = if (type == "dm" || type == "group_dm") null else name, archived = archived, lastSeq = 0,
            createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z", lastMessageAt = last, dmUserIds = users,
            notification = level?.let { NotificationPreferenceOut(id, it, null, followsDefault = false) },
        ),
        isMember = member, unreadCount = unread, mentionCount = mentions,
    )

    private fun dm(id: String, other: String = "u-$id", unread: Int = 0, day: Int = 1) =
        channel(id, "dm", unread = unread, users = listOf(me, other), last = "2026-09-%02dT00:00:00Z".format(day))

    private fun user(id: String, name: String, username: String = id, deactivated: Boolean = false) =
        UserPublic(id = id, username = username, displayName = name, role = "member", createdAt = "", updatedAt = "", deactivatedAt = if (deactivated) "2026-01-01T00:00:00Z" else null)

    // --- sections ---

    @Test
    fun theDmSectionIsMyOwnDmThenTheFiveNewestWithAWayToTheRest() {
        val notes = channel("notes", "dm", users = listOf(me), last = "2026-08-01T00:00:00Z")
        val dms = (1..8).map { dm("d$it", day = it) } + notes
        val ordered = Channels.sections(dms, now = now, meId = me).dms
        val section = Channels.dmSection(ordered, me, now)
        assertEquals(listOf("notes", "d8", "d7", "d6", "d5", "d4"), section.rows.map { it.id })
        assertTrue(section.more)
        // An older unread one is never hidden (and 「すべての DM」 still leads to the rest).
        val withUnread = Channels.sections(dms.map { if (it.id == "d1") it.copy(unreadCount = 2) else it }, now = now, meId = me).dms
        val unreadShown = Channels.dmSection(withUnread, me, now)
        assertEquals(listOf("notes", "d8", "d7", "d6", "d5", "d4", "d1"), unreadShown.rows.map { it.id })
        assertTrue(unreadShown.more)
        // Five or fewer besides my own: all of them, no 「すべての DM」.
        val few = Channels.dmSection(Channels.sections((1..5).map { dm("d$it", day = it) } + notes, now = now, meId = me).dms, me, now)
        assertEquals(listOf("notes", "d5", "d4", "d3", "d2", "d1"), few.rows.map { it.id })
        assertFalse(few.more)
        // Grouped unread took d1 out of the section: the rest counts without it.
        val grouped = Channels.sections(dms.map { if (it.id == "d1") it.copy(unreadCount = 2) else it }, groupUnread = true, now = now, meId = me)
        assertEquals(listOf("d1"), grouped.unread.map { it.id })
        val rest = Channels.dmSection(grouped.dms, me, now)
        assertEquals(listOf("notes", "d8", "d7", "d6", "d5", "d4"), rest.rows.map { it.id })
        assertTrue(rest.more) // d2, d3
    }

    @Test
    fun groupedUnreadTakesEveryUnreadConversationFromItsOwnSection() {
        val all = listOf(
            channel("fav", unread = 1, last = "2026-09-29T01:00:00Z"),
            channel("inSection", unread = 3, last = "2026-09-29T02:00:00Z"),
            channel("plain"),
            channel("mutedQuiet", unread = 4, level = "none"),
            channel("mutedMention", unread = 4, mentions = 1, level = "none", last = "2026-09-28T00:00:00Z"),
            channel("archived", unread = 2, archived = true),
            dm("dm", unread = 1, day = 29),
        )
        val sidebar = listOf(jp.chikuwachat.android.api.SidebarSectionOut("s1", "研究", 0, listOf("inSection", "plain")))
        val sections = Channels.sections(all, groupUnread = true, now = now, favorites = setOf("fav"), sidebar = sidebar, meId = me)
        // Newest first; a muted conversation only with a mention; an archived channel never.
        assertEquals(listOf("inSection", "fav", "dm", "mutedMention"), sections.unread.map { it.id })
        assertEquals(emptyList<ChannelState>(), sections.favorites)
        assertEquals(listOf("plain"), sections.custom.single().second.map { it.id })
        assertEquals(listOf("mutedQuiet"), sections.channels.map { it.id })
        assertEquals(emptyList<ChannelState>(), sections.dms)
        assertTrue(sections.unreadShown)
        // 仕上げ A (H3): nothing unread, no 「未読」 section at all; nor with 「未読をまとめる」 off.
        assertFalse(Channels.sections(listOf(channel("plain"), dm("dm")), groupUnread = true, now = now, meId = me).unreadShown)
        assertFalse(Channels.sections(all, groupUnread = false, now = now, meId = me).unreadShown)
        // Folded sections still show their unread rows (M26), which grouping leaves nowhere else.
        assertEquals(listOf("inSection"), Channels.shown(Channels.sections(all, favorites = setOf("fav"), sidebar = sidebar, now = now, meId = me).custom.single().second, collapsed = true, meId = me, now = now).map { it.id })
    }

    // --- tiles ---

    @Test
    fun theTilesCountLikeTheRowsTheyReplaced() {
        val tiles = HomeTiles.tiles(ThreadSummary(unreadCount = 3, mentionCount = 1), drafts = 2, saved = 0, firedReminders = 1)
        // M112: 予約 only once the server answered the pools (ReservationsTest).
        assertEquals(HomeTile.entries.toList() - HomeTile.RESERVATIONS, tiles.map { it.tile })
        assertEquals(TileState(HomeTile.THREADS, 3, alert = true), tiles[0])
        // L8 (TIMES_FEED.md §7): 「Times」 after スレッド, without a number.
        assertEquals(TileState(HomeTile.TIMES, null), tiles[1])
        assertEquals(TileState(HomeTile.DRAFTS, 2), tiles[2])
        assertEquals(TileState(HomeTile.SAVED, 0), tiles[3])
        assertTrue(tiles[3].dimmed) // 0: dimmed, still a tile to tap
        assertEquals(TileState(HomeTile.REMINDERS, 1, alert = true), tiles[4])
        // M52 (CALENDAR.md §7): 「カレンダー」 next to リマインダー, without a number.
        assertEquals(TileState(HomeTile.CALENDAR, null), tiles[5])
        // M56 (TASKS.md §6): 「タスク」 next to カレンダー, without a number.
        assertEquals(TileState(HomeTile.TASKS, null), tiles[6])
        // M86 (DEADLINES.md §8 3.): 「締切」 next to タスク, without a number.
        assertEquals(TileState(HomeTile.DEADLINES, null), tiles[7])
        assertEquals(TileState(HomeTile.FILES, null), tiles[8])
        assertFalse(tiles[8].dimmed) // no number: never dimmed
        // Unread threads without a mention are not red; nothing fired: no red either.
        val calm = HomeTiles.tiles(ThreadSummary(unreadCount = 2), drafts = 0, saved = 5, firedReminders = 0)
        assertFalse(calm[0].alert)
        assertTrue(calm[2].dimmed)
        assertFalse(calm[4].alert)
        assertTrue(calm[4].dimmed)
        assertEquals("スレッド、未読 3 件、メンションあり", HomeTiles.description(tiles[0]))
        assertEquals("リマインダー、通知済み 1 件", HomeTiles.description(tiles[4]))
        assertEquals("カレンダー", HomeTiles.description(tiles[5]))
        assertEquals("タスク", HomeTiles.description(tiles[6]))
        assertEquals("締切", HomeTiles.description(tiles[7]))
        assertEquals("ファイル", HomeTiles.description(tiles[8]))
        assertEquals("Times", HomeTiles.description(tiles[1]))
    }

    // --- recent conversations ---

    @Test
    fun recentConversationsKeepTheTenLastOpenedPerAccount() {
        val prefs = MemoryStore()
        val key = RecentConversations.key("https://a.example|kano")
        assertEquals(emptyList<String>(), RecentConversations.read(prefs, key))
        (1..12).forEach { RecentConversations.push(prefs, key, "c$it") }
        assertEquals((12 downTo 3).map { "c$it" }, RecentConversations.read(prefs, key))
        // Opened again: first, once.
        assertEquals(listOf("c5", "c12", "c11", "c10", "c9", "c8", "c7", "c6", "c4", "c3"), RecentConversations.push(prefs, key, "c5"))
        // Another account on the device has its own.
        assertEquals(emptyList<String>(), RecentConversations.read(prefs, RecentConversations.key("https://a.example|ebi")))
        // A conversation that vanished or that I left (private) is skipped; a public one I left opens as a preview.
        val known = mapOf(
            "c5" to channel("c5"),
            "c12" to channel("c12", "private", member = false),
            "c11" to channel("c11", member = false),
        )
        assertEquals(listOf("c5", "c11"), RecentConversations.shown(RecentConversations.read(prefs, key)) { known[it] }.map { it.id })
        RecentConversations.clear(prefs, key)
        assertNull(prefs.values[key])
    }

    // --- jumping ---

    private val users = listOf(
        user(me, "加納 透", "toru"),
        user("alice", "Alice Smith", "alice"),
        user("gen", "源 さん", "gen_minamoto"),
        user("gone", "Genta", "genta", deactivated = true),
    )
    private val byId = users.associateBy { it.id }
    private val userNames: (String) -> List<String> = { id -> byId[id]?.let { listOf(it.displayName, it.username) } ?: emptyList() }

    @Test
    fun conversationsMatchChannelNamesAndDmPeopleByTheSharedRule() {
        val channels = listOf(
            channel("general"),
            channel("gen-z", unread = 1),
            channel("agenda"),
            channel("old-gen", archived = true),
            channel("genre", member = false),
            channel("dm-gen", "dm", users = listOf(me, "gen")),
            channel("notes", "dm", users = listOf(me)),
            channel("group", "group_dm", users = listOf(me, "alice", "gen")),
        )
        val title: (ChannelState) -> String = { it.channel.name ?: Jump.names(it, me, userNames).first() }
        // A name or a username starting with it (unread first, then by title in code-point order), then one containing it; archived and not-joined never.
        assertEquals(listOf("gen-z", "group", "general", "dm-gen", "agenda"), Jump.conversations("gen", channels, me, title, userNames, now).map { it.id })
        // My own DM by my name; a DM by the other person's username.
        assertEquals(listOf("notes"), Jump.conversations("toru", channels, me, title, userNames, now).map { it.id })
        assertEquals(listOf("group"), Jump.conversations("ali", channels, me, title, userNames, now).map { it.id })
        assertEquals(listOf("加納 透", "toru"), Jump.names(channels[6], me, userNames))
        assertEquals(emptyList<ChannelState>(), Jump.conversations("  ", channels, me, title, userNames, now))
        // At most 20.
        val many = (1..25).map { channel("team-$it") }
        assertEquals(Jump.MAX_CONVERSATIONS, Jump.conversations("team", many, me, title, userNames, now).size)
    }

    @Test
    fun peopleMatchDisplayNamesAndUsernamesNotTheDeactivated() {
        assertEquals(listOf("gen"), Jump.people("gen", users).map { it.id })
        assertEquals(listOf(me), Jump.people("加納", users).map { it.id })
        assertEquals(listOf("alice"), Jump.people("smith", users).map { it.id })
        val many = (1..15).map { user("u$it", "Tanaka $it") }
        assertEquals(Jump.MAX_PEOPLE, Jump.people("tanaka", many).size)
    }

    @Test
    fun theNewMessagePickerListsMyChannelsThenJoinableOnesThenPeople() {
        val channels = listOf(
            channel("random"),
            channel("general"),
            channel("secret", "private"),
            channel("gardening", member = false),
            channel("hidden", "private", member = false),
            channel("old", archived = true),
            channel("dm-gen", "dm", users = listOf(me, "gen")),
        )
        val empty = Jump.destinations("", channels, users, me, now)
        assertEquals(listOf("general", "random", "secret"), empty.channels.map { it.id })
        assertEquals(listOf("gardening"), empty.joinable.map { it.id })
        assertEquals(listOf(me, "alice", "gen"), empty.people.map { it.id }) // me first, the deactivated never
        val typed = Jump.destinations("g", channels, users, me, now)
        assertEquals(listOf("general"), typed.channels.map { it.id })
        assertEquals(listOf("gardening"), typed.joinable.map { it.id })
        assertEquals(listOf("gen"), typed.people.map { it.id })
    }

    @Test
    fun aPickedConversationClosesTheJumpScreenAndLandsOnItsTab() {
        // The jump screen over the home list, with results behind a re-opened box.
        val jumping = MainTabs.withStack(MainTabs.initial, MainTab.HOME, MainNav.openJump(MainNav.root))
        assertEquals(Route.Search(jump = true), MainNav.top(MainTabs.stack(jumping)))
        assertFalse(MainTabs.barShown(MainTabs.stack(jumping))) // full screen
        // A channel: the home tab shows it over its list (back returns to the list, not to the jump screen).
        val channel = MainTabs.landFromHome(jumping, MainTab.HOME, "general")
        assertEquals(listOf(Route.ChannelList, Route.Channel("general")), MainTabs.stack(channel, MainTab.HOME))
        assertEquals(MainTab.HOME, channel.selected)
        // A DM: the DM tab, and the home tab is back at its list.
        val withResults = MainTabs.update(jumping) { MainNav.runSearch(it, SearchParams(q = "x")) }
        val dm = MainTabs.landFromHome(withResults, MainTab.DM, "dm-1")
        assertEquals(MainTab.DM, dm.selected)
        assertEquals(listOf(Route.DmList, Route.Channel("dm-1")), MainTabs.stack(dm, MainTab.DM))
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(dm, MainTab.HOME))
        // The jump flag survives saving (a rotation) and a search run from it.
        assertEquals(MainTabs.stack(withResults), MainNav.decode(MainNav.encode(MainTabs.stack(withResults))))
        assertEquals(Route.Search(SearchParams(q = "x"), expanded = false, jump = true), MainNav.top(MainTabs.stack(withResults)))
        // Back closes it.
        assertEquals(MainNav.root, MainNav.back(MainNav.openJump(MainNav.root)))
    }
}
