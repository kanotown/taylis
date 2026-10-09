package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZonedDateTime
import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.ActivityListOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ActivityRules
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.ThreadEntry
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/**
 * M39: what an activity row says (MOBILE_UI.md §6.4), as pure functions (tested in ActivityTest). `name` gives a user's
 * display name (null when unknown).
 */
object ActivityText {
    /** Who did it: 「佐藤」, or 「佐藤 ほか 2 人」 when several reacted. */
    fun actors(ids: List<String>, name: (String) -> String?): String {
        val first = ids.firstOrNull()?.let(name) ?: L10n.str(R.string.activity_screen_someone)
        return if (ids.size > 1) L10n.str(R.string.activity_screen_and_others, first, ids.size - 1) else first
    }

    /** The headline before a reaction's emoji (which the row draws, a custom one as its picture). */
    fun lead(item: ActivityItem, name: (String) -> String?): String {
        // 「佐藤 が」 but 「佐藤 ほか 2 人が」 (MOBILE_UI.md §6.4).
        // M112: a reservation notice — the pool, and whether it is a to-do (an operator's) or news of my own reservation.
        item.reservation?.let { return it.poolName.ifEmpty { L10n.str(R.string.common_reservations) } + if (it.operator) L10n.str(R.string.activity_screen_operator_task) else L10n.str(R.string.activity_screen_reservation) }
        // M122 (docs/WIKI.md §9.3): 「佐藤 が「題名」であなたをメンションしました」 / 「佐藤 が「題名」を共有しました」.
        item.page?.let { page ->
            val title = page.title.ifBlank { L10n.str(R.string.docs_untitled) }
            val actor = actors(item.actorIds, name)
            return if (item.kind == "page_shared") L10n.str(R.string.docs_shared_with_you, actor, title) else L10n.str(R.string.docs_mentioned_you, actor, title)
        }
        val who = actors(item.actorIds, name) + if (item.actorIds.size > 1) "" else " "
        return when (item.kind) {
            "mention" -> L10n.str(R.string.activity_screen_mentioned_you, who)
            "thread_reply" -> L10n.str(R.string.activity_screen_replied_in_a_thread, who)
            "reaction" -> L10n.str(R.string.activity_screen_reacted, who)
            "canvas_mention" -> L10n.str(R.string.activity_screen_mentioned_you_in_canvas, who, item.canvas?.title ?: L10n.str(R.string.common_canvas))
            else -> who.trim()
        }
    }

    /** The conversation the item is in (a message's, or the canvas's). */
    fun channelId(item: ActivityItem): String? = item.message?.channelId ?: item.canvas?.channelId

    /** The second line: the conversation (「#一般」 / a DM's names), 「#一般 のキャンバス」 for a canvas item (M77). */
    fun where(item: ActivityItem, conversation: String): String = when {
        item.page != null -> L10n.str(R.string.docs_activity_where) // M122: a page belongs to no conversation
        conversation.isEmpty() -> ""
        item.kind == "canvas_mention" -> L10n.str(R.string.activity_screen_canvas_in, conversation)
        else -> conversation
    }

    /** TalkBack for a canvas row (CANVAS.md §20.5): 「未読 佐藤 が「題名」であなたをメンションしました、#一般」. */
    fun spokenCanvas(item: ActivityItem, name: (String) -> String?, conversation: String, unread: Boolean): String =
        (if (unread) L10n.str(R.string.activity_screen_unread) else "") + lead(item, name) + (if (conversation.isNotEmpty()) L10n.str(R.string.common_comma_then, conversation) else "")

    /** Where a tapped row goes: its message (a reply in its thread), or a canvas item's canvas (M77). */
    fun target(item: ActivityItem): ActivityTarget? {
        if (item.reservation != null) return ActivityTarget.Reservations
        item.canvas?.takeIf { item.kind == "canvas_mention" }?.let { return ActivityTarget.Canvas(it.channelId, it.canvasId) }
        item.page?.let { return ActivityTarget.Page(it.pageId) } // M122
        return item.message?.let { ActivityTarget.Message(it) }
    }

    /** 「佐藤 がメンション」 / 「佐藤 ほか 2 人が 👍🎉」 / 「佐藤 がスレッドに返信」. */
    fun headline(item: ActivityItem, name: (String) -> String?): String =
        if (item.kind == "reaction") lead(item, name) + " " + item.emojis.joinToString("") else lead(item, name)

