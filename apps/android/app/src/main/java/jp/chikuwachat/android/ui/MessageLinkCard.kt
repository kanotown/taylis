package jp.chikuwachat.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.MessagePreviewOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessagePreviewHub
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

/**
 * M185 (docs/LINK_PREVIEWS.md §2, §4.1, §5): the cards under a message, as plain rules (the same on the web and iOS;
 * the cases are apps/shared/link-cards.json). A link to another message on this server (`<server>/m/<id>`) is a card with
 * that message as the reader may see it; the first other link that has no card of its own gets the Open Graph card (M11g).
 */
object MessageCards {
    /** At most this many message cards under one message (a fourth link stays a chip in the body). */
    const val MAX_MESSAGE_CARDS = 3

    /** Lines of the excerpt a card shows (the server sends at most 6). */
    const val CARD_LINES = 4

    /** A message card: the linked message and its first link's URL as written (sent when the card is removed). */
    data class MessageLink(val id: String, val url: String)

    data class CardLinks(val messages: List<MessageLink>, val external: String?) {
        val isEmpty: Boolean get() = messages.isEmpty() && external == null
    }

    private val LINK_KEY = Regex("^(https?)://([^/?#\\s\\p{Z}]+)([^#\\s\\p{Z}]*)(?:#[^\\s\\p{Z}]*)?$", RegexOption.IGNORE_CASE)

    /**
     * §4.1: the key a removed card is kept under (`MessageOut.hidden_previews`): scheme and host in lower case, the
     * fragment dropped, "/" for an empty path, the rest as written. Plain string work, the same on the server and the other
     * clients; null for anything but an http(s) URL.
     */
    fun previewKey(url: String): String? {
        val match = LINK_KEY.matchEntire(url.trim()) ?: return null
        val (scheme, host, rest) = match.destructured
        return scheme.lowercase() + "://" + host.lowercase() + (if (rest.startsWith("/")) rest else "/$rest")
    }

    /**
     * §2: which cards a message shows. A link to a message on `baseUrl` is a message card: up to [MAX_MESSAGE_CARDS]
     * distinct messages in the body's order, not the message itself (`selfId`). The first other link that is not one of
     * this server's links with a card or view of their own (a drive item, M165; and, as before on Android, a canvas, a
     * page or an event) gets the Open Graph card, unless the message announces a call (M117). A card whose link's key is
     * in `hidden` is left out, and nothing takes its place.
     */
    fun cardLinks(body: String, baseUrl: String?, selfId: String? = null, hidden: Collection<String> = emptyList(), call: Boolean = false): CardLinks {
        val removed = hidden.toSet()
        fun shown(url: String) = (previewKey(url) ?: url) !in removed
        val self = selfId?.lowercase()
        val seen = HashSet<String>()
        val messages = ArrayList<MessageLink>()
        var external: String? = null
        for (url in Links.all(body)) {
            val id = baseUrl?.let { Permalink.messageId(it, url) }
            if (id != null) {
                if (id == self || !seen.add(id)) continue
                if (seen.size <= MAX_MESSAGE_CARDS) messages.add(MessageLink(id, url))
                continue
            }
            if (external == null && !hasOwnView(baseUrl, url)) external = url
        }
        return CardLinks(messages.filter { shown(it.url) }, external?.takeIf { !call && shown(it) })
    }

    private fun hasOwnView(baseUrl: String?, url: String): Boolean = baseUrl != null &&
        (Permalink.driveId(baseUrl, url) ?: Permalink.canvasId(baseUrl, url) ?: Permalink.pageId(baseUrl, url) ?: Permalink.eventId(baseUrl, url)) != null

    /**
     * §5: the excerpt as a card shows it: each line as plain text (as the one-line previews: markers dropped, mentions as
     * names), blank lines left out, at most `lines` of them, 「…」 when anything was left out.
     */
    fun excerptText(excerpt: String, truncated: Boolean, users: Map<String, UserPublic>, groups: Map<String, GroupOut> = emptyMap(), lines: Int = CARD_LINES): String {
        val rows = excerpt.split("\n").map { plainText(Mentions.toNames(it, users, groups), 400) }.filter { it.isNotBlank() }
        val text = rows.take(lines).joinToString("\n")
        return if (text.isNotEmpty() && (truncated || rows.size > lines)) "$text…" else text
    }

    /** §3.2's thumbnail from a row held here: the first photo or video poster not moved out of the channel's drive. */
    fun thumbnail(attachments: List<AttachmentOut>): String? =
        attachments.firstOrNull { (it.hasThumbnail || it.hasPoster) && (it.drive == null || it.drive.state == "available") }?.id

