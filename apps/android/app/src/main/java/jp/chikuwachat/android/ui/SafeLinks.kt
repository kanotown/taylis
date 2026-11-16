package jp.chikuwachat.android.ui

import androidx.compose.ui.platform.UriHandler

/**
 * 2026-11-16 (a hostile-server review): the one rule for opening a URL a server gave (a pinned link, a database's URL
 * cell, a call's room, a link preview): http or https, and mailto only where the screen means an address — the rule of a
 * topic's links ([TopicText.allowed]). Compose's AndroidUriHandler and ACTION_VIEW start whatever the scheme names
 * (`intent:`, `file:`, `content:`, another app's own scheme), so a URL chosen by the server could start any exported
 * activity on the device.
 */
object SafeLinks {
    /** http or https with something after `://` (any case), nothing else. */
    fun isWeb(url: String): Boolean = TopicText.allowed(url) && !url.startsWith("mailto:", ignoreCase = true)

    /** [isWeb], or also a `mailto:` address when [mail]. */
    fun canOpen(url: String, mail: Boolean = false): Boolean = if (mail) TopicText.allowed(url) else isWeb(url)

    /** Opens [url] when [canOpen] allows it; false when it is refused or nothing could open it. */
    fun open(handler: UriHandler, url: String, mail: Boolean = false): Boolean =
        canOpen(url, mail) && runCatching { handler.openUri(url) }.isSuccess
}
