package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.NavItem
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.NotificationLevels
import java.time.Instant
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** Channel-list rules shared by the list, the badge and notifications (Slack / Mattermost conventions). */
object Channels {
    /**
     * The channel's own level "none", muted until unmuted (M35) or an active timed mute (SYNC_PROTOCOL.md §10.5). The
     * overall setting (M35) is not part of it: it only decides pushes.
     */
    fun isMuted(channel: ChannelState, now: Instant = Instant.now()): Boolean = NotificationLevels.isMuted(channel, now)

    /**
     * M24: someone else's times that I have not set to level "all" (its own level, M35) is quiet unread: unread only with a mention, a faint
     * dot otherwise (SYNC_PROTOCOL.md §10.5; the vectors in apps/shared/unread-rules.json). A mute takes precedence.
     */
    fun isQuiet(channel: ChannelState, meId: String?, now: Instant = Instant.now()): Boolean {
        val owner = channel.channel.timesOwnerId ?: return false
        return owner != meId && NotificationLevels.own(channel) != NotificationLevels.ALL && !isMuted(channel, now)
    }

    /**
     * Bold, the unread filter and the like (§10.5): a muted or quiet conversation is unread only when I am mentioned.
     * `meId` is who is looking: my own times is an ordinary channel.
     */
    fun hasUnread(channel: ChannelState, meId: String?, now: Instant = Instant.now()): Boolean =
        channel.isMember && if (isMuted(channel, now) || isQuiet(channel, meId, now)) channel.mentionCount > 0 else channel.unreadCount > 0

    /** M24: the faint dot of a quiet row with new posts but no mention (a muted row shows nothing). */
    fun showsQuietDot(channel: ChannelState, meId: String?, now: Instant = Instant.now()): Boolean =
        channel.isMember && channel.unreadCount > 0 && isQuiet(channel, meId, now) && !hasUnread(channel, meId, now)

    /** Badge number: mentions for channels and muted conversations, every message for DMs (quiet rows too: they are channels). */
    fun badgeCount(channel: ChannelState, now: Instant = Instant.now()): Int = when {
        isMuted(channel, now) -> channel.mentionCount
        channel.channel.isDm -> channel.unreadCount
        else -> channel.mentionCount
    }

    data class Sections(
        val channels: List<ChannelState>,
        val dms: List<ChannelState>,
        val browse: List<ChannelState>,
        /** Starred conversations (M12a); left out of every other section. */
        val favorites: List<ChannelState> = emptyList(),
        /** My own sections (M14f), in order; their conversations are left out of `channels` / `dms`. */
        val custom: List<Pair<SidebarSectionOut, List<ChannelState>>> = emptyList(),
        /** M24: times channels I am in, mine first, then by name; left out of `channels`. */
        val times: List<ChannelState> = emptyList(),
        /** M37: with 「未読をまとめる」, every unread conversation (DMs too), newest first; left out of every other section. */
        val unread: List<ChannelState> = emptyList(),
    ) {
        /**
         * 仕上げ A (MOBILE_POLISH.md H3): the home shows 「未読」 only with something in it (as iOS), not an empty section
         * with 「未読の会話はありません」.
         */
        val unreadShown: Boolean get() = unread.isNotEmpty()
    }

    /**
     * List order: [unread (M37, with `groupUnread`)], favorites, channels by name, times (M24), DMs by recency (my own DM
     * first), joinable channels by name. `meId` decides which times is mine (first, and never quiet) and which DM is my
     * own. M37: 「未読をまとめる」 replaced the 「未読のみ」 filter: nothing is hidden, the unread rows move to the top.
     */
    fun sections(
        all: Collection<ChannelState>,
        groupUnread: Boolean = false,
        now: Instant = Instant.now(),
        favorites: Set<String> = emptySet(),
        sidebar: List<SidebarSectionOut> = emptyList(),
        meId: String? = null,
    ): Sections {
        fun live(channel: ChannelState) = channel.isMember && (channel.channel.isDm || !channel.channel.archived)
        fun grouped(channel: ChannelState) = groupUnread && live(channel) && hasUnread(channel, meId, now)
        fun keep(channel: ChannelState) = !grouped(channel)
        fun starred(channel: ChannelState) = channel.id in favorites
        val placed = HashMap<String, String>()
        sidebar.forEach { section -> section.channelIds.forEach { placed[it] = section.id } }
        fun loose(channel: ChannelState) = !starred(channel) && channel.id !in placed
        return Sections(
            unread = all.filter { grouped(it) }
                .sortedWith(compareByDescending<ChannelState> { it.channel.lastMessageAt ?: "" }.thenBy { it.channel.name ?: "" }.thenBy { it.id }),
            favorites = SidebarOrder.section(all.filter { it.isMember && !it.channel.archived && starred(it) && keep(it) }),
            custom = sidebar.map { section ->
                section to SidebarOrder.section(all.filter { it.isMember && !it.channel.archived && !starred(it) && keep(it) && placed[it.id] == section.id })
            },
            channels = all.filter { it.isMember && !it.channel.isDm && !it.channel.isTimes && !it.channel.archived && loose(it) && keep(it) }.sortedWith(SidebarOrder.byName),
            times = all.filter { it.isMember && it.channel.isTimes && !it.channel.archived && loose(it) && keep(it) }
                .sortedWith(compareBy<ChannelState> { it.channel.timesOwnerId != meId }.then(SidebarOrder.byName)),
            dms = all.filter { it.isMember && it.channel.isDm && loose(it) && keep(it) }
                .sortedWith(compareByDescending<ChannelState> { MainTabs.isSelfNotes(it, meId) }.then(SidebarOrder.newestFirst)),
            browse = all.filter { !it.isMember && !it.channel.archived }.sortedWith(SidebarOrder.byName),
        )
    }

