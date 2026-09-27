package jp.chikuwachat.android.app

import androidx.compose.ui.graphics.asImageBitmap
import android.graphics.BitmapFactory
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.ui.Dnd
import jp.chikuwachat.android.api.ReminderOut
import java.util.UUID
import java.time.ZonedDateTime
import jp.chikuwachat.android.ui.Schedule
import jp.chikuwachat.android.api.ScheduledOut
import kotlinx.serialization.json.JsonObject
import jp.chikuwachat.android.ui.Permalink
import android.content.ClipboardManager
import android.content.ClipData
import android.app.Application
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import jp.chikuwachat.android.BuildConfig
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.InvitePreviewOut
import jp.chikuwachat.android.ui.Invite
import jp.chikuwachat.android.ui.SlashCommands
import jp.chikuwachat.android.ui.Share
import jp.chikuwachat.android.ui.Totp
import jp.chikuwachat.android.api.TotpEnabledOut
import jp.chikuwachat.android.api.TotpSetupOut
import jp.chikuwachat.android.api.TotpStatusOut
import jp.chikuwachat.android.api.LinkPreviewOut
import androidx.compose.runtime.mutableStateMapOf
import kotlinx.serialization.json.put
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.api.SearchOut
import jp.chikuwachat.android.ui.openDownloaded
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.platform.PushCenter
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.platform.fetchFcmToken
import jp.chikuwachat.android.platform.RoomPersistence
import jp.chikuwachat.android.platform.AvatarCache
import jp.chikuwachat.android.platform.SecretStore
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.OkHttpWsTransport
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.Mentions
import jp.chikuwachat.android.ui.channelTitle
import jp.chikuwachat.android.ui.plainText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Application controller: login, session restore and the sync engine lifecycle. Everything runs on
 * the main thread (Compose state + the engine's work queue); network I/O is dispatched inside ApiClient.
 */
class AppController(private val app: Application) {
    enum class Screen { BOOT, LOGIN, CHANGE_PASSWORD, MAIN }

    var screen by mutableStateOf(Screen.BOOT)
        private set
    var error by mutableStateOf<String?>(null)
    /** A short confirmation (「リンクをコピーしました」); null when nothing to say. */
    var notice by mutableStateOf<String?>(null)
    /** M12i: the last login was refused for lack of an authenticator code; the form asks for one. */
    var totpRequired by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    var me by mutableStateOf<UserMe?>(null)
        private set
    var store by mutableStateOf(Store())
        private set
    var engine: SyncEngine? = null
        private set
    var engineStatus by mutableStateOf(EngineStatus.IDLE)
        private set
    /** Channel to open once the store knows it (from a tapped notification). */
    var pendingChannelId by mutableStateOf<String?>(null)
    /** A message to reveal once the main screen sees it (M12b permalink tapped in a body). */
    var pendingReveal by mutableStateOf<jp.chikuwachat.android.api.MessageOut?>(null)
    /** The server we are logged into (for permalinks); null before login. */
    val serverBase: String? get() = api?.baseUrl
    data class MessageFocus(val channelId: String, val messageId: String, val parentId: String?, val context: List<MessageState>)
    var messageFocus by mutableStateOf<MessageFocus?>(null)
    suspend fun revealMessage(message: jp.chikuwachat.android.api.MessageOut): Boolean =
        revealMessage(message.id, message.channelId, message.parentId)

    /** Focus a message known only by its ids (M11i files list): the context comes from the server. */
    suspend fun revealMessage(messageId: String, channelId: String, parentId: String?): Boolean {
        val api = api ?: return false
        return try {
            val context = api.messageContext(messageId)
            parentId?.let { parent -> api.replies(parent).forEach { store.upsertMessage(it) } }
            messageFocus = MessageFocus(channelId, messageId, parentId, context.map { MessageState.from(it) })
            true
        } catch (e: Exception) { error = describe(e); false }
    }
    var savedServer = DEFAULT_SERVER
        private set
    var savedUsername = ""
        private set

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val secrets = SecretStore(app)
    private val notifier = Notifier(app)
    /** FCM token registration (PUSH_NOTIFICATIONS.md §3); a no-op until Firebase is configured. */
    val push = PushCenter(scope, { fetchFcmToken(app) }, { api })
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private var api: ApiClient? = null
    private var persistence: RoomPersistence? = null
    var appForeground by mutableStateOf(false)
        private set
    private var booted = false

    private fun account(server: String, username: String) = "$server|$username"

    private fun makeApi(server: String, username: String): ApiClient {
        val account = account(server, username)
        val api = ApiClient(server, http)
        api.onTokens = { tokens -> scope.launch { secrets.putSecret(account, tokens.refreshToken) } }
        AvatarCache.fetcher = { path -> api.fetchBytes(path) }  // M14a
        AvatarCache.scope = scope
        api.onSignedOut = { scope.launch { if (this@AppController.api === api) handleSignedOut(account) } }
        return api
    }

    /** Startup: restore the previous session with the stored refresh token (SYNC_PROTOCOL.md §7.2). */
    suspend fun boot() {
        if (booted) return
        booted = true
        savedServer = secrets.setting(SERVER_KEY) ?: DEFAULT_SERVER
        savedUsername = secrets.setting(USERNAME_KEY) ?: ""
        val refreshToken = if (savedUsername.isEmpty()) null else secrets.secret(account(savedServer, savedUsername))
        if (refreshToken == null) {
            screen = Screen.LOGIN
            return
        }
        val api = makeApi(savedServer, savedUsername)
        api.refreshToken = refreshToken
        this.api = api
        if (startEngine(api, restoring = true)) return
        busy = true
        try {
            val tokens = api.refresh()
            enterSession(api, savedUsername, tokens.user)
        } catch (e: Exception) {
            screen = Screen.LOGIN
            error = if (e is ApiException.Api && e.isAuth) null else describe(e)
        } finally {
            busy = false
        }
    }

    suspend fun login(server: String, username: String, password: String, totpCode: String? = null) {
        val trimmed = server.trim().trimEnd('/')
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
            error = "サーバ URL が正しくありません"
            return
        }
        val api = makeApi(trimmed, username)
        busy = true
        try {
            val tokens = api.login(username, password, "android", Build.MODEL, BuildConfig.VERSION_NAME, totpCode?.let(Totp::normalize))
            secrets.putSetting(SERVER_KEY, trimmed)
            secrets.putSetting(USERNAME_KEY, username)
            savedServer = trimmed
            savedUsername = username
            error = null
            totpRequired = false
            enterSession(api, username, tokens.user)
        } catch (e: ApiException.Api) {
            when (e.code) {
                "totp_required" -> { totpRequired = true; error = null }
                "invalid_totp" -> { totpRequired = true; error = Totp.errorText(e.code) }
                else -> { totpRequired = false; error = describe(e) }
            }
        } catch (e: Exception) {
            error = describe(e)
        } finally {
            busy = false
        }
    }

    // --- two-factor authentication (M12i): the settings dialog drives these -----------------

    suspend fun totpStatus(): TotpStatusOut? = runCatching { api!!.totpStatus() }.getOrElse { error = describe(it); null }

    /** The failure text is `Totp.errorText` when 2FA specific, else the general description. */
    suspend fun beginTotpSetup(password: String): Result<TotpSetupOut> = runCatching { api!!.totpSetup(password) }

    suspend fun enableTotp(code: String): Result<TotpEnabledOut> = runCatching { api!!.totpEnable(Totp.normalize(code)) }

    suspend fun disableTotp(password: String): String? =
        runCatching { api!!.totpDisable(password); null }.getOrElse { totpFailure(it) }

    fun totpFailure(e: Throwable): String = (e as? ApiException.Api)?.let { Totp.errorText(it.code) } ?: describe(e)

    /** M12h: what an invite link offers, before any account exists (throws on a dead link). */
    suspend fun previewInvite(server: String, token: String): InvitePreviewOut = ApiClient(server, http).invitePreview(token)

    /** M12h: create the account the link allows and enter the session; returns the failure text, if any. */
    suspend fun acceptInvite(server: String, token: String, username: String, displayName: String, password: String): String? {
        val api = makeApi(server, username)
        busy = true
        return try {
            val tokens = api.acceptInvite(token, username, displayName, password, "android", Build.MODEL, BuildConfig.VERSION_NAME)
            secrets.putSetting(SERVER_KEY, server)
            secrets.putSetting(USERNAME_KEY, username)
            savedServer = server
            savedUsername = username
            error = null
            enterSession(api, username, tokens.user)
            null
        } catch (e: Exception) {
            (e as? ApiException.Api)?.let { Invite.errorText(it.code) } ?: describe(e)
        } finally {
            busy = false
        }
    }

    suspend fun changePassword(current: String, new: String) {
        val api = api ?: return
        busy = true
        try {
            api.changePassword(current, new)
            me = api.me()
            error = null
            startEngine(api)
        } catch (e: Exception) {
            error = describe(e)
        } finally {
            busy = false
        }
    }

    private suspend fun enterSession(api: ApiClient, username: String, me: UserMe) {
        this.api = api
        this.me = me
        savedUsername = username
        if (me.mustChangePassword) {
            screen = Screen.CHANGE_PASSWORD
            return
        }
        startEngine(api)
    }

    private suspend fun startEngine(api: ApiClient, restoring: Boolean = false): Boolean {
        engine?.stop()
        messageFocus = null
        persistence?.close()
        val account = account(api.baseUrl, savedUsername)
        val persistence = withContext(Dispatchers.IO) { runCatching { RoomPersistence.open(app, account) }.getOrNull() }
        val store = Store(persistence)
        withContext(Dispatchers.IO) { store.load() }
        this.persistence = persistence
        this.store = store
        if (restoring) {
            val cached = store.me ?: return false
            if (cached.mustChangePassword) return false
            me = cached
        } else me?.let { store.setMe(it) }
        val engine = SyncEngine(
            api = api,
            connect = { url, _ -> OkHttpWsTransport.connect(http, url) },
            wsUrl = api.wsUrl,
            store = store,
            getAccessToken = { api.accessToken },
            scope = scope,
        )
        engine.onSignedOut = { scope.launch { if (this@AppController.engine === engine) handleSignedOut(account) } }
        engine.isActive = { appForeground }
        engine.onRead = { channelId -> notifier.clear(channelId) }
        // M12e: a reminder that fires while the app is open (the push is suppressed then) still shows up.
        engine.onReminder = { row ->
            val text = (row.note?.takeIf { it.isNotBlank() }?.let { "$it — " } ?: "") + row.preview
            notice = "⏰ $text"
            if (!Dnd.isActive(store.me?.let { store.users[it.id] ?: it.asPublic })) notifier.notifyMessage(row.channelId, "リマインダー", text)
        }
        engine.onNotify = { message, channel ->
            val sender = store.users[message.senderId]?.displayName ?: "?"
            val title = if (channel.channel.isDm) sender else channelTitle(channel, store) + " · " + sender
            notifier.notifyMessage(channel.id, title, plainText(Mentions.toNames(message.body, store.users, store.groups)).ifEmpty { "新しいメッセージ" })
        }
        this.engine = engine
        scope.launch { engine.status.collect { if (this@AppController.engine === engine) engineStatus = it } }
        engine.prepareConnection = prepare@{
            val tokens = api.refresh()
            if (this.api !== api || this.engine !== engine) return@prepare
            me = tokens.user
            store.setMe(tokens.user)
            if (tokens.user.mustChangePassword) {
                engine.stop()
                screen = Screen.CHANGE_PASSWORD
                throw IllegalStateException("Password change required")
            }
            push.attach()
        }
        screen = Screen.MAIN
        scope.launch { engine.start() }
        return true
    }

    /**
     * A data-only push (PUSH_NOTIFICATIONS.md §9): shown unless the app is in the foreground with a
     * live socket (the event arrives over the socket then); either way the engine catches up.
     */
    fun handlePush(message: PushMessage) {
        scope.launch {
            val live = appForeground && engineStatus == EngineStatus.ONLINE
            if (!message.isSilent && !live && message.channelId != null) {
                notifier.notifyMessage(message.channelId, message.title, message.body)
            }
            engine?.reconnectNow()
        }
    }

    /** Foreground / background from the activity: drives push suppression and reconnects (§7.5). */
    fun setForeground(active: Boolean) {
        appForeground = active
        if (active) {
            engine?.reconnectNow()
            if (api != null) push.refresh()
        }
    }

    suspend fun openChannel(channelId: String) {
        runCatching { engine?.openChannel(channelId) }.onFailure { error = describe(it) }
    }

    fun closeChannel() {
        // Nothing to do yet: the engine keeps currentChannelId for notification suppression only.
    }

    suspend fun logout() {
        engine?.stop()
        engine = null
        val api = api
        if (api == null) {
            screen = Screen.LOGIN
            return
        }
        api.logout() // onSignedOut → handleSignedOut
    }

    private suspend fun handleSignedOut(account: String) {
        AvatarCache.reset()
        engine?.stop()
        engine = null
        api = null
        me = null
        engineStatus = EngineStatus.IDLE
        secrets.putSecret(account, null)
        screen = Screen.LOGIN
    }

    // --- channel actions used by the dialogs (results carry the channel id to open) ----------------

    suspend fun createChannel(name: String, type: String): Result<String> = runCatching {
        val channel = api!!.createChannel(name, type)
        store.upsertChannel(channel, isMember = true).id
    }

    suspend fun createDm(userIds: List<String>): Result<String> = runCatching {
        val channel = api!!.createDm(userIds)
        store.upsertChannel(channel, isMember = true).id
    }

    suspend fun joinChannel(channelId: String): Boolean = runCatching {
        val channel = api!!.joinChannel(channelId)
        store.upsertChannel(channel, isMember = true)
        true
    }.getOrElse { error = describe(it); false }

    // --- message actions (M8a): apply the server's answer at once; the WS event is deduplicated -----

    suspend fun editMessage(messageId: String, body: String): Result<Unit> =
        runCatching { store.upsertMessage(api!!.editMessage(messageId, body)); Unit }.onFailure { error = describe(it) }

    suspend fun deleteMessage(messageId: String): Result<Unit> =
        runCatching { store.upsertMessage(api!!.deleteMessage(messageId)); Unit }.onFailure { error = describe(it) }

    suspend fun listPins(channelId: String): Result<List<jp.chikuwachat.android.api.MessageOut>> = runCatching { api!!.listPins(channelId) }
    suspend fun listBookmarks(cursor: String? = null): Result<jp.chikuwachat.android.api.BookmarkListOut> = runCatching { api!!.listBookmarks(cursor) }
    suspend fun listMentions(cursor: String? = null): Result<jp.chikuwachat.android.api.MentionListOut> = runCatching { api!!.listMentions(cursor) }
    suspend fun listFiles(channelId: String? = null, query: String? = null, cursor: String? = null): Result<jp.chikuwachat.android.api.FileListOut> =
        runCatching { api!!.listFiles(channelId, query, cursor) }
    /** M11h: every public channel plus my private ones, for the channel browser. */
    suspend fun browseChannels(): Result<List<jp.chikuwachat.android.api.ChannelOut>> =
        runCatching { api!!.channels(includePublic = true).filter { it.type == "public" || it.type == "private" } }

    // --- link previews (M11g): one fetch per URL per session ------------------------------------

    /** url → preview (null value = failed / none); Compose reads this map, [loadLinkPreview] fills it. */
    val linkPreviews = mutableStateMapOf<String, LinkPreviewOut?>()
    private val previewLoads = HashSet<String>()

    suspend fun loadLinkPreview(url: String) {
        val api = api ?: return
        if (linkPreviews.containsKey(url) || !previewLoads.add(url)) return
        try {
            val preview = api.linkPreview(url)
            linkPreviews[url] = if (preview.status == "ok") preview else null
        } catch (e: Exception) {
            linkPreviews[url] = null // refused or rate limited: no card this session
        } finally {
            previewLoads.remove(url)
        }
    }

    /** M11c: any member pins / unpins; the updated message (with pinnedAt) replaces the row. */
    suspend fun togglePin(message: MessageState) {
        val api = api ?: return
        try {
            store.upsertMessage(if (message.pinnedAt != null) api.unpinMessage(message.id) else api.pinMessage(message.id))
        } catch (e: Exception) { error = describe(e) }
    }

    // --- custom emoji (M12f) ----------------------------------------------------------------------

    private val emojiLoads = HashSet<String>()

    /** Fetches an emoji image once into the store's cache. */
    fun loadEmojiImage(emoji: CustomEmojiOut) {
        if (store.emojiImages.containsKey(emoji.id) || !emojiLoads.add(emoji.id)) return
        scope.launch {
            try {
                val bytes = fetchBytes("/api/v1/emoji/${emoji.id}/image")
                val bitmap = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
                if (bitmap != null) store.setEmojiImage(emoji.id, bitmap)
            } catch (_: Exception) {
                // the text form stays; a later render retries
            } finally { emojiLoads.remove(emoji.id) }
        }
    }

    // --- reminders (M12e) -------------------------------------------------------------------------

    suspend fun setReminder(messageId: String, at: ZonedDateTime, note: String? = null): Boolean {
        val api = api ?: return false
        return try {
            store.applyReminder(api.createReminder(messageId, at.toInstant().toString(), note))
            notice = Schedule.label(at) + " にリマインドします"
            true
        } catch (e: Exception) { error = describe(e); false }
    }

    /** Cancels a pending reminder or marks a fired one done. */
    suspend fun closeReminder(row: ReminderOut) {
        val api = api ?: return
        try {
            api.closeReminder(row.id)
            store.applyReminder(row.copy(status = if (row.status == "fired") "done" else "cancelled"))
        } catch (e: Exception) { error = describe(e) }
    }

    // --- scheduled messages (M12d) ----------------------------------------------------------------

    /** 「後で送信」: the server posts the draft at `sendAt`; the row shows up under 下書き. */
    suspend fun scheduleMessage(channelId: String, parentId: String?, body: String, attachmentIds: List<String>, sendAt: ZonedDateTime): Boolean {
        val api = api ?: return false
        return try {
            val row = api.scheduleMessage(channelId, UUID.randomUUID().toString(), body, parentId, attachmentIds, sendAt.toInstant().toString())
            store.applyScheduled(row)
            notice = Schedule.label(sendAt) + " に送信します"
            true
        } catch (e: Exception) { error = describe(e); false }
    }

    /** Cancel a scheduled message; its text returns to the conversation's draft so nothing is lost. */
    suspend fun cancelScheduled(row: ScheduledOut) {
        val api = api ?: return
        try {
            api.cancelScheduled(row.id)
            store.applyScheduled(row.copy(status = "cancelled"))
            if (row.body.isNotEmpty()) store.setDraft(row.channelId, row.parentId) { it.copy(text = row.body) }
        } catch (e: Exception) { error = describe(e) }
    }

    suspend fun sendScheduledNow(row: ScheduledOut) {
        val api = api ?: return
        try {
            api.sendScheduledNow(row.id)
            store.applyScheduled(row.copy(status = "sent"))
        } catch (e: Exception) { error = describe(e) }
    }

    // --- permalinks (M12b) ------------------------------------------------------------------------

    fun copyPermalink(messageId: String) {
        val base = serverBase ?: return
        val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("ChikuwaChat", Permalink.url(base, messageId)))
        notice = "リンクをコピーしました"
    }

    /** A permalink tapped in a body: fetch the message (membership is checked there) and hand it to the screen. */
    suspend fun openPermalink(messageId: String) {
        val api = api ?: return
        try {
            val message = api.message(messageId)
            if (revealMessage(message)) pendingReveal = message
        } catch (e: Exception) { error = describe(e) }
    }

    /** M12a: a starred channel; the flag moves at once, favorite.updated confirms on every device. */
    suspend fun toggleFavorite(channelId: String) {
        val api = api ?: return
        val on = !store.isFavorite(channelId)
        store.setFavorite(channelId, on)
        try {
            if (on) api.favoriteChannel(channelId) else api.unfavoriteChannel(channelId)
        } catch (e: Exception) {
            store.setFavorite(channelId, !on)
            error = describe(e)
        }
    }

    /** M12a 「すべて既読にする」. */
    suspend fun markAllRead() {
        val engine = engine ?: return
        try { engine.markAllRead() } catch (e: Exception) { error = describe(e) }
    }

    /** M11c: saved for me only; the flag moves at once, bookmark.updated confirms on every device. */
    suspend fun toggleBookmark(messageId: String) {
        val api = api ?: return
        val on = !store.isBookmarked(messageId)
        store.setBookmarked(messageId, on)
        try {
            if (on) api.bookmarkMessage(messageId) else api.unbookmarkMessage(messageId)
        } catch (e: Exception) {
            store.setBookmarked(messageId, !on)
            error = describe(e)
        }
    }

    suspend fun toggleReaction(message: MessageState, emoji: String): Result<Unit> = runCatching {
        val me = store.me ?: return@runCatching
        val updated = if (message.reactedBy(me.id, emoji)) api!!.removeReaction(message.id, emoji) else api!!.addReaction(message.id, emoji)
        store.upsertMessage(updated)
        Unit
    }.onFailure { error = describe(it) }

    val isAdmin: Boolean get() = me?.role == "admin"
    /** M13e: confined to the channels they were added to; browsing and creation are hidden. */
    val isGuest: Boolean get() = me?.role == "guest"

    suspend fun searchMessages(query: String, offset: Int = 0): Result<SearchOut> =
        runCatching { api!!.searchMessages(query, offset = offset) }.onFailure { error = describe(it) }

    // --- attachments (M9a) ---------------------------------------------------------------------------

    suspend fun fetchBytes(path: String): ByteArray = api!!.fetchBytes(path)

    /** Read a picked content URI and upload it; the id is bound when the message is sent. */
    suspend fun uploadAttachment(uri: Uri): Result<AttachmentOut> = runCatching {
        val api = api ?: error("ログインが必要です")
        val resolver = app.contentResolver
        var name = "file"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) name = cursor.getString(0) ?: name
        }
        val bytes = withContext(Dispatchers.IO) { resolver.openInputStream(uri)?.use { it.readBytes() } } ?: error("読み込めませんでした")
        api.uploadAttachment(bytes, name, resolver.getType(uri))
    }.onFailure { error = describe(it) }

    fun openAttachment(attachment: AttachmentOut) {
        scope.launch {
            runCatching {
                val bytes = fetchBytes("/api/v1/attachments/${attachment.id}/content")
                openDownloaded(app as Context, attachment, bytes)
            }.onFailure { error = describe(it) }
        }
    }

    suspend fun members(channelId: String): Result<List<String>> = runCatching { api!!.members(channelId).map { it.userId } }

    suspend fun memberList(channelId: String): Result<List<MemberOut>> = runCatching { api!!.members(channelId) }

    // --- channel info & settings (UI brush-up) --------------------------------------------------

    suspend fun updateTopic(channelId: String, topic: String): Boolean = runCatching {
        val channel = api!!.updateChannel(channelId, topic = topic.trim())
        store.upsertChannel(channel)
        true
    }.getOrElse { error = describe(it); false }

    // --- channel management (M11h) ------------------------------------------------------------------

    suspend fun updatePurpose(channelId: String, purpose: String): Boolean = runCatching {
        store.upsertChannel(api!!.updateChannel(channelId, purpose = purpose.trim()))
        true
    }.getOrElse { error = describe(it); false }

    suspend fun renameChannel(channelId: String, name: String): Boolean = runCatching {
        store.upsertChannel(api!!.updateChannel(channelId, name = name.trim()))
        true
    }.getOrElse { error = describe(it); false }

    /** M15a: "owners" makes an announcement channel (owners and admins start the posts). */
    suspend fun setPostingPolicy(channelId: String, policy: String): Boolean = runCatching {
        store.upsertChannel(api!!.updateChannel(channelId, postingPolicy = policy))
        true
    }.getOrElse { error = describe(it); false }

    /** M15b: public → private (owner / admin) or private → public (admin only). */
    suspend fun convertChannel(channelId: String, type: String): Boolean = runCatching {
        store.upsertChannel(api!!.updateChannel(channelId, type = type))
        true
    }.getOrElse { error = describe(it); false }

    suspend fun archiveChannel(channelId: String): Boolean = runCatching {
        store.upsertChannel(api!!.archiveChannel(channelId))
        true
    }.getOrElse { error = describe(it); false }

    suspend fun unarchiveChannel(channelId: String): Boolean = runCatching {
        store.upsertChannel(api!!.unarchiveChannel(channelId))
        true
    }.getOrElse { error = describe(it); false }

    /** M13c: post a quote of `message` and its permalink into another conversation. */
    suspend fun shareMessage(message: MessageState, channelId: String, comment: String): Boolean {
        val base = serverBase ?: return false
        val engine = engine ?: return false
        engine.send(channelId, Share.body(message.body, Permalink.url(base, message.id), comment))
        notice = "共有しました"
        return true
    }

    /** Leaving drops the channel locally at once; the server's member_removed confirms it. */
    suspend fun leaveChannel(channelId: String): Boolean = runCatching {
        api!!.leaveChannel(channelId)
        store.removeChannel(channelId)
        true
    }.getOrElse { error = describe(it); false }

    suspend fun setNotification(channelId: String, level: String, mutedUntil: String? = null): Boolean = runCatching {
        val pref = api!!.setNotificationPreference(channelId, level, mutedUntil)
        store.setNotification(channelId, pref.level, pref.mutedUntil)
        true
    }.getOrElse { error = describe(it); false }

    /** M11d: title / custom status. Pass null for a field to clear it; absent keys keep their value. */
    suspend fun updateProfile(fields: Map<String, String?>): Boolean =
        updateProfileJson(buildJsonObject { fields.forEach { (key, value) -> if (value == null) put(key, JsonNull) else put(key, value) } })

    /** M12c: quiet_hours is an object, so the status dialog builds the body itself. */
    suspend fun updateProfileJson(body: JsonObject): Boolean = runCatching {
        val updated = api!!.updateProfile(body)
        me = updated
        store.setMe(updated)
        store.upsertUser(updated.asPublic)
        true
    }.getOrElse { error = describe(it); false }

    /** Open (or create) the DM with one user; returns its channel id. */
    suspend fun openDmWith(userId: String): String? {
        store.channels.values.firstOrNull { it.channel.type == "dm" && userId in (it.channel.dmUserIds ?: emptyList()) && (it.channel.dmUserIds?.size ?: 0) <= 2 }?.let { return it.id }
        return createDm(listOf(userId)).getOrElse { error = describe(it); null }
    }

    /** M14a: choose (or drop) my profile picture; the store learns the new version at once. */
    suspend fun uploadAvatar(uri: Uri): Boolean = runCatching {
        val api = api ?: error("ログインが必要です")
        val resolver = app.contentResolver
        val bytes = withContext(Dispatchers.IO) { resolver.openInputStream(uri)?.use { it.readBytes() } } ?: error("読み込めませんでした")
        val updated = api.uploadAvatar(bytes, resolver.getType(uri))
        me = updated
        store.setMe(updated)
        true
    }.getOrElse { error = describe(it); false }

    suspend fun deleteAvatar(): Boolean = runCatching {
        val updated = api!!.deleteAvatar()
        me = updated
        store.setMe(updated)
        true
    }.getOrElse { error = describe(it); false }

    suspend fun updateDisplayName(displayName: String): Boolean = runCatching {
        val updated = api!!.updateMe(displayName = displayName.trim())
        me = updated
        store.setMe(updated)
        true
    }.getOrElse { error = describe(it); false }

    /** Password change from the settings sheet; returns the error text or null. */
    // --- sidebar sections (M14f) -------------------------------------------------------------

    private suspend fun sidebarChange(work: suspend (ApiClient) -> List<jp.chikuwachat.android.api.SidebarSectionOut>): Boolean = runCatching {
        store.replaceSidebar(work(api!!)); true
    }.getOrElse { error = describe(it); false }

    /** A new section at the end; with `channelId`, that conversation moves into it. */
    suspend fun createSection(name: String, channelId: String?): Boolean {
        val before = store.sidebarSections.map { it.id }.toSet()
        if (!sidebarChange { it.createSidebarSection(name) }) return false
        val created = store.sidebarSections.firstOrNull { it.id !in before }
        return if (channelId != null && created != null) moveToSection(channelId, created.id) else true
    }

    suspend fun renameSection(id: String, name: String): Boolean = sidebarChange { it.updateSidebarSection(id, name = name) }
    suspend fun moveSection(id: String, position: Int): Boolean = sidebarChange { it.updateSidebarSection(id, position = position) }
    suspend fun deleteSection(id: String): Boolean = sidebarChange { it.deleteSidebarSection(id) }

    /** `sectionId` null puts the conversation back in the default sections. */
    suspend fun moveToSection(channelId: String, sectionId: String?): Boolean =
        sidebarChange { api -> if (sectionId != null) api.placeInSidebarSection(sectionId, channelId) else api.removeFromSidebarSection(channelId) }

    // --- edit history (M14c) -------------------------------------------------------------------

    suspend fun messageRevisions(messageId: String): List<jp.chikuwachat.android.api.MessageRevisionOut>? =
        runCatching { api!!.messageRevisions(messageId) }.getOrElse { error = describe(it); null }

    // --- polls (M14b) ------------------------------------------------------------------------

    suspend fun vote(message: MessageState, option: Int, present: Boolean): Boolean = runCatching {
        store.upsertMessage(api!!.vote(message.id, option, present)); true
    }.getOrElse { error = describe(it); false }

    suspend fun closePoll(message: MessageState): Boolean = runCatching {
        store.upsertMessage(api!!.closePoll(message.id)); true
    }.getOrElse { error = describe(it); false }

    suspend fun createPoll(channelId: String, parentId: String?, question: String, options: List<String>, multiple: Boolean): Boolean = runCatching {
        store.upsertMessage(api!!.postPoll(channelId, parentId, question, options, multiple)); true
    }.getOrElse { error = describe(it); false }

    // --- slash commands (M13b) ---------------------------------------------------------------

    /** Runs a command typed in the composer; false when it could not (the reason is in `error`). */
    suspend fun runCommand(command: SlashCommands.Parsed, channelId: String, parentId: String?): Boolean {
        val api = api ?: return false
        val state = store.channels[channelId] ?: return false
        val isDm = state.channel.type == "dm" || state.channel.type == "group_dm"
        val spec = SlashCommands.all.firstOrNull { it.name == command.name }
        if (spec == null) { error = "/${command.name} というコマンドはありません (/help で一覧)"; return false }
        if (spec.channelOnly && isDm) { error = "/${command.name} はチャンネルでだけ使えます"; return false }
        fun user(handle: String) = store.users.values.firstOrNull { it.username.equals(handle.removePrefix("@"), ignoreCase = true) }
        val level = state.channel.notification?.level ?: if (isDm) "all" else "mentions"
        return when (command.name) {
            "help" -> { notice = SlashCommands.all.joinToString(" · ") { it.usage }; true }
            "status" -> {
                if (command.args.isEmpty() || command.args == "clear") {
                    updateProfileJson(buildJsonObject { put("status_text", JsonNull); put("status_emoji", JsonNull); put("status_expires_at", JsonNull) })
                        .also { if (it) notice = "ステータスを消しました" }
                } else {
                    val (emoji, text) = SlashCommands.splitStatus(command.args)
                    updateProfileJson(buildJsonObject {
                        put("status_text", text.ifEmpty { null }?.let { JsonPrimitive(it) } ?: JsonNull)
                        put("status_emoji", emoji?.let { JsonPrimitive(it) } ?: JsonNull)
                        put("status_expires_at", JsonNull)
                    }).also { if (it) notice = "ステータスを更新しました" }
                }
            }
            "dnd" -> {
                if (command.args.isEmpty() || command.args == "off") {
                    updateProfileJson(buildJsonObject { put("dnd_until", JsonNull) }).also { if (it) notice = "通知の一時停止を解除しました" }
                } else {
                    val until = SlashCommands.duration(command.args)
                    if (until == null) { error = "/dnd 30m | 1h | 2h | 4h | tomorrow | off"; false }
                    else updateProfileJson(buildJsonObject { put("dnd_until", until.toInstant().toString()) }).also { if (it) notice = Schedule.label(until) + " まで通知を止めます" }
                }
            }
            "topic" -> updateTopic(channelId, command.args)
            "leave" -> leaveChannel(channelId)
            "invite" -> {
                val handles = command.args.split(Regex("\\s+")).filter { it.isNotEmpty() }
                if (handles.isEmpty()) { error = "/invite @名前"; return false }
                for (handle in handles) {
                    val target = user(handle)
                    if (target == null) { error = "$handle というユーザーはいません"; return false }
                    val added = addMember(channelId, target.id)
                    if (added.isFailure) { error = describe(added.exceptionOrNull()!!); return false }
                }
                notice = "${handles.size} 人を追加しました"
                true
            }
            "join" -> {
                val name = command.args.removePrefix("#").lowercase()
                val target = store.channels.values.firstOrNull { it.channel.type == "public" && (it.channel.name ?: "").lowercase() == name }
                if (target == null) { error = "#$name という公開チャンネルはありません"; return false }
                if (!target.isMember && !joinChannel(target.id)) return false
                pendingChannelId = target.id
                true
            }
            "dm" -> {
                val target = user(command.args.substringBefore(' '))
                if (target == null) { error = "/dm @名前"; return false }
                val id = openDmWith(target.id) ?: return false
                pendingChannelId = id
                true
            }
            "mute" -> {
                val until = if (command.args.isEmpty()) ZonedDateTime.now().plusHours(8) else SlashCommands.duration(command.args)
                if (until == null) { error = "/mute 1h | 8h | tomorrow"; return false }
                setNotification(channelId, level, until.toInstant().toString()).also { if (it) notice = Schedule.label(until) + " まで通知を止めます" }
            }
            "unmute" -> setNotification(channelId, level, null).also { if (it) notice = "通知を再開しました" }
            "me" -> {
                if (command.args.isEmpty()) return false
                engine?.send(channelId, "_${command.args}_", parentId = parentId)
                true
            }
            "shrug" -> {
                engine?.send(channelId, (if (command.args.isEmpty()) "" else command.args + " ") + SlashCommands.SHRUG, parentId = parentId)
                true
            }
            "poll" -> {
                val parts = command.args.split("|").map { it.trim() }.filter { it.isNotEmpty() }
                if (parts.size < 3) { error = "/poll 質問 | 選択肢 | 選択肢 …"; return false }
                createPoll(channelId, parentId, parts[0], parts.drop(1), multiple = false)
            }
            else -> false
        }
    }

    suspend fun changePasswordInSession(current: String, new: String): String? =
        runCatching { api!!.changePassword(current, new); null }.getOrElse { describe(it) }

    suspend fun addMember(channelId: String, userId: String): Result<Unit> = runCatching<Unit> { api!!.addMember(channelId, userId) }

    fun describe(e: Throwable): String = when (e) {
        is ApiException.Api -> when (e.code) {
            "invalid_credentials" -> "ユーザー名またはパスワードが違います"
            "rate_limited" -> "しばらく待ってからやり直してください"
            "password_too_short" -> "パスワードが短すぎます"
            "invalid_password" -> "現在のパスワードが違います"
            else -> e.detail.ifBlank { e.code }
        }
        is ApiException.Network -> "サーバに接続できません"
        else -> e.message ?: e.toString()
    }

    private companion object {
        const val SERVER_KEY = "server"
        const val USERNAME_KEY = "username"
        // 10.0.2.2 is the host machine from the Android emulator.
        const val DEFAULT_SERVER = "http://10.0.2.2:8000"
    }
}