    /**
     * Where the linked message is: `#name` for a channel (the server's name: a public channel I have not joined is not in
     * my list), the other people for a DM from my own list (I am in it), else 「ダイレクトメッセージ」; a thread reply
     * reads 「#name のスレッド」.
     */
    fun conversation(preview: MessagePreviewOut, channel: ChannelState?, store: Store): String {
        val isChannel = preview.channelType == "public" || preview.channelType == "private"
        val name = when {
            isChannel -> "#" + (preview.channelName ?: channel?.channel?.name ?: "")
            channel != null -> channelTitle(channel, store)
            else -> L10n.str(R.string.link_cards_direct_message)
        }
        return if (preview.parentId != null) L10n.str(R.string.link_cards_in_thread, name) else name
    }

    /** What the long-press sheet calls a card when the message has several (「プレビューを削除：…」). */
    fun label(preview: MessagePreviewOut?, store: Store): String = when {
        preview == null -> L10n.str(R.string.link_cards_loading)
        preview.state == "deleted" -> L10n.str(R.string.link_cards_deleted)
        preview.state != "ok" -> L10n.str(R.string.link_cards_unavailable)
        store.isBlocked(preview.senderId ?: "") -> L10n.str(R.string.moderation_message_from_a_blocked_user)
        else -> listOfNotNull(store.users[preview.senderId ?: ""]?.displayName, conversation(preview, preview.channelId?.let { store.channel(it) }, store)).joinToString(" · ")
    }
}

/** One frame's height whatever the card shows (loading, the message, why not), so the row hardly moves when it fills in. */
private val CARD_MIN_HEIGHT = 64.dp

/**
 * The cards of one message (timeline, thread, a channel's preview, the Times feed): the message links' cards in the body's
 * order, then the external link's (M11g). `onLongPress` (a card's URL) opens the message's long-press sheet with
 * 「プレビューを削除」 for that card; `onRemove` (who may remove them) is the cards' accessibility action.
 */
@Composable
fun MessageLinkCards(
    controller: AppController,
    message: MessageState,
    cards: MessageCards.CardLinks,
    version: Int,
    onLongPress: ((String) -> Unit)?,
    onRemove: ((String) -> Unit)?,
) {
    if (cards.isEmpty) return
    val store = controller.store
    val linkContext = LocalMessageLinkContext.current
    cards.messages.forEach { link ->
        MessageLinkCard(
            controller, link.id, version,
            // The app's permalink action, as the body's 「メッセージを表示」 chip (the open thread or timeline scrolls to it).
            onOpen = { id -> controller.scope.launch { controller.openPermalink(id, linkContext) } },
            onLongPress = onLongPress?.let { press -> { press(link.url) } },
            onRemove = onRemove?.let { remove -> { remove(link.url) } },
        )
    }
    cards.external?.let { link ->
        // Review v0.1.18 #5: an AI bot's link is not previewed until tapped (decided by the sender, here).
        LinkPreviewCard(
            controller, link, message.id,
            auto = LinkPreviewPolicy.autoLoads(message.senderId, store.users[message.senderId]?.role, controller.aiStatus, store.users[message.senderId]?.botKind),
            onLongPress = onLongPress?.let { press -> { press(link) } },
            onRemove = onRemove?.let { remove -> { remove(link) } },
        )
    }
}

/** §8 7.: whether a card is on screen now (only a card one sees can be removed from the sheet). */
fun cardShown(controller: AppController, cards: MessageCards.CardLinks, url: String): Boolean {
    cards.messages.firstOrNull { it.url == url }?.let { return controller.messagePreviews?.peek(it.id)?.preview != null }
    return url == cards.external && controller.linkPreviews[url] != null
}

/** The sheet's name for a card (several cards: 「プレビューを削除：名前」). */
fun cardLabel(controller: AppController, cards: MessageCards.CardLinks, url: String): String {
    cards.messages.firstOrNull { it.url == url }?.let { return MessageCards.label(controller.messagePreviews?.peek(it.id)?.preview, controller.store) }
    return controller.linkPreviews[url]?.let { Links.siteLabel(it.siteName, it.url) } ?: url
}

/** TalkBack's 「プレビューを削除」 (`label`) on a card (the long press opens the sheet; this removes it at once, as the sheet's item). */
internal fun Modifier.removeAction(label: String, onRemove: (() -> Unit)?): Modifier =
    if (onRemove == null) this else semantics { customActions = listOf(CustomAccessibilityAction(label) { onRemove(); true }) }

