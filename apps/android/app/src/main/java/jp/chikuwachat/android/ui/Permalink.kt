package jp.chikuwachat.android.ui

/** Message permalinks (M12b): `<server>/m/<message_id>`, recognised only for the server we are logged into. */
object Permalink {
    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

    fun url(baseUrl: String, messageId: String): String = baseUrl.trimEnd('/') + "/m/" + messageId

    /** The message id when `url` is a permalink on `baseUrl` (case-insensitive prefix, query / fragment ignored). */
    fun messageId(baseUrl: String, url: String): String? {
        val prefix = baseUrl.trimEnd('/') + "/m/"
        if (!url.startsWith(prefix, ignoreCase = true)) return null
        val id = url.substring(prefix.length).substringBefore('/').substringBefore('?').substringBefore('#')
        return if (UUID.matches(id)) id.lowercase() else null
    }
}
