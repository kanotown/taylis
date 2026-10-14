package jp.chikuwachat.android.share

import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.ui.formatSize

/**
 * MOBILE_UI.md §20 (他のアプリから共有して送る): what another app's share sheet hands over, read out of the Intent by
 * [ShareActivity] so that the rules below are plain Kotlin (ShareTest).
 */
data class ShareIntentData(
    val action: String?,
    /** EXTRA_STREAM: one Uri for ACTION_SEND, a list for ACTION_SEND_MULTIPLE, as Android parsed them. */
    val streams: List<ShareStream> = emptyList(),
    /** EXTRA_TEXT (a list for ACTION_SEND_MULTIPLE from some apps). */
    val texts: List<String> = emptyList(),
    val subject: String? = null,
    /** Intent.EXTRA_SHORTCUT_ID: a Direct Share target (a conversation shortcut) was chosen. */
    val shortcutId: String? = null,
)

/**
 * One shared stream as Android's `Uri` sees it (REVIEW-v0.1.62 #2): its text and the scheme and authority that
 * `Uri.getScheme()` / `Uri.getAuthority()` give — the authority percent-decoded, as ContentResolver resolves it. The
 * check reads these, never the raw text, so `content://jp%2Echikuwachat%2Eandroid%2Efiles/…` is this app's provider.
 */
data class ShareStream(val uri: String, val scheme: String?, val authority: String?)

/**
 * This app's own content providers (REVIEW-v0.1.62 #2): their authorities as the manifest lists them, plus [ownsProvider],
 * which asks the system which package an authority resolves to (PackageManager.resolveContentProvider), so that an
 * alias or a spelling the list misses is still refused.
 */
class OwnProviders(authorities: Set<String>, private val ownsProvider: (String) -> Boolean = { false }) {
    private val names = authorities.map { it.lowercase(java.util.Locale.ROOT) }.toSet()

    /** [authority] (decoded, as Android parses it) names one of them, with or without a user id prefix (`10@…`). */
    fun owns(authority: String): Boolean {
        val bare = SharePayload.withoutUserId(authority)
        return bare.lowercase(java.util.Locale.ROOT) in names || runCatching { ownsProvider(bare) }.getOrDefault(true)
    }
}

/** What is shared: the files (content URIs this app may read) and the text the message starts with. */
data class ShareRequest(
    val uris: List<String>,
    val text: String,
    val shortcutId: String?,
    /** Streams that were refused (not content://, or this app's own provider): reported, never read. */
    val refused: Int = 0,
)

/** A shared file as the content provider describes it; [size] null when it does not say. */
data class SharedFile(val uri: String, val name: String, val size: Long?, val mime: String?, val readable: Boolean = true)

object SharePayload {
    const val ACTION_SEND = "android.intent.action.SEND"
    const val ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE"

    /**
     * The intent's items, or null when it shares nothing. Only `content://` streams of other apps are read: a `file://`
     * path or a URI of this app's own provider ([own]) could hand this app's private files (its database,
     * its tokens) to the server, so they are refused and counted. The text is EXTRA_TEXT; the subject (a page's title)
     * goes in front of it when the share carries no files and the text does not hold it already.
     */
    fun parse(data: ShareIntentData, own: OwnProviders): ShareRequest? {
        if (data.action != ACTION_SEND && data.action != ACTION_SEND_MULTIPLE) return null
        var refused = 0
        val uris = data.streams.filter { it.uri.isNotBlank() }.distinctBy { it.uri }.filter { stream ->
            isReadable(stream.scheme, stream.authority, own).also { if (!it) refused++ }
        }.map { it.uri }
        val body = data.texts.map { it.trim() }.filter { it.isNotEmpty() }.distinct().joinToString("\n")
        val subject = data.subject?.trim().orEmpty()
        val text = when {
            uris.isNotEmpty() || subject.isEmpty() -> body
            body.isEmpty() -> subject
            body.contains(subject) -> body
            else -> "$subject\n$body"
        }
        if (uris.isEmpty() && text.isEmpty() && refused == 0) return null
        return ShareRequest(uris, text, data.shortcutId?.takeIf { it.isNotBlank() }, refused)
    }

    /**
     * `content://authority/…` of another app, from the parsed [scheme] and decoded [authority] (REVIEW-v0.1.62 #2): the
     * same Uri object's parts that the read uses, so the check and the read cannot disagree about which provider it is.
     */
    fun isReadable(scheme: String?, authority: String?, own: OwnProviders): Boolean {
        if (!scheme.equals("content", ignoreCase = true)) return false
        val name = authority?.trim().orEmpty()
        if (withoutUserId(name).isEmpty()) return false
        return !own.owns(name)
    }

    /** `10@jp.example.files` → `jp.example.files` (ContentProvider.getAuthorityWithoutUserId). */
    fun withoutUserId(authority: String): String = authority.substring(authority.lastIndexOf('@') + 1)

    /** A display name: the provider's, else the URI's last segment, without path separators or control characters. */
    fun fileName(displayName: String?, uri: String): String {
        val segment = runCatching { java.net.URLDecoder.decode(uri.substringBefore('?').substringAfterLast('/'), "UTF-8") }.getOrNull()
        val raw = displayName?.takeIf { it.isNotBlank() } ?: segment?.takeIf { it.isNotBlank() } ?: "file"
        val base = raw.replace('\\', '/').substringAfterLast('/')
        val cleaned = base.filter { it >= ' ' && it != '\u007f' }.trim().take(255)
        return cleaned.ifEmpty { "file" }
    }

    /**
     * Why the share cannot be sent as it is, in words (empty: it can): too many files, a file over the server's limit,
     * an empty or unreadable one, a message over the length limit, nothing at all. The composer's limits (bootstrap
     * `limits`); the server checks them again. Refused streams ([ShareRequest.refused]) are a separate note: the rest
     * can still be sent.
     */
    fun problems(files: List<SharedFile>, text: String, limits: Limits?): List<String> = buildList {
        val maxFiles = limits?.maxAttachmentsPerMessage ?: 10
        if (files.size > maxFiles) add(L10n.str(R.string.share_in_too_many_files, maxFiles))
        val maxBytes = limits?.maxAttachmentBytes
        for (file in files) {
            when {
                !file.readable -> add(L10n.str(R.string.share_in_file_unreadable, file.name))
                file.size == 0L -> add(L10n.str(R.string.share_in_file_empty, file.name))
                maxBytes != null && file.size != null && file.size > maxBytes ->
                    add(L10n.str(R.string.share_in_file_too_large, file.name, formatSize(maxBytes)))
            }
        }
        val maxLength = limits?.maxMessageLength
        if (maxLength != null && text.length > maxLength) add(L10n.str(R.string.share_in_text_too_long, maxLength))
        if (files.isEmpty() && text.isBlank()) add(L10n.str(R.string.share_in_nothing))
    }
}
