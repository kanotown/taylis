package jp.chikuwachat.android.ui

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Message permalinks (M12b): `<server>/m/<message_id>`, recognised only for the server we are logged into. M46: canvas
 * links (`<server>/c/<canvas_id>`, CANVAS.md §4.13) the same way, and calendar events (`<server>/e/<event_id>`, the
 * 「予定」 bot's announcement of a new channel event).
 */
object Permalink {
    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

    fun url(baseUrl: String, messageId: String): String = baseUrl.trimEnd('/') + "/m/" + messageId

    fun canvasUrl(baseUrl: String, canvasId: String): String = baseUrl.trimEnd('/') + "/c/" + canvasId

    /** M122 (docs/WIKI.md §9.3): a page of 「ドキュメント」, `<server>/p/<page_id>`. */
    fun pageUrl(baseUrl: String, pageId: String): String = baseUrl.trimEnd('/') + "/p/" + pageId

    /** The message id when `url` is a permalink on `baseUrl` (case-insensitive prefix, query / fragment ignored). */
    fun messageId(baseUrl: String, url: String): String? = idAfter(baseUrl, url, "/m/")

    /** The canvas id when `url` is a canvas link on `baseUrl`. */
    fun canvasId(baseUrl: String, url: String): String? = idAfter(baseUrl, url, "/c/")

    /** M122: the page id when `url` is a page link on `baseUrl`. */
    fun pageId(baseUrl: String, url: String): String? = idAfter(baseUrl, url, "/p/")

    /** A calendar event, `<server>/e/<event_id>`. */
    fun eventUrl(baseUrl: String, eventId: String): String = baseUrl.trimEnd('/') + "/e/" + eventId

    /** The event id when `url` is an event link on `baseUrl`. */
    fun eventId(baseUrl: String, url: String): String? = idAfter(baseUrl, url, "/e/")

    /** M165 / M166 (docs/DRIVE.md §13.1, §26): a drive file or folder, `<server>/d/<item_id>`. */
    fun driveUrl(baseUrl: String, itemId: String): String = baseUrl.trimEnd('/') + "/d/" + itemId

    /** The drive item id when `url` is a drive link on `baseUrl` (another server's /d/ is a plain link). */
    fun driveId(baseUrl: String, url: String): String? = idAfter(baseUrl, url, "/d/")

    /**
     * M173 (docs/LENDING.md §13.5, §17.8): an equipment item, `<server>/eq/<item_id>` (the QR code on its label; `/e/` is
     * an event's).
     */
    fun equipmentUrl(baseUrl: String, itemId: String): String = baseUrl.trimEnd('/') + "/eq/" + itemId

    /** The item id when `url` is an equipment link on `baseUrl` (another server's /eq/ is a plain link). */
    fun equipmentId(baseUrl: String, url: String): String? = idAfter(baseUrl, url, "/eq/")

    /**
     * The id when `url` is `<server><path><uuid>` on `baseUrl` (apps/shared/message-links.json): the same host (any case)
     * and port (the default one written out or not) and the server's path, http or https alike (2026-11-05: a link written
     * with the other scheme opened in the browser), then the UUID (any case), ending there or with `/` `?` `#`.
     */
    private fun idAfter(baseUrl: String, url: String, path: String): String? {
        val base = serverPart(baseUrl) ?: return null
        val link = serverPart(url) ?: return null
        if (link.first != base.first) return null
        val head = base.second.trimEnd('/') + path
        if (!link.second.startsWith(head, ignoreCase = true)) return null
        val rest = link.second.substring(head.length)
        val id = rest.take(36)
        val after = rest.drop(36)
        return if (UUID.matches(id) && (after.isEmpty() || after[0] in "/?#")) id.lowercase() else null
    }

    private val SERVER = Regex("^(https?)://([^/?#]*)(.*)$", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

    /** An http(s) URL's host and port (lower case, without the scheme's default port) and the rest; null for anything else. */
    private fun serverPart(url: String): Pair<String, String>? {
        val match = SERVER.matchEntire(url) ?: return null
        val authority = match.groupValues[2].lowercase()
        if (authority.isEmpty() || '@' in authority) return null // user info: someone else's host after it
        val port = if (match.groupValues[1].lowercase() == "https") ":443" else ":80"
        return authority.removeSuffix(port) to match.groupValues[3]
    }
}

/**
 * Where a message link was tapped: a thread (ThreadPane) or a conversation's timeline (ChannelPane). Elsewhere (a canvas,
 * a page, the search, a preview) there is none, and a link opens its conversation as before.
 */
sealed interface MessageLinkContext {
    data class Timeline(val channelId: String) : MessageLinkContext
    data class Thread(val channelId: String, val parentId: String) : MessageLinkContext
}

/** Where the message rows under it are shown, for their links ([PermalinkJump]). */
val LocalMessageLinkContext = staticCompositionLocalOf<MessageLinkContext?> { null }

/**
 * What a tapped message link does (user report 2026-10-21, as on iOS). A message shown on the same screen is scrolled to
 * and highlighted there, loading what is missing: a reply of the open thread, or its parent, in the thread (the parent
 * sits at its top); a top-level message of the open timeline in that timeline. Anything else opens its conversation (and
 * its thread, for a reply), as before. Landing the same conversation again changed nothing on screen: the open thread
 * had placed itself once and stayed where it was.
 */
sealed interface PermalinkJump {
    /** Scroll the open thread [parentId] to the message. */
    data class Thread(val parentId: String) : PermalinkJump
    /** Scroll the open timeline to the message (its surroundings, as a search hit). */
    data object Timeline : PermalinkJump
    /** Open the message's conversation (and thread). */
    data object Open : PermalinkJump

    companion object {
        fun of(channelId: String, messageId: String, parentId: String?, from: MessageLinkContext?): PermalinkJump = when {
            from is MessageLinkContext.Thread && from.channelId == channelId && (parentId == from.parentId || messageId == from.parentId) ->
                Thread(from.parentId)
            from is MessageLinkContext.Timeline && from.channelId == channelId && parentId == null -> Timeline
            else -> Open
        }
    }
}