    /** The header's count (MOBILE_UI.md §6.4): 「未読 3 件」, 「未読 99+ 件」 from 99, 「未読はありません」 at 0. */
    fun unreadLabel(count: Int): String =
        if (count <= 0) L10n.str(R.string.activity_screen_no_unread)
        else L10n.str(R.string.activity_screen_unread_count, if (count >= 99) "99+" else count.toString())

    /** The newest item's time (「すべて既読にする」 reads at least this far: [ActivityRules.markAllAt]). */
    fun newestAt(items: List<ActivityItem>): String? =
        items.mapNotNull { item -> ActivityRules.parse(item.at)?.let { item.at to it } }.maxByOrNull { it.second }?.first

    /**
     * A first page read again (a new item, a reconnect) over the rows already shown: the page's rows first, then the
     * older ones it did not reach (paged in before). A page that is the whole list (no cursor) replaces them.
     */
    fun merge(shown: List<ActivityItem>, page: List<ActivityItem>, pageIsWhole: Boolean): List<ActivityItem> {
        if (pageIsWhole) return page
        val keys = page.map { it.key }.toSet()
        val oldest = page.lastOrNull()?.let { ActivityRules.parse(it.at) } ?: return page
        return page + shown.filter { it.key !in keys && ActivityRules.parse(it.at)?.isBefore(oldest) == true }
    }

    /**
     * Review v0.1.22 (CANVAS.md §20.8): a row's third line. A canvas item's excerpt, empty once the server blanked it
     * (`blanked`: activity.updated's item_ids, for the rows shown before the list is read again); a message's line.
     * The row leaves the line out when it is empty.
     */
    fun excerpt(item: ActivityItem, blanked: Set<String>, messageLine: (MessageOut) -> String): String {
        item.reservation?.let { return it.text } // M112
        item.canvas?.takeIf { item.kind == "canvas_mention" }?.let { return if (it.itemId in blanked) "" else it.excerpt }
        item.page?.let { return if (it.itemId in blanked) "" else it.excerpt } // M122: a mention's line; a share has none
        return item.message?.let(messageLine) ?: ""
    }
}

/** What an activity row opens ([ActivityText.target]). */
sealed interface ActivityTarget {
    data class Message(val message: MessageOut) : ActivityTarget
    /** M77 (CANVAS.md §20.7): the canvas in its conversation's 「キャンバス」 tab, on the activity tab's stack. */
    data class Canvas(val channelId: String, val canvasId: String) : ActivityTarget
    /** M112: 「予約」. */
    data object Reservations : ActivityTarget
    /** M122 (docs/WIKI.md §9.3): a page of 「ドキュメント」, on the activity tab's stack. */
    data class Page(val pageId: String) : ActivityTarget
}

/**
 * The activity tab's list on screen: its rows, where the next page starts, and which rows show as unread. `list` reads a
 * page (GET /activity: filter, cursor); `onError` reports a failure. Loading the list never reads anything (MOBILE_UI.md
 * §6.4, 2026-10-07 「開いたら既読」): an item is read when opened ([unread]).
 */
