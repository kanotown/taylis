package jp.chikuwachat.android.ui

/**
 * Message permalinks (M12b): `<server>/m/<message_id>`, recognised only for the server we are logged into. M46: canvas
 * links (`<server>/c/<canvas_id>`, CANVAS.md §4.13) the same way.
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

    private fun idAfter(baseUrl: String, url: String, path: String): String? {
        val prefix = baseUrl.trimEnd('/') + path
        if (!url.startsWith(prefix, ignoreCase = true)) return null
        val id = url.substring(prefix.length).substringBefore('/').substringBefore('?').substringBefore('#')
        return if (UUID.matches(id)) id.lowercase() else null
    }
}
