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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZonedDateTime
import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ActivityRules
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.ThreadEntry
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * M39: what an activity row says (MOBILE_UI.md §6.4), as pure functions (tested in ActivityTest). `name` gives a user's
 * display name (null when unknown).
 */
object ActivityText {
    /** Who did it: 「佐藤」, or 「佐藤 ほか 2 人」 when several reacted. */
    fun actors(ids: List<String>, name: (String) -> String?): String {
        val first = ids.firstOrNull()?.let(name) ?: "誰か"
        return if (ids.size > 1) "$first ほか ${ids.size - 1} 人" else first
    }

    /** The headline before a reaction's emoji (which the row draws, a custom one as its picture). */
    fun lead(item: ActivityItem, name: (String) -> String?): String {
        // 「佐藤 が」 but 「佐藤 ほか 2 人が」 (MOBILE_UI.md §6.4).
        val who = actors(item.actorIds, name) + if (item.actorIds.size > 1) "" else " "
        return when (item.kind) {
            "mention" -> "${who}がメンション"
            "thread_reply" -> "${who}がスレッドに返信"
            "reaction" -> "${who}が"
            else -> who.trim()
        }
    }

    /** 「佐藤 がメンション」 / 「佐藤 ほか 2 人が 👍🎉」 / 「佐藤 がスレッドに返信」. */
    fun headline(item: ActivityItem, name: (String) -> String?): String =
        if (item.kind == "reaction") lead(item, name) + " " + item.emojis.joinToString("") else lead(item, name)

    /** The newest item's time: how far looking at the list reads the activity. */
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
}

/** The activity tab's list on screen: its rows, where the next page starts, and which rows have the unread dot. */
private class ActivityFeed(var trigger: Any?) {
    var filter by mutableStateOf<String?>(null)
    var items by mutableStateOf<List<ActivityItem>?>(null)
    var cursor by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var failed by mutableStateOf(false)
    /**
     * The read position the dots are drawn against: the one the list first came with. Looking at the list moves the
     * server's (the badge clears) but not this (the dots stay while the reader looks, like Slack); pull to refresh and
     * 「すべて既読」 move it.
     */
    var baseline by mutableStateOf<String?>(null)

    suspend fun load(controller: AppController, filter: String, resetBaseline: Boolean = false) {
        if (this.filter != filter) {
            this.filter = filter
            items = null
            cursor = null
        }
        loading = true
        controller.listActivity(filter).onSuccess { page ->
            if (this.filter != filter) return@onSuccess
            items = page.items
            cursor = page.nextCursor
            failed = false
            if (baseline == null || resetBaseline) baseline = page.readAt
        }.onFailure {
            if (this.filter == filter && items == null) failed = true
            controller.error = controller.describe(it)
        }
        loading = false
    }

    /** New rows on top of those shown (an event or a reconnect); quiet on failure (the rows shown stay). */
    suspend fun refresh(controller: AppController) {
        val filter = filter ?: return
        val shown = items ?: return
        controller.listActivity(filter).onSuccess { page ->
            if (this.filter != filter) return@onSuccess
            val whole = page.nextCursor == null
            items = ActivityText.merge(items ?: shown, page.items, whole)
            if (whole) cursor = null
        }
    }

    suspend fun more(controller: AppController) {
        val filter = filter ?: return
        val from = cursor ?: return
        if (loading) return
        loading = true
        controller.listActivity(filter, from).onSuccess { page ->
            if (this.filter != filter || cursor != from) return@onSuccess
            val keys = (items ?: emptyList()).map { it.key }.toSet()
            items = (items ?: emptyList()) + page.items.filter { it.key !in keys }
            cursor = page.nextCursor
        }.onFailure { controller.error = controller.describe(it) }
        loading = false
    }
}

/** How long the list is on screen before the activity counts as read (the badge clears; the dots stay). */
private const val MARK_READ_DELAY_MS = 1_500L