internal class ActivityFeed(
    var trigger: Any?,
    private val list: suspend (filter: String, cursor: String?) -> Result<ActivityListOut>,
    private val onError: (Throwable) -> Unit = {},
) {
    var filter by mutableStateOf<String?>(null)
    var items by mutableStateOf<List<ActivityItem>?>(null)
    var cursor by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var failed by mutableStateOf(false)
    /** 「未読のみ」: the rows held, less the read ones (on this device only; a row opened goes from the list). */
    var unreadOnly by mutableStateOf(false)
    /** §6.4: the server sends `read` (since 2026-10-06), so items read in their conversation (or opened) lose the dot. */
    var conversationRule by mutableStateOf(false)
    /**
     * Rows the server said were read although newer than the page's read position (read in their conversation, or
     * opened) when their page came ([ActivityRules.readByServerInConversation]).
     */
    var readInConversation by mutableStateOf<Set<String>>(emptySet())

    /**
     * Whether the row shows as unread (bold, a dot, a tint): newer than the read position held now (the store's, which
     * 「すべて既読にする」 here or on another device moves), not opened since (here, or activity.items_read), not read in
     * its conversation (the server's flag, or the positions held here), and not a reservation to-do that is done.
     */
    fun unread(item: ActivityItem, store: Store): Boolean {
        val reservation = item.reservation
        if (reservation != null && (reservation.done || reservation.itemId in store.blankedActivityItems)) return false
        return ActivityRules.showsUnread(
            item, store.activity?.readAt, conversationRule,
            serverRead = item.key in readInConversation,
            readHere = ActivityRules.readInConversation(item, { store.channel(it)?.lastReadSeq }, { store.threadReadSeqs[it] }),
            openedAt = item.id?.let { store.openedActivityItems[it] },
        )
    }

    /** The rows to draw: all of them, or under 「未読のみ」 the unread ones. */
    fun shown(store: Store): List<ActivityItem>? = items?.let { rows -> if (unreadOnly) rows.filter { unread(it, store) } else rows }

    /** Takes a page's `read` flags, replacing those of its rows (of every row when [whole]). */
    private fun takeReads(page: ActivityListOut, whole: Boolean) {
        if (page.items.any { it.read != null }) conversationRule = true
        val keys = page.items.map { it.key }.toSet()
        val read = page.items.filter { ActivityRules.readByServerInConversation(it, page.readAt) }.map { it.key }
        readInConversation = (if (whole) emptySet() else readInConversation - keys) + read
    }

    suspend fun load(filter: String) {
        if (this.filter != filter) {
            this.filter = filter
            items = null
            cursor = null
        }
        loading = true
        list(filter, null).onSuccess { page ->
            if (this.filter != filter) return@onSuccess
            items = page.items
            cursor = page.nextCursor
            failed = false
            takeReads(page, whole = true)
        }.onFailure {
            if (this.filter == filter && items == null) failed = true
            onError(it)
        }
        loading = false
    }

    /** New rows on top of those shown (an event or a reconnect); quiet on failure (the rows shown stay). */
    suspend fun refresh() {
        val filter = filter ?: return
        val shown = items ?: return
        list(filter, null).onSuccess { page ->
            if (this.filter != filter) return@onSuccess
            val whole = page.nextCursor == null
            items = ActivityText.merge(items ?: shown, page.items, whole)
            takeReads(page, whole)
            if (whole) cursor = null
        }
    }

    suspend fun more() {
        val filter = filter ?: return
        val from = cursor ?: return
        if (loading) return
        loading = true
        list(filter, from).onSuccess { page ->
            if (this.filter != filter || cursor != from) return@onSuccess
            val keys = (items ?: emptyList()).map { it.key }.toSet()
            items = (items ?: emptyList()) + page.items.filter { it.key !in keys }
            cursor = page.nextCursor
            takeReads(page, whole = false)
        }.onFailure(onError)
        loading = false
    }
}

/**
 * The activity tab (MOBILE_UI.md §6.4). M39, stage B: the filter chips over GET /activity, newest first, paged as the
 * list scrolls, pull to refresh; a row shows who did what where and when, and opens its message (a reply in its thread).
 * Since 2026-10-07 (「開いたら既読」, like Slack) looking at the list reads nothing: an item stays unread (bold, a dot, a
 * tint; counted in the header's 「未読 n 件」 and the badge) until it is opened (a tap: PUT /activity/items/read), read
 * in its conversation (a mention, a reply), done (a reservation to-do), or the header's 「すべて既読にする」.
 *
 * M34, stage A, against a server before M39 (no `activity` in bootstrap): [メンション | スレッド] over the 「メンション」
 * and 「スレッド」 lists. A row opens its message or thread on this tab's stack.
 */