    /** M26 (Slack): a folded section still shows what is unread, and the open conversation. */
    fun shown(rows: List<ChannelState>, collapsed: Boolean, meId: String?, currentId: String? = null, now: Instant = Instant.now()): List<ChannelState> =
        if (!collapsed) rows else rows.filter { it.id == currentId || hasUnread(it, meId, now) }

    /** M37: the DMs the home list shows besides my own. */
    const val HOME_DMS = 5

    /** The home's 「ダイレクトメッセージ」 section: its rows, and whether 「すべての DM」 leads to the ones left out. */
    data class DmSection(val rows: List<ChannelState>, val more: Boolean)

    /**
     * M37 (MOBILE_UI.md §6.1): my own DM first, then the [HOME_DMS] newest of the others (`dms` as [sections] orders
     * them). An older one that is unread still shows (unread is never hidden, as in a folded section); `more` when some
     * are left out, for 「すべての DM」 (the DM tab).
     */
    fun dmSection(dms: List<ChannelState>, meId: String?, now: Instant = Instant.now(), limit: Int = HOME_DMS): DmSection {
        val (self, others) = dms.partition { MainTabs.isSelfNotes(it, meId) }
        val newest = others.take(limit)
        val olderUnread = others.drop(limit).filter { hasUnread(it, meId, now) }
        return DmSection(self + newest + olderUnread, more = others.size > newest.size + olderUnread.size)
    }
}

/**
 * DATA_MODEL.md sidebar_sections 「セクションの中の並び順」: the order inside a section, the same as the desktop's and iOS's
 * (apps/shared/sidebar-order.json). The server keeps no order inside a section.
 */
object SidebarOrder {
    /**
     * The name after NFKC, A-Z lower-cased and katakana folded to hiragana, compared by UTF-16 code unit (String.compareTo);
     * no Collator: locale collation differs per platform.
     */
    fun key(name: String): String {
        val normalized = java.text.Normalizer.normalize(name, java.text.Normalizer.Form.NFKC)
        val out = StringBuilder(normalized.length)
        for (ch in normalized) {
            out.append(
                when (ch) {
                    in 'A'..'Z' -> ch + 0x20
                    in '\u30A1'..'\u30F6' -> ch - 0x60
                    else -> ch
                },
            )
        }
        return out.toString()
    }

    /** Two names by [key], equal keys by the raw names. */
    val names: Comparator<String> = compareBy<String> { key(it) }.thenBy { it }

    /** Channels by name, then by id. */
    val byName: Comparator<ChannelState> = Comparator<ChannelState> { a, b -> names.compare(a.channel.name ?: "", b.channel.name ?: "") }.thenBy { it.id }

    /** DMs newest first: the last message, else when the DM was made (the server's text), then by id. */
    val newestFirst: Comparator<ChannelState> =
        compareByDescending<ChannelState> { it.channel.lastMessageAt ?: it.channel.createdAt }.thenBy { it.id }

    /** Favorites and my own sections: their channels by name, then their DMs newest first. */
    fun section(rows: List<ChannelState>): List<ChannelState> =
        rows.filter { !it.channel.isDm }.sortedWith(byName) + rows.filter { it.channel.isDm }.sortedWith(newestFirst)
}

/** M37: 「未読をまとめる」 (replacing M28c's 「未読のみ」 filter) as it was left on this device; off at first. */
object GroupUnread {
    private const val KEY = "sidebar.groupUnread"

    /** The filter it replaced; forgotten at the first write. */
    private const val OLD_KEY = "sidebar.unreadOnly"

    fun read(store: KeyValueStore): Boolean = store.getString(KEY) == "1"

    fun write(store: KeyValueStore, on: Boolean) {
        store.putString(KEY, if (on) "1" else null)
        store.putString(OLD_KEY, null)
    }
}