/**
 * A message link's card (§5): a thin outline, no accent bar. The author's avatar and name, the conversation and the time,
 * then up to four plain lines and the photo; a press opens the message (the app's permalink action). Whoever cannot read
 * it sees 「表示できないメッセージ」 (not pressable) and nothing of it; a deleted one 「削除されたメッセージ」.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageLinkCard(
    controller: AppController,
    messageId: String,
    version: Int,
    onOpen: (String) -> Unit,
    onLongPress: (() -> Unit)?,
    onRemove: (() -> Unit)?,
) {
    val hub: MessagePreviewHub = controller.messagePreviews ?: return
    hub.version.collectAsState().value
    // Composed when the row comes near the screen (the list composes only those): asked then, in a batch with the others.
    LaunchedEffect(messageId) { hub.request(messageId) }
    val entry = hub.peek(messageId)
    if (entry != null && entry.preview == null) return // the request failed: the link in the body still opens it
    val preview = entry?.preview
    val shape = RoundedCornerShape(8.dp)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val frame = Modifier.padding(top = 6.dp).widthIn(max = 420.dp).fillMaxWidth().heightIn(min = CARD_MIN_HEIGHT).clip(shape)
        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
    val actionsLabel = stringResource(R.string.channel_pane_message_actions)
    val removeLabel = stringResource(R.string.link_cards_remove)
    // Not pressable (loading, unavailable, deleted): only the long press, without a ripple that would say otherwise.
    val holdOnly = if (onLongPress == null) Modifier else Modifier.combinedClickable(
        interactionSource = remember { MutableInteractionSource() }, indication = null,
        onLongClickLabel = actionsLabel, onLongClick = onLongPress, onClick = {},
    )
    @Composable
    fun Plain(icon: (@Composable () -> Unit), title: String, note: String?) {
        Row(
            frame.then(holdOnly).removeAction(removeLabel, onRemove).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            icon()
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = if (note != null) MaterialTheme.colorScheme.onSurface else muted)
                if (note != null) Text(note, style = MaterialTheme.typography.labelSmall, color = muted)
            }
        }
    }
    when (preview?.state) {
        null -> Plain({ CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) }, stringResource(R.string.link_cards_loading), null)
        "ok" -> ReadableCard(controller, preview, version, frame.combinedClickable(
            onClickLabel = stringResource(R.string.link_cards_open), onClick = { onOpen(preview.id) },
            onLongClickLabel = actionsLabel, onLongClick = onLongPress,
        ).removeAction(removeLabel, onRemove))
        "deleted" -> Plain({ Icon(Icons.Outlined.Delete, contentDescription = null, tint = muted, modifier = Modifier.size(18.dp)) }, stringResource(R.string.link_cards_deleted), null)
        else -> Plain(
            { Icon(Icons.Outlined.Lock, contentDescription = null, tint = muted, modifier = Modifier.size(18.dp)) },
            stringResource(R.string.link_cards_unavailable), stringResource(R.string.link_cards_unavailable_note),
        )
    }
}

@Composable
private fun ReadableCard(controller: AppController, preview: MessagePreviewOut, version: Int, modifier: Modifier) {
    val store = controller.store
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val senderId = preview.senderId ?: ""
    val blocked = store.isBlocked(senderId)
    val name = store.users[senderId]?.displayName ?: "unknown"
    // §8 6.: the linked message as this device holds it (its conversation loaded): an edit shows at once.
    val live = remember(version, preview) { preview.channelId?.let { store.message(it, preview.id) }?.takeIf { !it.deleted && !it.pending } }
    val text = remember(version, preview, live) {
        val lines = if (live != null) MessageCards.excerptText(live.body, false, store.users, store.groups)
        else MessageCards.excerptText(preview.excerpt, preview.excerptTruncated, store.users, store.groups)
        lines.ifEmpty { attachmentSummary(live?.attachments?.map { it.contentType } ?: preview.attachmentTypes) }
    }
    val thumbnailId = if (blocked) null else if (live != null) MessageCards.thumbnail(live.attachments) else preview.thumbnailAttachmentId
    val where = remember(version, preview) { MessageCards.conversation(preview, preview.channelId?.let { store.channel(it) }, store) }
    Column(modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!blocked) {
                Avatar(senderId, name, size = 18.dp)
                Spacer(Modifier.width(6.dp))
                Text(
                    name, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).padding(end = 6.dp),
                )
            }
            Text(where, style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            preview.createdAt?.let { Text(Timeline.stampLabel(it), style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, modifier = Modifier.padding(start = 6.dp)) }
        }
        Row(Modifier.padding(top = 4.dp)) {
            if (blocked) {
                Text(stringResource(R.string.moderation_message_from_a_blocked_user), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.weight(1f))
            } else {
                EmojiLineText(text, controller, version, MaterialTheme.typography.bodySmall, MaterialTheme.colorScheme.onSurface, Modifier.weight(1f), maxLines = MessageCards.CARD_LINES)
            }
            if (thumbnailId != null) CardThumbnail(controller, thumbnailId)
        }
    }
}

/** The linked message's photo (56 dp, cropped square); nothing until it comes or when it cannot be read. */
@Composable
private fun CardThumbnail(controller: AppController, attachmentId: String) {
    var bitmap by remember(attachmentId) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(attachmentId) { bitmap = fetchThumbnail(controller, attachmentId) }
    bitmap?.let { Image(it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.padding(start = 10.dp).size(56.dp).clip(RoundedCornerShape(6.dp))) }
}