@Composable
fun ActivityScreen(
    controller: AppController,
    version: Int,
    segment: ActivitySegment,
    onSegment: (ActivitySegment) -> Unit,
    listState: LazyListState,
    mentionsState: LazyListState,
    threadsState: LazyListState,
    onOpenMessage: (MessageOut) -> Unit,
    onOpenThread: (ThreadEntry, jp.chikuwachat.android.sync.MessageState?) -> Unit,
    onOpenCanvas: (channelId: String, canvasId: String) -> Unit,
    /** A followed thread's conversation header: the conversation around the thread's parent. */
    onOpenThreadConversation: (ThreadEntry) -> Unit = {},
    /** M112: a reservation row opens 「予約」. */
    onOpenReservations: () -> Unit = {},
    /** M122: a page row (a mention in a page, a page shared with me) opens the page. */
    onOpenPage: (String) -> Unit = {},
) {
    val store = controller.store
    if (store.activity == null) {
        StageA(controller, version, segment, onSegment, mentionsState, threadsState, onOpenMessage, onOpenThread, onOpenThreadConversation)
        return
    }
    val online = controller.engineStatus == EngineStatus.ONLINE
    // A new item (an event) or a reconnect reads the first page again.
    val trigger = store.activityRevision to online
    val feed = remember {
        ActivityFeed(trigger, list = { filter, cursor -> controller.listActivity(filter, cursor) }, onError = { controller.error = controller.describe(it) })
    }
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(segment) { feed.load(segment.filter) }
    LaunchedEffect(trigger) {
        if (feed.trigger == trigger) return@LaunchedEffect
        feed.trigger = trigger
        if (!online || feed.filter != segment.filter) return@LaunchedEffect
        // The list keeps its first row in place when rows arrive above it; at the top, the new ones show instead.
        val atTop = listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0
        feed.refresh()
        if (atTop) listState.requestScrollToItem(0)
    }
    // §6.4: a read position moved back (read.updated "set"): items read in that conversation may be unread again.
    val reloads = store.activityReloads
    val shownReloads = remember { mutableIntStateOf(reloads) }
    LaunchedEffect(reloads) {
        if (shownReloads.intValue == reloads) return@LaunchedEffect
        shownReloads.intValue = reloads
        if (online && feed.filter == segment.filter) feed.load(segment.filter)
    }
    // The next page as the end of the list comes near.
    val nearEnd by remember(listState) {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf false
            last >= info.totalItemsCount - 4
        }
    }
    LaunchedEffect(nearEnd, feed.cursor) { if (nearEnd && feed.cursor != null) feed.more() }

    val now = remember(version) { ZonedDateTime.now() }
    val unreadCount = store.activity?.unreadCount ?: 0
    Column(Modifier.fillMaxSize()) {
        // 2026-10-07 (§6.4): 「未読 n 件」 and 「すべて既読にする」 (it replaced ⋮ 「すべて既読」).
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                ActivityText.unreadLabel(unreadCount), style = MaterialTheme.typography.labelLarge,
                fontWeight = if (unreadCount > 0) FontWeight.SemiBold else FontWeight.Normal,
                color = if (unreadCount > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            TextButton(
                enabled = unreadCount > 0,
                onClick = {
                    val at = ActivityRules.markAllAt(feed.items ?: emptyList(), Instant.now())
                    controller.scope.launch { controller.markActivityRead(at) }
                },
            ) {
                Icon(Icons.Default.DoneAll, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.activity_screen_mark_all_read))
            }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ActivitySegment.entries.forEach { value ->
                FilterChip(selected = value == segment, onClick = { if (value != segment) onSegment(value) }, label = { Text(value.label) })
            }
            // 「未読のみ」: the rows held, less the read ones (this device only).
            FilterChip(
                selected = feed.unreadOnly,
                onClick = { feed.unreadOnly = !feed.unreadOnly },
                label = { Text(stringResource(R.string.activity_screen_unread_only)) },
                leadingIcon = {
                    Box(Modifier.size(8.dp).background(if (feed.unreadOnly) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, CircleShape))
                },
            )
        }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    try {
                        feed.load(segment.filter)
                        controller.refreshActivity()
                    } finally { refreshing = false }
                }
            },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            val list = feed.shown(store)
            LazyColumn(Modifier.fillMaxSize(), state = listState) {
                when {
                    list == null && feed.failed -> item(key = "failed") {
                        Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(L10n.str(R.string.common_couldnt_load), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            TextButton(onClick = { scope.launch { feed.load(segment.filter) } }) { Text(L10n.str(R.string.common_reload)) }
                        }
                    }
                    list == null -> item(key = "loading") { Text(L10n.str(R.string.common_loading), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    list.isEmpty() && feed.unreadOnly && feed.cursor == null -> item(key = "empty-unread") {
                        Text(
                            stringResource(R.string.activity_screen_no_unread_activity), style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp),
                        )
                    }
                    list.isEmpty() && !feed.unreadOnly -> item(key = "empty") { EmptyActivity(segment) }
                    else -> {
                        items(list, key = { it.key }) { item ->
                            ActivityRow(
                                item, store, version, now,
                                unread = feed.unread(item, store),
                                onNeedEmojiImage = { controller.loadEmojiImage(it) },
                                onClick = {
                                    // §6.4: a row opened is read (until it happens again); then its item opens.
                                    controller.markActivityItemsRead(item)
                                    when (val target = ActivityText.target(item)) {
                                        is ActivityTarget.Message -> onOpenMessage(target.message)
                                        is ActivityTarget.Canvas -> onOpenCanvas(target.channelId, target.canvasId)
                                        ActivityTarget.Reservations -> onOpenReservations()
                                        is ActivityTarget.Page -> onOpenPage(target.pageId)
                                        null -> Unit
                                    }
                                },
                            )
                            HorizontalDivider()
                        }
                        if (feed.cursor != null) item(key = "more") {
                            Text(L10n.str(R.string.common_loading), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyActivity(segment: ActivitySegment) {
    val (title, hint) = when (segment) {
        ActivitySegment.ALL -> stringResource(R.string.activity_screen_no_activity_yet) to stringResource(R.string.activity_screen_mentions_reactions_to_your_posts_and)
        ActivitySegment.MENTIONS -> stringResource(R.string.common_no_mentions_yet) to stringResource(R.string.common_messages_to_you_and_channel_show)
        ActivitySegment.THREADS -> stringResource(R.string.activity_screen_no_thread_replies) to stringResource(R.string.activity_screen_when_someone_replies_in_a_thread)
        ActivitySegment.REACTIONS -> stringResource(R.string.activity_screen_no_reactions_yet) to stringResource(R.string.activity_screen_when_someone_reacts_to_your_post)
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
    }
}

/**
 * One activity: the unread dot, who (two faces when several reacted), what happened, where and when, and the message
 * (for a reaction, mine). `version`: names, channels and custom emoji come from the Store.
 */
@Composable
private fun ActivityRow(
    item: ActivityItem, store: Store, version: Int, now: ZonedDateTime, unread: Boolean,
    onNeedEmojiImage: (jp.chikuwachat.android.api.CustomEmojiOut) -> Unit, onClick: () -> Unit,
) {
    val name: (String) -> String? = { id -> store.users[id]?.displayName }
    val lead = remember(version, item) { ActivityText.lead(item, name) }
    val channelId = ActivityText.channelId(item)
    val channel = channelId?.let { store.channel(it) }
    val conversation = remember(version, channelId) { channel?.let { channelTitle(it, store) } ?: "" }
    val where = ActivityText.where(item, conversation)
    val canvas = item.canvas.takeIf { item.kind == "canvas_mention" }
    val page = item.page // M122
    // M112: a to-do another operator handled (or no longer needed) is done: dimmed, 「対応済み」 (activity.updated names it).
    val reservation = item.reservation
    val done = reservation != null && (reservation.done || reservation.itemId in store.blankedActivityItems)
    val excerpt = remember(version, item) {
        ActivityText.excerpt(item, store.blankedActivityItems) { messageLine(it.body, it.attachments, store) }
    }
    val time = MainTabs.dmTimeLabel(item.at, now) ?: ""
    // M77: a canvas row reads as one sentence (CANVAS.md §20.5); the others keep their parts.
    val spoken = if (page != null) ActivityText.spokenCanvas(item, name, where, unread) else canvas?.let { ActivityText.spokenCanvas(item, name, conversation, unread) }
    val tap = onClick
    // §6.4 (2026-10-07): an unread row is tinted, bold, with a dot; a read one plain (name medium, the line muted).
    val shownUnread = unread && !done
    Row(
        Modifier.fillMaxWidth()
            .then(if (spoken != null) Modifier.clearAndSetSemantics { contentDescription = spoken; this.onClick(label = null, action = { tap(); true }) } else Modifier)
            .then(if (shownUnread) Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.07f)) else Modifier)
            .clickable(onClick = onClick)
            .alpha(if (done) 0.6f else 1f)
            .padding(start = 6.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.width(14.dp).padding(top = 14.dp), contentAlignment = Alignment.Center) {
            if (unread && !done) Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape).semantics { contentDescription = L10n.str(R.string.common_unread) })
        }
        Box {
            if (reservation != null) {
                Box(Modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                    Text("🎫", style = MaterialTheme.typography.titleMedium)
                }
            } else {
                ActorFaces(item.actorIds, name)
            }
            // M77: the kind's mark on the face, 📝 for a canvas mention.
            if (canvas != null || page != null) {
                Box(
                    Modifier.align(Alignment.BottomEnd).offset(x = 4.dp, y = 4.dp).size(18.dp)
                        .background(MaterialTheme.colorScheme.surface, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Text(if (page != null) "📄" else "📝", style = MaterialTheme.typography.labelSmall) }
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        lead, style = MaterialTheme.typography.labelLarge, fontWeight = if (shownUnread) FontWeight.Bold else FontWeight.Medium,
                        color = if (shownUnread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.78f),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                    if (item.kind == "reaction") item.emojis.forEach { emoji -> ReactionGlyph(emoji, store, onNeedEmojiImage) }
                }
                if (done) Text(stringResource(R.string.activity_screen_done), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
                Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
            }
            if (where.isNotEmpty()) {
                Text(where, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (excerpt.isNotEmpty()) {
                // Custom emoji as their pictures and `:shortcode:`s as glyphs, as in the message (2026-10-05: `:ckw-yay:`).
                EmojiLineText(
                    excerpt, store, onNeedEmojiImage, version, MaterialTheme.typography.bodyMedium,
                    if (shownUnread) androidx.compose.ui.graphics.Color.Unspecified else MaterialTheme.colorScheme.onSurfaceVariant,
                    Modifier.padding(top = 2.dp), maxLines = if (canvas != null || page != null) 2 else 3,
                )
            }
        }
    }
}

/** The first actor's face, with the second's behind it when several did it (a reaction). */
@Composable
private fun ActorFaces(ids: List<String>, name: (String) -> String?) {
    val first = ids.firstOrNull()
    val second = ids.getOrNull(1)
    if (first == null) {
        Spacer(Modifier.size(36.dp))
        return
    }
    if (second == null) {
        Avatar(first, name(first) ?: "?", size = 36.dp)
        return
    }
    Box(Modifier.size(36.dp)) {
        Avatar(second, name(second) ?: "?", size = 26.dp, modifier = Modifier.offset(x = 10.dp, y = 10.dp))
        Avatar(first, name(first) ?: "?", size = 26.dp)
    }
}

/** A reaction's emoji in the headline: a custom one as its picture (loaded on demand), else the character. */
@Composable
private fun ReactionGlyph(emoji: String, store: Store, onNeedEmojiImage: (jp.chikuwachat.android.api.CustomEmojiOut) -> Unit) {
    ReactionEmoji(emoji, store, onNeedEmojiImage, 18.dp, MaterialTheme.typography.titleSmall, Modifier.padding(start = 4.dp))
}

/** M34, stage A (a server before M39): [メンション | スレッド] over the existing lists. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StageA(
    controller: AppController,
    version: Int,
    segment: ActivitySegment,
    onSegment: (ActivitySegment) -> Unit,
    mentionsState: LazyListState,
    threadsState: LazyListState,
    onOpenMessage: (MessageOut) -> Unit,
    onOpenThread: (ThreadEntry, jp.chikuwachat.android.sync.MessageState?) -> Unit,
    onOpenThreadConversation: (ThreadEntry) -> Unit,
) {
    val shown = if (segment == ActivitySegment.THREADS) ActivitySegment.THREADS else ActivitySegment.MENTIONS
    Column(Modifier.fillMaxSize()) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            ActivitySegment.stageA.forEachIndexed { index, value ->
                SegmentedButton(
                    selected = value == shown,
                    onClick = { onSegment(value) },
                    shape = SegmentedButtonDefaults.itemShape(index, ActivitySegment.stageA.size),
                    label = { Text(value.label) },
                )
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (shown) {
                ActivitySegment.THREADS -> ThreadsPane(controller, version, onOpen = onOpenThread, listState = threadsState, onOpenConversation = onOpenThreadConversation, showReadAll = false)
                else -> MentionsPane(controller, version, onOpen = onOpenMessage, listState = mentionsState)
            }
        }
    }
}
