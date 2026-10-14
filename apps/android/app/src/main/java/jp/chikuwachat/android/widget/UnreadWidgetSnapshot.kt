package jp.chikuwachat.android.widget

import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.Channels
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant

/**
 * The 未読・メンション home-screen widget's data: the app icon's number for the workspace on screen, by the app's own
 * rule (SYNC_PROTOCOL.md §10.5 `badge(c)`, [Channels.badgeCount]: mentions in channels, every unread message in DMs, a
 * muted conversation's mentions only; Times are channels, so their quiet unread counts only with a mention), split into
 * channels' mentions and DMs' unread, and the conversations that make it up. Names and counts only, never a message.
 *
 * Written by the app from its store whenever the numbers change (the bootstrap at launch and after reconnecting, live
 * events, my own reads), and from a push while the workspace is not live in the app ([UnreadWidgetRules.pushed]).
 */
@Serializable
data class UnreadWidgetSnapshot(
    val serverUrl: String,
    val workspaceName: String,
    val meId: String,
    /** Mentions in channels (muted ones included), the 「メンション」 part. */
    val mentions: Int = 0,
    /** Unread messages in DMs and group DMs (a muted one: its mentions), the 「DM」 part. */
    val dms: Int = 0,
    /** The conversations with a number, newest message first (at most [UnreadWidgetRules.MAX_ROWS]). */
    val rows: List<UnreadRow> = emptyList(),
    /** How many conversations have a number (rows may hold fewer). */
    val conversations: Int = 0,
    /**
     * The names of the people in my DMs (and mine, for my own DM), so a push for a DM this snapshot did not list yet can
     * still be named without the store.
     */
    val people: Map<String, String> = emptyMap(),
    /** The server's own total from the last push (PUSH_NOTIFICATIONS.md §4.2) while the app was not live; null otherwise. */
    val pushedTotal: Int? = null,
    /** When this was written (epoch ms). */
    val updatedAt: Long = 0,
) {
    /** The widget's number: the server's from a push when newer than the app's sync, else the app's own count. */
    val total: Int get() = pushedTotal ?: (mentions + dms)

    /** Whether 「@n・DM n」 adds up to [total] (a summary's number alone does not say how it splits). */
    val partsKnown: Boolean get() = pushedTotal == null || pushedTotal == mentions + dms
}

/** One conversation's line: its name (`#name`, or the other people for a DM) and its number. */
@Serializable
data class UnreadRow(
    val channelId: String,
    val title: String,
    val count: Int,
    val dm: Boolean,
    /** The newest message's time (ISO), the order; null when not known. */
    val lastAt: String? = null,
    /** A 1:1 DM: the other person (their avatar's colour); null otherwise or not known. */
    val userId: String? = null,
    /** A group DM (drawn with the people icon). */
    val group: Boolean = false,
)

object UnreadWidgetRules {
    /** The rows a snapshot keeps (the tallest widget shows fewer). */
    const val MAX_ROWS = 12

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    fun encode(snapshot: UnreadWidgetSnapshot): String = json.encodeToString(UnreadWidgetSnapshot.serializer(), snapshot)

    fun decode(text: String?): UnreadWidgetSnapshot? =
        text?.takeIf { it.isNotBlank() }?.let { runCatching { json.decodeFromString(UnreadWidgetSnapshot.serializer(), it) }.getOrNull() }

    fun same(a: UnreadWidgetSnapshot?, b: UnreadWidgetSnapshot?): Boolean = a?.copy(updatedAt = 0) == b?.copy(updatedAt = 0)

    /** A conversation the number counts: one I am in, not an archived channel (the server's `GET /sync/summary` rule). */
    fun counted(channel: ChannelState): Boolean = channel.isMember && (channel.channel.isDm || !channel.channel.archived)

    /**
     * The snapshot of a workspace's conversations as the app holds them. [title] names a conversation as the app's lists
     * do; [people] are the names of my DMs' people (and me).
     */
    fun snapshot(
        serverUrl: String, workspaceName: String, meId: String, channels: Collection<ChannelState>,
        title: (ChannelState) -> String, people: Map<String, String>, now: Instant = Instant.now(),
    ): UnreadWidgetSnapshot {
        var mentions = 0
        var dms = 0
        val rows = ArrayList<UnreadRow>()
        for (channel in channels) {
            if (!counted(channel)) continue
            val count = Channels.badgeCount(channel, now)
            if (count <= 0) continue
            if (channel.channel.isDm) dms += count else mentions += count
            // A 1:1 DM's other person (my own DM: me) for the row's face; unknown without the member list.
            val other = if (channel.channel.type == "dm") channel.channel.dmUserIds?.let { ids -> ids.firstOrNull { it != meId } ?: ids.firstOrNull() } else null
            rows += UnreadRow(
                channel.id, title(channel), count, channel.channel.isDm, channel.channel.lastMessageAt,
                userId = other, group = channel.channel.type == "group_dm",
            )
        }
        val ordered = rows.sortedWith(rowOrder)
        return UnreadWidgetSnapshot(
            serverUrl = serverUrl, workspaceName = workspaceName, meId = meId, mentions = mentions, dms = dms,
            rows = ordered.take(MAX_ROWS), conversations = ordered.size, people = people,
        )
    }

