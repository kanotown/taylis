package jp.chikuwachat.android.app

import jp.chikuwachat.android.api.ServerInfoOut
import jp.chikuwachat.android.platform.KeyValueStore
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * One registered workspace (WORKSPACES.md §4): a ChikuwaChat server and the one account signed in there. No
 * secrets: the refresh token is in the Keystore-encrypted store under `serverUrl|username`, and the local
 * database is named after the same pair (SYNC_PROTOCOL.md §11).
 */
@Serializable
data class Workspace(
    /** The list key: a normalized URL (an install older than workspaces keeps the string it logged in with). */
    val serverUrl: String,
    /**
     * GET /server; null until the server has been asked (push routing). The first value recorded stays: it is the
     * server's own claim, never a reason to send this workspace's credentials elsewhere (WORKSPACES.md §5.1).
     */
    val workspaceId: String? = null,
    /** GET /server; the host until known. */
    val name: String,
    /** The name signed in with: it names the refresh token and the local database, so it stays after a rename. */
    val username: String,
    /** M96: the account's username now, when it changed after signing in; null = [username]. */
    val loginName: String? = null,
    val userId: String? = null,
    /** The session ended (revoked, refused refresh): the entry stays so that signing back in is one step. */
    val signedOut: Boolean = false,
    /** Last known unread marks of a workspace that is not open (GET /sync/summary, pushes; §6). */
    val badge: Int = 0,
    val hasUnread: Boolean = false,
    /** M93 (WORKSPACES.md §3.4.1): the admin's workspace icon (GET /server's `icon_version`); null = the letter tile. */
    val iconVersion: String? = null,
    /**
     * A random id made at each sign-in (REVIEW-v0.1.62 #1): work queued for this sign-in (a share, a widget press) names
     * it with [userId] and runs only while both are still the ones here; null for an entry signed in before it existed.
     */
    val session: String? = null,
) {
    /** M96: the name to show and to sign in with ([username] may be the old one). */
    val signInName: String get() = loginName ?: username

    /**
     * Whether work queued for [queuedUserId] in sign-in [queuedSession] may still run here: the same person (the
     * immutable user id, never the server URL alone) in the same sign-in, still signed in. A job without a user id
     * (queued by an older version) is not trusted; one queued while the entry had no session yet (signed in before
     * sessions existed) is bound by the user id alone.
     */
    fun isAccount(queuedUserId: String?, queuedSession: String?): Boolean =
        !signedOut && queuedUserId != null && userId == queuedUserId && (queuedSession == null || session == queuedSession)
}