/**
 * The activity tab (MOBILE_UI.md §6.4). M39, stage B: the filter chips over GET /activity, newest first, paged as the
 * list scrolls, pull to refresh; a row shows who did what where and when, with an unread dot when it is newer than the
 * read position, and opens its message (a reply in its thread). While the list is on screen the activity is read up
 * to its newest row after [MARK_READ_DELAY_MS]; ⋮ 「すべて既読」 ([readAllRequested]) reads everything.
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
    readAllRequested: Boolean,
    onReadAllHandled: () -> Unit,
    onOpenMessage: (MessageOut) -> Unit,
    onOpenThread: (ThreadEntry) -> Unit,
) {
    val store = controller.store
    if (store.activity == null) {
        StageA(controller, version, segment, onSegment, mentionsState, threadsState, onOpenMessage, onOpenThread)
        return
    }
    val online = controller.engineStatus == EngineStatus.ONLINE
    // A new item (an event) or a reconnect reads the first page again.
    val trigger = store.activityRevision to online
    val feed = remember { ActivityFeed(trigger) }
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(segment) { feed.load(controller, segment.filter) }
    LaunchedEffect(trigger) {
        if (feed.trigger == trigger) return@LaunchedEffect
        feed.trigger = trigger
        if (!online || feed.filter != segment.filter) return@LaunchedEffect
        // The list keeps its first row in place when rows arrive above it; at the top, the new ones show instead.
        val atTop = listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0
        feed.refresh(controller)
        if (atTop) listState.requestScrollToItem(0)
    }
    // Looked at: the activity is read up to the newest row shown (the badge clears), not while the app is away.
    val newest = feed.items?.let { ActivityText.newestAt(it) }
    val foreground = controller.appForeground
    LaunchedEffect(newest, foreground) {
        if (!foreground || newest == null || !ActivityRules.isUnread(newest, store.activity?.readAt)) return@LaunchedEffect
        delay(MARK_READ_DELAY_MS)
        controller.markActivityRead(newest, quiet = true)
    }
    // ⋮ 「すべて既読」: everything up to now, and the dots go.
    LaunchedEffect(readAllRequested) {
        if (!readAllRequested) return@LaunchedEffect
        // In the screen's scope: handing the request back changes this effect's key, which would cancel it.
        scope.launch {
            controller.markActivityRead(Instant.now().toString())?.let { feed.baseline = ActivityRules.later(feed.baseline, it.readAt) }
        }
        onReadAllHandled()
    }
    // The next page as the end of the list comes near.
    val nearEnd by remember(listState) {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf false
            last >= info.totalItemsCount - 4
        }
    }
    LaunchedEffect(nearEnd, feed.cursor) { if (nearEnd && feed.cursor != null) feed.more(controller) }

    val now = remember(version) { ZonedDateTime.now() }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ActivitySegment.entries.forEach { value ->
                FilterChip(selected = value == segment, onClick = { if (value != segment) onSegment(value) }, label = { Text(value.label) })
            }
        }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    try {
                        feed.load(controller, segment.filter, resetBaseline = true)
                        controller.refreshActivity()
                    } finally { refreshing = false }
                }
            },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            val list = feed.items
            LazyColumn(Modifier.fillMaxSize(), state = listState) {
                when {
                    list == null && feed.failed -> item(key = "failed") {
                        Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("読み込めませんでした", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            TextButton(onClick = { scope.launch { feed.load(controller, segment.filter) } }) { Text("再読み込み") }
                        }
                    }
                    list == null -> item(key = "loading") { Text("読み込み中…", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    list.isEmpty() -> item(key = "empty") { EmptyActivity(segment) }
                    else -> {
                        items(list, key = { it.key }) { item ->
                            ActivityRow(
                                item, store, version, now,
                                unread = ActivityRules.isUnread(item.at, feed.baseline),
                                onNeedEmojiImage = { controller.loadEmojiImage(it) },
                                onClick = { onOpenMessage(item.message) },
                            )
                            HorizontalDivider()
                        }
                        if (feed.cursor != null) item(key = "more") {
                            Text("読み込み中…", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
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
        ActivitySegment.ALL -> "まだアクティビティはありません" to "メンション、自分の投稿へのリアクション、フォロー中のスレッドへの返信がここに集まります。"
        ActivitySegment.MENTIONS -> "まだメンションはありません" to "自分宛てと @channel のメッセージがここに集まります。"
        ActivitySegment.THREADS -> "スレッドへの返信はありません" to "フォロー中のスレッドにほかの人が返信すると、ここに出ます。"
        ActivitySegment.REACTIONS -> "まだリアクションはありません" to "自分の投稿にほかの人がリアクションすると、ここに出ます。"
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
    val channel = store.channel(item.message.channelId)
    val where = remember(version, item.message.channelId) { channel?.let { channelTitle(it, store) } ?: "" }
    val excerpt = remember(version, item) {
        plainText(Mentions.toNames(item.message.body, store.users, store.groups)).ifEmpty { item.message.attachments.joinToString(", ") { it.filename } }
    }
    val time = MainTabs.dmTimeLabel(item.at, now) ?: ""
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 6.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.width(14.dp).padding(top = 14.dp), contentAlignment = Alignment.Center) {
            if (unread) Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape).semantics { contentDescription = "未読" })
        }
        ActorFaces(item.actorIds, name)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        lead, style = MaterialTheme.typography.labelLarge, fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                    if (item.kind == "reaction") item.emojis.forEach { emoji -> ReactionGlyph(emoji, store, onNeedEmojiImage) }
                }
                Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
            }
            if (where.isNotEmpty()) {
                Text(where, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(excerpt, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
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
    val custom = CustomEmoji.name(emoji)?.let { store.customEmoji[it] }
    val image = custom?.let { store.emojiImages[it.id] }
    if (custom != null && image == null) LaunchedEffect(custom.id) { onNeedEmojiImage(custom) }
    if (custom != null && image != null) {
        EmojiImage(image, store.emojiAnimations[custom.id], contentDescription = emoji, modifier = Modifier.padding(start = 4.dp).size(18.dp))
    } else {
        Text(emoji, style = MaterialTheme.typography.titleSmall, maxLines = 1, modifier = Modifier.padding(start = 4.dp))
    }
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
    onOpenThread: (ThreadEntry) -> Unit,
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
                ActivitySegment.THREADS -> ThreadsPane(controller, version, onOpen = onOpenThread, listState = threadsState)
                else -> MentionsPane(controller, version, onOpen = onOpenMessage, listState = mentionsState)
            }
        }
    }
}
