package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.NotificationLevels
import java.time.Instant

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
            favorites = all.filter { it.isMember && !it.channel.archived && starred(it) && keep(it) }.sortedBy { it.channel.name ?: it.channel.lastMessageAt ?: "" },
            custom = sidebar.map { section ->
                val members = all.filter { it.isMember && !it.channel.archived && !starred(it) && keep(it) && placed[it.id] == section.id }
                section to (members.filter { !it.channel.isDm }.sortedBy { it.channel.name ?: "" } + members.filter { it.channel.isDm }.sortedByDescending { it.channel.lastMessageAt ?: "" })
            },
            channels = all.filter { it.isMember && !it.channel.isDm && !it.channel.isTimes && !it.channel.archived && loose(it) && keep(it) }.sortedBy { it.channel.name ?: "" },
            times = all.filter { it.isMember && it.channel.isTimes && !it.channel.archived && loose(it) && keep(it) }
                .sortedWith(compareBy<ChannelState> { it.channel.timesOwnerId != meId }.thenBy { it.channel.name ?: "" }),
            dms = all.filter { it.isMember && it.channel.isDm && loose(it) && keep(it) }
                .sortedWith(compareByDescending<ChannelState> { MainTabs.isSelfNotes(it, meId) }.thenByDescending { it.channel.lastMessageAt ?: "" }),
            browse = all.filter { !it.isMember && !it.channel.archived }.sortedBy { it.channel.name ?: "" },
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
enum class HomeTile(val label: String) {
    THREADS("スレッド"),
    /** L8 (TIMES_FEED.md §7): the Times feed, after スレッド; no number (the feed is read, never marked read by looking). */
    TIMES("Times"),
    DRAFTS("下書き"),
    SAVED("保存"),
    REMINDERS("リマインダー"),
    /** M52 (CALENDAR.md §7): the calendar, next to リマインダー; no number. */
    CALENDAR("カレンダー"),
    /** M56 (TASKS.md §6): 「自分のタスク」 and 「自分の担当」, next to カレンダー; no number. */
    TASKS("タスク"),
    FILES("ファイル"),
    /** M78 (CANVAS.md §21.2): the canvases of all my conversations, after ファイル (as the desktop's sidebar); no number. */
    CANVASES("キャンバス"),
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
    fun tiles(threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int): List<TileState> = listOf(
        TileState(HomeTile.THREADS, threads.unreadCount, alert = threads.unreadCount > 0 && threads.mentionCount > 0),
        TileState(HomeTile.TIMES, null),
        TileState(HomeTile.DRAFTS, drafts),
        TileState(HomeTile.SAVED, saved),
        TileState(HomeTile.REMINDERS, firedReminders, alert = firedReminders > 0),
        TileState(HomeTile.CALENDAR, null),
        TileState(HomeTile.TASKS, null),
        TileState(HomeTile.FILES, null),
        TileState(HomeTile.CANVASES, null),
    )

    /** What TalkBack reads for a tile. */
    fun description(state: TileState): String {
        val count = state.count ?: return state.tile.label
        val number = when (state.tile) {
            HomeTile.THREADS -> "未読 $count 件"
            HomeTile.REMINDERS -> "通知済み $count 件"
            else -> "$count 件"
        }
        return "${state.tile.label}、$number" + if (state.alert && state.tile == HomeTile.THREADS) "、メンションあり" else ""
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