/** M16c: the workspace list, its storage and migration, URL rules, tiles and push routing (WORKSPACES.md). */
object Workspaces {
    const val LIST_KEY = "chikuwa.workspaces"
    const val ACTIVE_KEY = "chikuwa.workspace.active"
    /** GET /server `product` of every ChikuwaChat server. */
    const val PRODUCT = "chikuwachat"

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
    }
    private val serializer = ListSerializer(Workspace.serializer())

    /**
     * "chat.example.com" → "https://chat.example.com": scheme + lower-case host (+ port) + path, without a
     * trailing "/" (and without a default port, a query or a fragment). Null for anything that is not http(s).
     */
    fun normalizeServerUrl(input: String): String? {
        var text = input.trim()
        if (text.isEmpty()) return null
        if (!Regex("^[A-Za-z][A-Za-z0-9+.-]*://").containsMatchIn(text)) text = "https://$text"
        val url = text.toHttpUrlOrNull() ?: return null
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
        val host = url.host.lowercase().let { if (':' in it) "[$it]" else it }
        val port = if (url.port == okhttp3.HttpUrl.defaultPort(url.scheme)) "" else ":${url.port}"
        return "${url.scheme}://$host$port${url.encodedPath.trimEnd('/')}"
    }

    /** Two spellings of one server ("HTTPS://Chat.example.com/" and "https://chat.example.com"). */
    fun sameServer(a: String, b: String): Boolean = (normalizeServerUrl(a) ?: a) == (normalizeServerUrl(b) ?: b)

    /** "chat.example.com" (with the port when there is one): the name until GET /server answers. */
    fun hostLabel(serverUrl: String): String {
        val url = serverUrl.toHttpUrlOrNull() ?: return serverUrl
        val port = if (url.port == okhttp3.HttpUrl.defaultPort(url.scheme)) "" else ":${url.port}"
        return url.host + port
    }

    /** The letters on a tile: 「テストチーム」 → テ, "ChikuwaChat" → C, "dev team" → DT (same rule as the desktop). */
    fun initials(name: String): String {
        val words = name.trim().split(Regex("[\\s._-]+")).filter { it.isNotEmpty() }
        val latin = Regex("^[A-Za-z0-9]")
        if (words.size >= 2 && latin.containsMatchIn(words[0]) && latin.containsMatchIn(words[1])) {
            return (words[0].take(1) + words[1].take(1)).uppercase()
        }
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return "?"
        return String(Character.toChars(trimmed.codePointAt(0))).uppercase()
    }

    /** Tile colours (the desktop's palette), picked by a stable hash of the workspace id (else the URL). */
    val PALETTE: List<Long> = listOf(0xFF5B5BD6, 0xFF0F9D8A, 0xFFD9480F, 0xFFC2255C, 0xFF1C7ED6, 0xFF7048E8, 0xFF2B8A3E, 0xFFE67700)

    fun colorKey(entry: Workspace): String = entry.workspaceId ?: entry.serverUrl

    fun color(key: String): Long {
        var hash = 0L
        var index = 0
        while (index < key.length) {
            val codePoint = key.codePointAt(index)
            // The desktop hashes the first UTF-16 unit of every code point (`for (const ch of key) ch.charCodeAt(0)`).
            hash = (hash * 31 + key[index].code) and 0xffffffffL
            index += Character.charCount(codePoint)
        }
        return PALETTE[(hash % PALETTE.size).toInt()]
    }

    data class Saved(val entries: List<Workspace>, val active: String?)

    /** The saved list and the active one; null when nothing was ever saved (an install older than workspaces). */
    fun load(store: KeyValueStore): Saved? {
        val raw = store.getString(LIST_KEY) ?: return null
        val entries = runCatching { json.decodeFromString(serializer, raw) }.getOrNull()
            ?.filter { it.serverUrl.isNotBlank() && it.username.isNotBlank() }
            ?.distinctBy { it.serverUrl }
            ?: emptyList()
        val active = store.getString(ACTIVE_KEY)?.takeIf { key -> entries.any { it.serverUrl == key } }
        return Saved(entries, active ?: entries.firstOrNull()?.serverUrl)
    }

    fun save(store: KeyValueStore, entries: List<Workspace>, active: String?) {
        store.putString(LIST_KEY, json.encodeToString(serializer, entries))
        store.putString(ACTIVE_KEY, active?.takeIf { key -> entries.any { it.serverUrl == key } })
    }

    /**
     * The first start with workspaces: the one server an older install knew becomes the list, spelled exactly as
     * it was saved (it names the stored refresh token and the local database). Only a live session moves over;
     * the name is the host until GET /server answers.
     */
    fun migrate(legacyServer: String?, legacyUsername: String?, hasSession: Boolean): Saved {
        if (legacyServer.isNullOrBlank() || legacyUsername.isNullOrBlank() || !hasSession) return Saved(emptyList(), null)
        val entry = Workspace(serverUrl = legacyServer, name = hostLabel(legacyServer), username = legacyUsername)
        return Saved(listOf(entry), entry.serverUrl)
    }

    /**
     * M114 (WORKSPACES.md §5.4): one workspace a step up (`by = -1`) or down (`by = 1`), the order the switcher keeps
     * on this device; at an end (or for an unknown one) the list stays as it is.
     */
    fun moved(entries: List<Workspace>, serverUrl: String, by: Int): List<Workspace> {
        val index = entries.indexOfFirst { it.serverUrl == serverUrl }
        val target = index + by
        if (index < 0 || target !in entries.indices) return entries
        return entries.toMutableList().apply { add(target, removeAt(index)) }
    }

    /**
     * The registered workspace at a server address (WORKSPACES.md §5.1 step 3, 2026-11-16): the same normalized URL only.
     * A `workspace_id` is the server's own claim: a server naming another one's id is not that workspace.
     */
    fun findRegistered(entries: List<Workspace>, serverUrl: String): Workspace? =
        entries.firstOrNull { sameServer(it.serverUrl, serverUrl) }

    /** Where a sign-in form goes. */
    sealed interface SignIn {
        /** Registered and signed in already: that workspace opens instead of signing in twice (one account per server). */
        data class Open(val entry: Workspace) : SignIn

        /** Sign in at this address: the URL entered, spelled as a registered entry of the same address spells it. */
        data class At(val serverUrl: String) : SignIn
    }

    /**
     * The password, the authenticator code, Google's start and an invite go to the URL entered ([normalized], or its https
     * version when the M190 prompt chose it) and nowhere else: a registered entry of the same address lends only its
     * spelling (it names the saved token and the local store), never its URL to a server that claims its workspace_id.
     */
    fun signInTarget(entries: List<Workspace>, normalized: String, adding: Boolean, activeKey: String?): SignIn {
        val known = findRegistered(entries, normalized) ?: return SignIn.At(normalized)
        if (!known.signedOut && (adding || known.serverUrl != activeKey)) return SignIn.Open(known)
        return SignIn.At(known.serverUrl)
    }

    /**
     * GET /server's answer for an entry's own server (never another entry's): the name and the icon follow it; the
     * workspace_id first recorded stays (a server may claim another one's id later; WORKSPACES.md §5.1).
     */
    fun withServerInfo(entry: Workspace, info: ServerInfoOut): Workspace = entry.copy(
        name = info.name.ifBlank { entry.name },
        workspaceId = entry.workspaceId ?: info.workspaceId.ifBlank { null },
        iconVersion = if (info.knowsIcon) info.iconVersion else entry.iconVersion,
    )

    /**
     * The list after a sign-in at [serverUrl] (login form, Google, invite): its entry is renewed (or added at the end)
     * with the account and [info] from that same server; the workspace_id first recorded stays; no other entry changes.
     */
    fun signedIn(
        entries: List<Workspace>,
        serverUrl: String,
        username: String,
        userId: String,
        info: ServerInfoOut?,
        session: String,
    ): List<Workspace> {
        val known = entries.firstOrNull { it.serverUrl == serverUrl }
        val entry = Workspace(
            serverUrl = serverUrl,
            workspaceId = known?.workspaceId ?: info?.workspaceId?.ifBlank { null },
            name = info?.name?.ifBlank { null } ?: known?.name ?: hostLabel(serverUrl),
            username = username,
            userId = userId,
            iconVersion = if (info?.knowsIcon == true) info.iconVersion else known?.iconVersion,
            session = session,
        )
        return if (known != null) entries.map { if (it.serverUrl == serverUrl) entry else it } else entries + entry
    }

    /**
     * Which workspace a push belongs to (WORKSPACES.md §7): its `workspace_id` when exactly one entry has it; without a
     * match (an older server, an id changed by a restore) the signed-in workspace whose local store has the channel, else
     * the active one. Two or more entries with the id (a server claims another one's) cannot be told apart: the active
     * one, so a tap does not switch. Null (show nothing) when the workspace is signed out on this device.
     */
    suspend fun route(
        entries: List<Workspace>,
        activeKey: String?,
        workspaceId: String?,
        channelId: String?,
        hasChannel: suspend (Workspace, String) -> Boolean,
    ): Workspace? {
        val signedIn = entries.filter { !it.signedOut }
        if (workspaceId != null) {
            val owners = entries.filter { it.workspaceId == workspaceId }
            if (owners.size == 1) return owners.single().takeUnless { it.signedOut }
            if (owners.size > 1) return signedIn.firstOrNull { it.serverUrl == activeKey }
        }
        if (channelId != null) {
            for (entry in signedIn.sortedByDescending { it.serverUrl == activeKey }) {
                if (hasChannel(entry, channelId)) return entry
            }
        }
        return signedIn.firstOrNull { it.serverUrl == activeKey }
    }
}