    /** Newest message first (as the app's 「未読」 section), then by name, then id. */
    val rowOrder: Comparator<UnreadRow> = compareByDescending<UnreadRow> { it.lastAt ?: "" }.thenBy { it.title }.thenBy { it.channelId }

    /** The names a snapshot keeps: the people of my DMs and group DMs, and me. */
    fun people(channels: Collection<ChannelState>, meId: String, name: (String) -> String?): Map<String, String> {
        val ids = LinkedHashSet<String>()
        ids += meId
        channels.forEach { if (it.isMember && it.channel.isDm) ids += it.channel.dmUserIds.orEmpty() }
        return ids.mapNotNull { id -> name(id)?.takeIf { it.isNotBlank() }?.let { id to it } }.toMap()
    }

    /**
     * A push for this workspace while the app is not live there (PUSH_NOTIFICATIONS.md §4.2, §9): the number becomes
     * the server's own `badge`, and a message's conversation moves to the top. A DM's message counts one more there; a
     * channel's counts only when the server's number grew (a level-「すべて」 channel's push is not a mention). The app's
     * next sync replaces all of it with the exact rows. Null when it changes nothing.
     */
    fun pushed(old: UnreadWidgetSnapshot, push: PushMessage, now: Long): UnreadWidgetSnapshot? {
        val badge = push.badge
        var next = old
        val before = old.total
        if (badge != null) next = next.copy(pushedTotal = badge)
        val channelId = push.channelId
        if (push.kind == "message" && channelId != null) {
            val dm = push.channelType == "dm" || push.channelType == "group_dm"
            val grew = badge == null || badge > before
            if (dm || grew) {
                val held = old.rows.firstOrNull { it.channelId == channelId }
                val title = held?.title ?: pushTitle(push, dm)
                val row = UnreadRow(
                    channelId, title, (held?.count ?: 0) + 1, held?.dm ?: dm, Instant.ofEpochMilli(now).toString(),
                    userId = held?.userId ?: push.senderId.takeIf { push.channelType == "dm" },
                    group = held?.group ?: (push.channelType == "group_dm"),
                )
                val rows = (listOf(row) + old.rows.filter { it.channelId != channelId }).take(MAX_ROWS)
                next = next.copy(
                    rows = rows,
                    conversations = old.conversations + if (held == null) 1 else 0,
                    mentions = old.mentions + if (row.dm) 0 else 1,
                    dms = old.dms + if (row.dm) 1 else 0,
                )
            }
        }
        if (next == old) return null
        return next.copy(updatedAt = now)
    }

    /**
     * GET /sync/summary of a workspace that is not on screen (the app's switcher reads it when the app comes back, the
     * widgets' refresh every so often): its `badge` becomes the number. 0 clears the rows (nothing is waiting); another
     * number keeps the last known rows (the summary does not list conversations; the app's next sync there does). With
     * no snapshot yet (a widget chose a workspace the app has not opened since), one with the number alone.
     */
    fun summarized(old: UnreadWidgetSnapshot?, serverUrl: String, workspaceName: String, meId: String, badge: Int, now: Long): UnreadWidgetSnapshot {
        val base = old?.takeIf { it.meId == meId } ?: UnreadWidgetSnapshot(serverUrl, workspaceName, meId)
        val named = base.copy(workspaceName = workspaceName.ifBlank { base.workspaceName })
        val next = if (badge <= 0) named.copy(mentions = 0, dms = 0, rows = emptyList(), conversations = 0, pushedTotal = null)
        else named.copy(pushedTotal = badge.takeIf { it != named.mentions + named.dms })
        return if (old != null && next == old) old else next.copy(updatedAt = now)
    }

    /** A conversation the snapshot did not list yet, named from the push: the sender for a 1:1 DM, else the title. */
    private fun pushTitle(push: PushMessage, dm: Boolean): String {
        val title = push.title.takeIf { it.isNotBlank() }
        return when {
            dm && push.channelType == "dm" -> push.senderName ?: title ?: "…"
            else -> title ?: push.subtitle ?: "…"
        }
    }

    /** At most this many rows fit [heightDp] (after [usedDp] for the header), each [rowDp] tall; at least 0. */
    fun rowsThatFit(heightDp: Float, usedDp: Float, rowDp: Float, max: Int): Int =
        ((heightDp - usedDp) / rowDp).toInt().coerceIn(0, max)

    /** The widget's number as drawn: 「99+」 past 99. */
    fun countText(count: Int): String = if (count > 99) "99+" else count.toString()
}