/** M37 (MOBILE_UI.md §6.1): the home's tiles, in the row's order. */
enum class HomeTile(private val labelRes: Int?) {
    THREADS(R.string.home_tile_threads),
    /** L8 (TIMES_FEED.md §7): the Times feed, after スレッド; no number (the feed is read, never marked read by looking). */
    TIMES(null),
    DRAFTS(R.string.common_drafts),
    SAVED(R.string.home_tile_saved),
    REMINDERS(R.string.common_reminders),
    /** M52 (CALENDAR.md §7): the calendar, next to リマインダー; no number. */
    CALENDAR(R.string.common_calendar),
    /** M56 (TASKS.md §6): 「自分のタスク」 and 「自分の担当」, next to カレンダー; no number. */
    TASKS(R.string.common_tasks),
    /** M86 (DEADLINES.md §8 3.): my channels' deadlines (今週 / 今月 / それ以降 / 過ぎたもの), next to タスク; no number. */
    DEADLINES(R.string.common_deadlines),
    /** M112 (RESERVATIONS.md §6): the workspace's reservation pools, after 締切; the to-dos due in the pools I operate. */
    RESERVATIONS(R.string.common_reservations),
    FILES(R.string.common_files),
    /** M78 (CANVAS.md §21.2): the canvases of all my conversations, after ファイル (as the desktop's sidebar); no number. */
    CANVASES(R.string.home_tile_canvases),
    ;

    /** The tile's name; 「Times」 is the same in every language. */
    val label: String get() = labelRes?.let { L10n.str(it) } ?: "Times"

    /** M111: the key in apps/shared/nav-items.json (UserMe.nav_items). */
    val navKey: String get() = if (this == TIMES) "times-feed" else name.lowercase()
}

/** A tile's number (null: none shown), red when `alert`; a 0 is dimmed but still opens its list. */
data class TileState(val tile: HomeTile, val count: Int?, val alert: Boolean = false) {
    val dimmed: Boolean get() = count == 0
}

object HomeTiles {
    /**
     * The badge rules of the rows they replaced (§6.1): スレッド the followed threads' unread count, red with a mention;
     * 下書き the drafts and scheduled messages; 保存 the saved messages; リマインダー the fired ones, red; ファイル no number.
     */
    /** M111: in my order without the ones I hid (UserMe.nav_items, [NavItems]); null = the defaults (all, this order). */
    fun tiles(
        threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int, navItems: List<NavItem>?, reservations: ReservationTile? = null,
    ): List<TileState> {
        val byKey = tiles(threads, drafts, saved, firedReminders, reservations).associateBy { it.tile.navKey }
        return NavItems.tileKeys(navItems).mapNotNull { byKey[it] }
    }

    /** M112: 予約 once the server answered the pools: the to-dos due (shown only for an operator, red when any). */
    data class ReservationTile(val todos: Int, val operates: Boolean)

    fun tiles(threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int, reservations: ReservationTile? = null): List<TileState> {
        val row = base(threads, drafts, saved, firedReminders).toMutableList()
        if (reservations != null) {
            val at = row.indexOfFirst { it.tile == HomeTile.DEADLINES }
            row.add(at + 1, TileState(HomeTile.RESERVATIONS, if (reservations.operates) reservations.todos else null, alert = reservations.todos > 0))
        }
        return row
    }

    private fun base(threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int): List<TileState> = listOf(
        TileState(HomeTile.THREADS, threads.unreadCount, alert = threads.unreadCount > 0 && threads.mentionCount > 0),
        TileState(HomeTile.TIMES, null),
        TileState(HomeTile.DRAFTS, drafts),
        TileState(HomeTile.SAVED, saved),
        TileState(HomeTile.REMINDERS, firedReminders, alert = firedReminders > 0),
        TileState(HomeTile.CALENDAR, null),
        TileState(HomeTile.TASKS, null),
        TileState(HomeTile.DEADLINES, null),
        TileState(HomeTile.FILES, null),
        TileState(HomeTile.CANVASES, null),
    )

    /** What TalkBack reads for a tile. */
    fun description(state: TileState): String {
        val count = state.count ?: return state.tile.label
        val number = when (state.tile) {
            HomeTile.THREADS -> L10n.str(R.string.common_unread_2, count)
            HomeTile.REMINDERS -> L10n.str(R.string.channels_notified, count)
            HomeTile.RESERVATIONS -> L10n.str(R.string.channels_operator_tasks, count)
            else -> L10n.str(R.string.common_count_items, count)
        }
        return L10n.str(R.string.common_pair, state.tile.label, number) + if (state.alert && state.tile == HomeTile.THREADS) L10n.str(R.string.common_has_mentions) else ""
    }
}

/**
 * M26: which default sections (favorites, channels, times, dms) are folded on this device. My own sections fold on all
 * my devices through the server (`SidebarSectionOut.collapsed`); these are a per-device convenience, like the web's.
 */
object FoldedSections {
    private const val KEY = "sidebar.folded"
    const val FAVORITES = "favorites"
    const val CHANNELS = "channels"
    const val TIMES = "times"
    const val DMS = "dms"

    fun read(store: KeyValueStore): Set<String> = store.getString(KEY)?.split("\n")?.filter { it.isNotEmpty() }?.toSet() ?: emptySet()

    /** Folds `key` if it is open, opens it if it is folded; returns the new set. */
    fun toggle(store: KeyValueStore, key: String): Set<String> {
        val next = read(store).let { if (key in it) it - key else it + key }
        store.putString(KEY, next.sorted().joinToString("\n").ifEmpty { null })
        return next
    }
}
