package jp.chikuwachat.android.ui

import androidx.compose.runtime.compositionLocalOf
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.sync.PageLabel

/**
 * M122 (docs/WIKI.md §2.3, §3.3, §9.3): how bodies draw and open links to 「ドキュメント」 — `[名前](page:<uuid>)` in pages
 * and canvases, `<server>/p/<uuid>` anywhere, and `[名前](attachment:<uuid>)` files. Provided once over the main screen
 * (a new value whenever the wiki's titles change), read by [bodyInline]; without it such links are plain text.
 */
class PageLinks(
    /** A page link tapped: the page opens over what is on screen. */
    val open: (pageId: String) -> Unit,
    /** The page's current title and icon, 「表示できないページ」, or not known yet (the link's own text then). */
    val label: (pageId: String) -> PageLabel,
    /** A file link tapped (`attachment:`): it opens like a message's file. */
    val openFile: (attachmentId: String) -> Unit,
    /** The wiki's version the labels were read at (a new value draws the links again). */
    val version: Int = 0,
)

val LocalPageLinks = compositionLocalOf<PageLinks?> { null }

object DocLinkText {
    /**
     * What a page link says: its icon (else 📄) and current title (「無題」 when empty); 「表示できないページ」 when the
     * server says I cannot read it; until known, the link's own text (else 「ページを開く」).
     */
    fun page(label: PageLabel?, written: String?): String = when (label) {
        is PageLabel.Known -> (label.icon?.takeIf { it.isNotBlank() } ?: "📄") + " " + label.title.ifBlank { L10n.str(R.string.docs_untitled) }
        PageLabel.Hidden -> "📄 " + L10n.str(R.string.docs_page_unavailable)
        else -> "📄 " + (written?.takeIf { it.isNotBlank() } ?: L10n.str(R.string.docs_open_page))
    }

    /** A file link: 📎 and its name (else 「ファイル」). */
    fun file(written: String?): String = "📎 " + (written?.takeIf { it.isNotBlank() } ?: L10n.str(R.string.docs_file))
}
