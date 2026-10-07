package jp.chikuwachat.android.app

import jp.chikuwachat.android.AppLanguage
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import android.graphics.Bitmap
import android.util.Log
import androidx.compose.ui.graphics.asImageBitmap
import android.graphics.BitmapFactory
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.platform.AvatarPhoto
import jp.chikuwachat.android.ui.QuickReactions
import jp.chikuwachat.android.ui.CanvasMarkers
import jp.chikuwachat.android.ui.Dnd
import jp.chikuwachat.android.ui.CalendarChannels
import jp.chikuwachat.android.ui.CalendarDates
import jp.chikuwachat.android.ui.TaskRules
import jp.chikuwachat.android.api.ReminderOut
import java.util.UUID
import java.time.ZonedDateTime
import jp.chikuwachat.android.ui.Schedule
import jp.chikuwachat.android.api.ScheduledOut
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import jp.chikuwachat.android.ui.Permalink
import android.content.ClipboardManager
import android.content.ClipData
import android.content.Intent
import android.app.Application
import android.os.Build
import android.provider.Settings
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.sync.NotificationLevels
import jp.chikuwachat.android.ui.MainTabs
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import jp.chikuwachat.android.BuildConfig
import android.content.ContentResolver
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import androidx.core.net.toUri
import android.provider.OpenableColumns
import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.PoolOut
import jp.chikuwachat.android.api.NavItem
import jp.chikuwachat.android.api.ErrorTexts
import jp.chikuwachat.android.api.InvitePreviewOut
import jp.chikuwachat.android.ui.Invite
import jp.chikuwachat.android.ui.SlashCommands
import jp.chikuwachat.android.ui.Templates
import java.time.LocalDate
import jp.chikuwachat.android.ui.Share
import jp.chikuwachat.android.ui.Totp
import jp.chikuwachat.android.ui.AckReminders
import jp.chikuwachat.android.ui.Recurring
import jp.chikuwachat.android.ui.RecurringDraft
import jp.chikuwachat.android.api.RecurringPostOut
import jp.chikuwachat.android.api.RecurringRunOut
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
import jp.chikuwachat.android.api.SearchRequest
import jp.chikuwachat.android.api.ServerInfoOut
import jp.chikuwachat.android.ui.RecentConversations
import jp.chikuwachat.android.ui.RecentSearches
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.platform.SharedPrefsStore
import jp.chikuwachat.android.platform.WorkspaceIconCache
import jp.chikuwachat.android.ui.openDownloaded
import jp.chikuwachat.android.ui.openCachedFile
import jp.chikuwachat.android.ui.DownloadCache
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.platform.ConversationNote
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.platform.PushCenter
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.platform.deleteFcmToken
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
import jp.chikuwachat.android.ui.formatSize
import jp.chikuwachat.android.ui.messageLine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import java.io.IOException
import java.util.concurrent.TimeUnit
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

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
    /** M66 (docs/AI.md §5): the engine's AI status; null (unknown, or a server without AI) hides every AI entry point. */
    var aiStatus by mutableStateOf<jp.chikuwachat.android.api.AiStatusOut?>(null)
        private set
    /** M66: the summary sheet's request and run; null when it is closed. */
    var aiSummary by mutableStateOf<jp.chikuwachat.android.sync.AiSummaryState?>(null)
        private set
    /** M66: the conversation whose 「要約」 choices (未読 / 直近 1 日 / 直近 7 日) are on screen. */
    var aiSummaryChooser by mutableStateOf<String?>(null)
    /** Review v0.1.18 #2: the engine's summary targets (AiHub.targets), for the line under the 「要約」 choices. */
    var aiSummaryTargets by mutableStateOf<Map<String, jp.chikuwachat.android.api.AiSummaryTargetOut>>(emptyMap())
        private set

    /** Reads where a summary of the conversation would go (the choices are opening). */
    fun loadSummaryTarget(channelId: String) {
        val engine = engine ?: return
        scope.launch { engine.ai.loadTarget(channelId) }
    }
    /** The AI bots' user ids: 「AI」 instead of 「BOT」 on their rows and mention candidates. */
    val aiBotIds: Set<String> get() = aiStatus?.agents?.map { it.botUserId }?.toSet() ?: emptySet()
    /** The same once GET /ai/status was read, null before (the @-mention suggestions then go by bot_kind, AI.md §2.1). */
    val aiBotIdsRead: Set<String>? get() = aiStatus?.agents?.map { it.botUserId }?.toSet()
    val aiSummaryAvailable: Boolean get() = aiStatus?.let { it.available && it.summaryAvailable } == true

    fun requestSummary(request: jp.chikuwachat.android.sync.AiSummaryRequest) {
        aiSummaryChooser = null
        val engine = engine ?: return
        scope.launch { engine.ai.requestSummary(request) }
    }

    fun retrySummary() {
        val engine = engine ?: return
        scope.launch { engine.ai.retry() }
    }

    fun closeSummary() {
        engine?.ai?.closeSummary()
    }

    // --- 「AI に聞く」 (M71, docs/AI.md §13): the engine's AiHub.ask / askTarget, mirrored for the search screen ---
    var aiAsk by mutableStateOf<jp.chikuwachat.android.sync.AiAskState?>(null)
        private set
    var aiAskTarget by mutableStateOf<jp.chikuwachat.android.sync.AiAskTargetRead?>(null)
        private set
    /** The answer sheet is on screen; false while the question is kept behind it (a cited message opened). */
    var aiAskShown by mutableStateOf(false)

    fun loadAskTarget(question: String, channelId: String?) {
        val engine = engine ?: return
        scope.launch { engine.ai.loadAskTarget(question, channelId) }
    }

    fun startAsk(question: String, channelId: String?) {
        val engine = engine ?: return
        aiAskShown = true
        scope.launch { engine.ai.startAsk(question, channelId) }
    }

    fun retryAsk() {
        val engine = engine ?: return
        scope.launch { engine.ai.retryAsk() }
    }

    fun showAskRun(run: jp.chikuwachat.android.api.AiRunOut) {
        val engine = engine ?: return
        engine.ai.showAskRun(run)
        aiAskShown = true
    }

    fun closeAsk() {
        aiAskShown = false
        engine?.ai?.closeAsk()
    }

    /** My recent questions, newest first; null when they cannot be read. */
    suspend fun askHistory(): List<jp.chikuwachat.android.api.AiRunOut>? = engine?.ai?.askHistory()
    /** Channel to open once the store knows it (from a tapped notification). */
    var pendingChannelId by mutableStateOf<String?>(null)
    /**
     * M28c: with [pendingChannelId], the reply a tapped notification was about and its thread's parent (message id to
     * parent id): the thread opens at the reply, as a permalink does. Null for a top-level post (the channel opens).
     */
    var pendingReply by mutableStateOf<Pair<String, String>?>(null)
    /**
     * M39: with [pendingChannelId], the message a tapped reaction notification was about (its thread, if a reply, is not
     * in the push): it is fetched and revealed like a permalink. Null for a message's notification.
     */
    var pendingRevealId by mutableStateOf<String?>(null)
    /** M40: a 自分 screen to open (the own profile card's 「ステータスを設定」): the main screen opens it on the 自分 tab. */
    var pendingSettings by mutableStateOf<jp.chikuwachat.android.ui.SettingsPage?>(null)
    /** T1 (MOBILE_UI.md §12): Ctrl+K on a hardware keyboard (MainActivity): the main screen opens 「移動・検索」. */
    var pendingJump by mutableStateOf(false)
    /** M46: a canvas to open once the main screen sees it (a `/c/<id>` link tapped in a body): its conversation and id. */
    var pendingCanvas by mutableStateOf<Pair<String, String>?>(null)
    /** M122: a page of 「ドキュメント」 to open on the home tab (a tapped notification, a page activity row from elsewhere). */
    var pendingPage by mutableStateOf<String?>(null)
    /** M52: a calendar event to open once the main screen sees it (a tapped alarm): its channel (null: my own) and id. */
    data class PendingEvent(val channelId: String?, val eventId: String)
    var pendingEvent by mutableStateOf<PendingEvent?>(null)
    /** M52: the event form on screen (a row tapped, 「予定を追加」, an alarm); kept here so a rotation keeps it open. */
    var calendarForm by mutableStateOf<jp.chikuwachat.android.ui.CalendarForm?>(null)
    /**
     * M69: 「カレンダーを購読 (iCal)」 on screen (the calendar's ⋮), null when closed; kept here so a rotation keeps it open
     * and keeps the URL just made (shown once).
     */
    var calendarFeeds by mutableStateOf<jp.chikuwachat.android.sync.CalendarFeeds?>(null)

    fun openCalendarFeeds() {
        calendarFeeds = jp.chikuwachat.android.sync.CalendarFeeds(api)
    }
    /** M56: a task to open once the main screen sees it (a tapped notification): its channel (null: a personal one) and id. */
    data class PendingTask(val channelId: String?, val taskId: String)
    var pendingTask by mutableStateOf<PendingTask?>(null)
    /** M56: the task form on screen (a card tapped, 「タスクにする」, a notification); kept here so a rotation keeps it open. */
    var taskForm by mutableStateOf<jp.chikuwachat.android.ui.TaskForm?>(null)
    /** M95: the workflow form on screen (WORKFLOWS.md §8 4.); kept here so a rotation keeps it and its one key. */
    var workflowForm by mutableStateOf<jp.chikuwachat.android.ui.WorkflowSession?>(null)
    /** M95: each channel's workflows, read when a menu opens and kept a minute (§4: their changes send no events). */
    private val workflowLists = jp.chikuwachat.android.ui.Workflows.ListCache()
    /** A message to reveal once the main screen sees it (M12b permalink tapped in a body). */
    var pendingReveal by mutableStateOf<jp.chikuwachat.android.api.MessageOut?>(null)
    /** The server we are logged into (for permalinks); null before login. */
    val serverBase: String? get() = api?.baseUrl
    data class MessageFocus(val channelId: String, val messageId: String, val parentId: String?, val context: List<MessageState>)
    var messageFocus by mutableStateOf<MessageFocus?>(null)

    /**
     * M37 (MOBILE_UI.md §6.1 ✏️): the conversation whose composer takes the focus (and the keyboard) once it shows; the
     * composer clears it. Another conversation opening first clears it too (MainScreen).
     */
    var composerFocus by mutableStateOf<String?>(null)
    suspend fun revealMessage(message: jp.chikuwachat.android.api.MessageOut): Boolean =
        revealMessage(message.id, message.channelId, message.parentId)

    /**
     * Focus a message known only by its ids (M11i files list): the context comes from the server. M27: a link into a
     * public channel I have not joined opens its preview (SYNC_PROTOCOL.md §7.6.1): the channel joins the list as
     * browsable when it was not there (an archived one), and its rows stay out of the store (the preview's thread pane
     * fetches the replies itself).
     */
    suspend fun revealMessage(messageId: String, channelId: String, parentId: String?): Boolean {
        val api = api ?: return false
        return try {
            val context = api.messageContext(messageId)
            if (store.channel(channelId) == null) api.channel(channelId).takeIf { it.membership == null }?.let { store.upsertChannel(it, isMember = false) }
            if (store.channel(channelId)?.isMember == true) parentId?.let { parent -> api.replies(parent).forEach { store.upsertMessage(it) } }
            messageFocus = MessageFocus(channelId, messageId, parentId, context.map { MessageState.from(it) })
            true
        } catch (e: Exception) { report(e); false }
    }
    /** What the login form starts from: the workspace it signs in to, else the last server and user. */
    var savedServer = DEFAULT_SERVER
        private set
    var savedUsername = ""
        private set

    /** M96: what the login form starts with: the account's username now (it may have changed since signing in). */
    val loginUsername: String
        get() = workspaces.firstOrNull { it.serverUrl == savedServer && it.username == savedUsername }?.signInName ?: savedUsername

    /**
     * M96: the account's username now reaches the saved entry (the list and the next login form show it); `username`
     * keeps naming the refresh token and the local database. Called with every UserMe this device gets: a rename here,
     * a token refresh (every 15 minutes at most), bootstrap and a sign-in.
     */
    private fun followUsername(serverUrl: String, live: String) {
        updateWorkspace(serverUrl) { entry -> entry.copy(loginName = live.takeIf { it != entry.username }) }
    }

    // --- workspaces (M16c, WORKSPACES.md) ---------------------------------------------------------

    /** The servers this device knows, in the order they were added. */
    var workspaces by mutableStateOf<List<Workspace>>(emptyList())
        private set
    /** The workspace on screen (its server URL, the list key); null before the first login. */
    var activeKey by mutableStateOf<String?>(null)
        private set
    val activeWorkspace: Workspace? get() = workspaces.firstOrNull { it.serverUrl == activeKey }
    /** Names the per-workspace screen state (the open conversation, panes, search) while another is shown. */
    val workspaceKey: String? get() = activeWorkspace?.let { account(it.serverUrl, it.username) }
    /** The workspace name for titles and the search box. */
    val workspaceName: String get() = activeWorkspace?.name ?: "Taylis"
    /** 「ワークスペースを追加」: the login form for another server is up; cancelling returns to this one (§5.1). */
    var addingWorkspace by mutableStateOf(false)
        private set
    /** The workspace switcher (a bottom sheet). */
    var switcherOpen by mutableStateOf(false)

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val secrets = SecretStore(app)
    /** M48: the Google sign-in waiting for the browser, encrypted like the refresh tokens (it survives process death). */
    private val ssoPending = PendingSsoStore({ secrets.secret(SSO_PENDING_KEY) }, { secrets.putSecret(SSO_PENDING_KEY, it) })
    private val notifier = Notifier(app)
    /** §16: conversation notifications are posted one at a time (each may wait up to 3 s for a picture). */
    private val conversationPosts = Mutex()
    /** Plain settings on this device: the workspace list (M16c) and recent searches (M16b). */
    val prefs: KeyValueStore = SharedPrefsStore(app)
    /** M40: 「表示」 (端末に合わせる / ライト / ダーク), kept on this device for every workspace. */
    var appearance by mutableStateOf(jp.chikuwachat.android.ui.Appearance.read(prefs))
        private set

    fun changeAppearance(value: jp.chikuwachat.android.ui.Appearance) {
        jp.chikuwachat.android.ui.Appearance.write(prefs, value)
        appearance = value
    }
    /** M47: 「連続した投稿をまとめる」 (off by default), kept on this device; the open conversation redraws at once. */
    var groupPosts by mutableStateOf(jp.chikuwachat.android.ui.PostGrouping.read(prefs))
        private set

    fun changeGroupPosts(on: Boolean) {
        jp.chikuwachat.android.ui.PostGrouping.write(prefs, on)
        groupPosts = on
    }

    /** Issue #1: 「スワイプで戻る・進む」 (on by default), kept on this device. */
    var swipeNavigation by mutableStateOf(jp.chikuwachat.android.ui.SwipeNavigation.read(prefs))
        private set

    fun changeSwipeNavigation(on: Boolean) {
        jp.chikuwachat.android.ui.SwipeNavigation.write(prefs, on)
        swipeNavigation = on
    }

    /**
     * The UI language (docs/I18N.md): "ja" / "en" / "zh-Hans", or null to follow the device. Applied on this device at
     * once (AppLanguage), then saved as my `locale` on the server so my other devices and the server's texts (pushes,
     * emails) follow.
     */
    var language by mutableStateOf(AppLanguage.chosen)
        private set

    fun changeLanguage(value: String?) {
        AppLanguage.choose(app, value)
        languageApplied()
        languageRecreate?.invoke()
        val api = api ?: return
        scope.launch { pushLanguage(api) }
    }

    /**
     * The process saw a configuration change or an activity started: the language may have been changed outside the app
     * (the system's per-app language setting from Android 13, or the device's language).
     */
    fun languageMayHaveChanged() {
        val changed = AppLanguage.refresh(app)
        languageApplied()
        if (changed) api?.let { api -> scope.launch { pushLanguage(api) } }
    }

    private fun languageApplied() {
        language = AppLanguage.chosen
        notifier.refreshChannel()
    }

    private fun languageSyncKey(api: ApiClient): String? = (store.me ?: me)?.id?.let { "locale_synced|${api.baseUrl}|$it" }

    /** Saves this device's choice as my `locale` (a server that does not know the field is left alone). */
    private suspend fun pushLanguage(api: ApiClient) {
        val held = store.me ?: me ?: return
        if (!held.knowsLocale) return
        val key = languageSyncKey(api) ?: return
        val value = AppLanguage.chosen
        attempt { api.updateProfile(buildJsonObject { put("locale", value?.let { JsonPrimitive(it) } ?: JsonNull) }) }
            .onSuccess { updated ->
                if (this.api !== api) return@onSuccess
                prefs.putString(key, value ?: LANGUAGE_DEVICE)
                me = updated
                store.setMe(updated)
            }
    }

    /**
     * My `locale` arrived (bootstrap, user.updated): the last value this device and the server agreed on tells which
     * side changed. A change here (made while offline, or in the system's setting) goes to the server; a change on the
     * server (another device) is applied here.
     */
    private fun reconcileLanguage(api: ApiClient, held: UserMe) {
        if (!held.knowsLocale) return
        val key = languageSyncKey(api) ?: return
        val local = AppLanguage.chosen
        val server = held.locale?.let(AppLanguage::normalize)
        val synced = prefs.getString(key)?.let { LanguageSync.Synced(it.takeIf { v -> v != LANGUAGE_DEVICE }) }
        when (val step = LanguageSync.decide(local, server, synced)) {
            LanguageSync.Step.Push -> scope.launch { pushLanguage(api) }
            is LanguageSync.Step.Apply -> applyServerLanguage(key, step.language)
            LanguageSync.Step.Record -> prefs.putString(key, local ?: LANGUAGE_DEVICE)
            LanguageSync.Step.None -> Unit
        }
    }

    private fun applyServerLanguage(key: String, server: String?) {
        prefs.putString(key, server ?: LANGUAGE_DEVICE)
        if (server == AppLanguage.chosen) return
        AppLanguage.choose(app, server)
        languageApplied()
        languageRecreate?.invoke()
    }

    /** Before Android 13 a new language shows once the activity is recreated (MainActivity sets this). */
    var languageRecreate: (() -> Unit)? = null
    /** FCM token registration with every signed-in workspace (PUSH_NOTIFICATIONS.md §3); a no-op until Firebase is configured. */
    val push = PushCenter(scope, { fetchFcmToken(app) }, { pushTargets() }, { deleteFcmToken(app) })
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        // docs/I18N.md: every request says the UI language; the server words its errors and texts in it.
        .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("Accept-Language", L10n.language).build()) }
        .build()
    /** The API client of the workspace on screen (one of [clients]). */
    private var api: ApiClient? = null
    /** One API client per signed-in workspace: its refreshes are serialised (WORKSPACES.md §8, SECURITY.md §2). */
    private val clients = HashMap<String, ApiClient>()
    private var persistence: RoomPersistence? = null
    var appForeground by mutableStateOf(false)
        private set
    private var booted = false
    /** Workspace changes (startup, switch, sign-in, sign-out) run one at a time. */
    private val sessionLock = Mutex()
    private val loadLock = Mutex()
    private var workspacesLoaded = false
    /** Startup has chosen and opened a workspace; before that a tapped notification only records its choice. */
    private var restored = false
    /** Completed with [restored]: a sign-in that returns from the browser waits for startup (it may have started the app). */
    private val bootDone = CompletableDeferred<Unit>()
    /** The workspace a tapped notification asked for (WORKSPACES.md §7). */
    private var pendingWorkspaceKey: String? = null
    /** Workspaces being signed out on purpose: their end removes them from the list instead of marking them signed out. */
    private val leaving = HashSet<String>()
    /** The workspace on screen whose engine has registered this device's push token for its session. */
    private var attachedKey: String? = null
    /** The conversation on the main screen of the workspace on screen: its pushes are not shown in the foreground. */
    private var openChannelId: String? = null

    init {
        // M93: workspace icons are public (no sign-in): any workspace's tile can load its own.
        WorkspaceIconCache.fetcher = { server, version -> ApiClient(server, http).serverIcon(version) }
        WorkspaceIconCache.scope = scope
        // SYNC_PROTOCOL.md §5.3: a network that comes back skips the reconnect backoff.
        app.getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch { engine?.reconnectNow() }
            }
        })
    }

    private fun account(server: String, username: String) = "$server|$username"

    private fun makeApi(server: String, username: String): ApiClient = wire(ApiClient(server, http), server, username)

    /** Saves the client's rotated refresh tokens under its account and ends the workspace when it signs out. */
    private fun wire(api: ApiClient, server: String, username: String): ApiClient {
        val account = account(server, username)
        api.onTokens = { tokens -> scope.launch { secrets.putSecret(account, tokens.refreshToken) } }
        api.onSignedOut = { scope.launch { clientSignedOut(server, api) } }
        return api
    }

    /** The client of the workspace on screen: its avatars load through it (M14a). */
    private fun activate(client: ApiClient) {
        api = client
        AvatarCache.fetcher = { path -> client.fetchBytes(path) }
        AvatarCache.scope = scope
    }

    /** The one API client of a signed-in workspace, made from its stored refresh token (null: sign-in needed). */
    private suspend fun clientFor(entry: Workspace): ApiClient? {
        clients[entry.serverUrl]?.let { return it }
        if (entry.signedOut) return null
        val token = secrets.secret(account(entry.serverUrl, entry.username)) ?: return null
        clients[entry.serverUrl]?.let { return it } // made while the secret was read
        val client = makeApi(entry.serverUrl, entry.username)
        client.refreshToken = token
        clients[entry.serverUrl] = client
        return client
    }

    private fun saveWorkspaces() = Workspaces.save(prefs, workspaces, activeKey)

    private fun replaceWorkspaces(list: List<Workspace>) {
        workspaces = list
        saveWorkspaces()
    }

    private fun updateWorkspace(serverUrl: String, change: (Workspace) -> Workspace) {
        val next = workspaces.map { if (it.serverUrl == serverUrl) change(it) else it }
        if (next != workspaces) replaceWorkspaces(next)
    }

    /**
     * The saved list; the first time, migrated from the one server an older install remembers (WORKSPACES.md §4).
     * Also what a push needs before the app has started.
     */
    private suspend fun ensureWorkspacesLoaded() = loadLock.withLock {
        if (workspacesLoaded) return@withLock
        val legacyServer = secrets.setting(SERVER_KEY)
        val legacyUsername = secrets.setting(USERNAME_KEY)
        val saved = Workspaces.load(prefs) ?: run {
            val server = legacyServer ?: DEFAULT_SERVER
            val hasSession = !legacyUsername.isNullOrEmpty() && secrets.secret(account(server, legacyUsername)) != null
            Workspaces.migrate(server, legacyUsername, hasSession).also { Workspaces.save(prefs, it.entries, it.active) }
        }
        workspaces = saved.entries
        activeKey = saved.active
        savedServer = legacyServer ?: DEFAULT_SERVER
        savedUsername = legacyUsername ?: ""
        workspacesLoaded = true
    }

    /** Startup: the saved workspaces, then the active one's session (SYNC_PROTOCOL.md §7.2, WORKSPACES.md §5.2). */
    suspend fun boot() {
        if (booted) return
        booted = true
        // In the controller's scope: an activity recreated half-way (rotation) must not cancel the restore.
        scope.launch {
            sessionLock.withLock {
                ensureWorkspacesLoaded()
                // A tapped notification's workspace first; else the last one, while it is signed in.
                val pending = pendingWorkspaceKey?.let { key -> workspaces.firstOrNull { it.serverUrl == key && !it.signedOut } }
                pendingWorkspaceKey = null
                val chosen = pending
                    ?: activeWorkspace?.takeIf { !it.signedOut }
                    ?: workspaces.firstOrNull { !it.signedOut }
                    ?: activeWorkspace
                    ?: workspaces.firstOrNull()
                if (chosen == null) showLogin(null) else openWorkspace(chosen)
                restored = true
                bootDone.complete(Unit)
            }
        }.join()
        ssoPending.purgeExpired()
        push.refresh() // WORKSPACES.md §8: at startup the token goes to every signed-in workspace
    }

    /**
     * Puts a workspace on screen (§5.2): its local store at once, then its session from the stored refresh token
     * (SYNC_PROTOCOL.md §7.2). A refused refresh ends that workspace's session only (the login form for it).
     */
    private suspend fun openWorkspace(entry: Workspace) {
        // Nothing of a workspace is drawn until its own store is loaded (its saved screen state would meet an empty one).
        screen = Screen.BOOT
        if (api != null || engine != null) closeActive()
        addingWorkspace = false
        switcherOpen = false
        totpRequired = false
        activeKey = entry.serverUrl
        savedServer = entry.serverUrl
        savedUsername = entry.username
        // On screen, its unread marks come from its own store.
        updateWorkspace(entry.serverUrl) { it.copy(badge = 0, hasUnread = false) }
        saveWorkspaces()
        val client = if (entry.signedOut) null else clientFor(entry)
        if (client == null) {
            if (!entry.signedOut) updateWorkspace(entry.serverUrl) { it.copy(signedOut = true) }
            screen = Screen.LOGIN
            return
        }
        activate(client)
        scope.launch { refreshServerInfo(entry.serverUrl) }
        if (startEngine(client, restoring = true)) return
        busy = true
        try {
            val tokens = client.refresh()
            if (api === client) enterSession(client, entry.username, tokens.user)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A refused refresh has signed the client out (clientSignedOut shows the login for this workspace).
            if (api === client && !(e is ApiException.Api && e.isAuth)) {
                screen = Screen.LOGIN
                error = describe(e)
            }
        } finally {
            busy = false
        }
    }

    /** Takes the workspace on screen down; its session stays signed in unless the caller ends it. */
    private suspend fun closeActive() {
        screen = Screen.BOOT
        engine?.stop()
        engine = null
        api = null
        me = null
        engineStatus = EngineStatus.IDLE
        aiStatus = null
        aiSummary = null
        aiSummaryChooser = null
        aiSummaryTargets = emptyMap()
        aiAsk = null
        aiAskTarget = null
        aiAskShown = false
        messageFocus = null
        pendingReveal = null
        pendingCanvas = null
        pendingPage = null
        pendingEvent = null
        calendarForm = null
        calendarFeeds = null
        pendingTask = null
        taskForm = null
        workflowForm = null
        workflowLists.clear()
        linkPreviews.clear()
        previewLoads.clear()
        previewsAsked.clear()
        emojiLoads.clear()
        canvasLinks.clear()
        canvasLinksAsked.clear()
        canvasAttachments.clear()
        attachedKey = null
        openChannelId = null
        AvatarCache.reset()
        val old = persistence
        persistence = null
        store = Store()
        timesFeedState = jp.chikuwachat.android.ui.TimesFeedState()
        if (old != null) withContext(Dispatchers.IO) { old.close() }
    }

    /** The login form: for a registered workspace (prefilled), or for a first server when none is left. */
    private fun showLogin(serverUrl: String?) {
        val entry = serverUrl?.let { key -> workspaces.firstOrNull { it.serverUrl == key } }
        activeKey = entry?.serverUrl
        saveWorkspaces()
        if (entry != null) {
            savedServer = entry.serverUrl
            savedUsername = entry.username
        }
        addingWorkspace = false
        switcherOpen = false
        screen = Screen.LOGIN
    }

    /** Another workspace on screen (WORKSPACES.md §5.2); the one it replaces stays signed in. */
    fun switchWorkspace(serverUrl: String) {
        scope.launch { sessionLock.withLock { switchLocked(serverUrl) } }
    }

    private suspend fun switchLocked(serverUrl: String) {
        val entry = workspaces.firstOrNull { it.serverUrl == serverUrl } ?: return
        addingWorkspace = false
        switcherOpen = false
        if (serverUrl == activeKey && api != null && screen != Screen.LOGIN) return
        error = null
        pendingChannelId = null
        pendingReply = null
        openWorkspace(entry)
    }

    /** M114 (WORKSPACES.md §5.4): the switcher's order, kept on this device only (each workspace is its own server). */
    fun moveWorkspace(serverUrl: String, by: Int) {
        val next = Workspaces.moved(workspaces, serverUrl, by)
        if (next != workspaces) replaceWorkspaces(next)
    }

    /** 「ワークスペースを追加」: the login form for another server; cancelling returns to this one (§5.1). */
    fun beginAddWorkspace() {
        switcherOpen = false
        totpRequired = false
        error = null
        addingWorkspace = true
    }

    fun cancelAddWorkspace() {
        addingWorkspace = false
        totpRequired = false
        error = null
    }

    fun openSwitcher() {
        switcherOpen = true
    }

    /** The name and workspace id from GET /server, read again whenever a workspace opens (§4). */
    private suspend fun refreshServerInfo(serverUrl: String) {
        val info = try {
            ApiClient(serverUrl, http).serverInfo()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return // offline, or an older server: the saved name stays
        }
        if (info.product != Workspaces.PRODUCT) return
        updateWorkspace(serverUrl) {
            it.copy(name = info.name.ifBlank { it.name }, workspaceId = info.workspaceId, iconVersion = if (info.knowsIcon) info.iconVersion else it.iconVersion)
        }
    }

    /** The marks of the workspaces that are not open (§6): when the app comes back and when the switcher opens. */
    fun refreshSummaries() {
        for (entry in workspaces.filter { !it.signedOut && it.serverUrl != activeKey }) {
            scope.launch {
                val client = clientFor(entry) ?: return@launch
                try {
                    val summary = client.syncSummary()
                    if (entry.serverUrl != activeKey) updateWorkspace(entry.serverUrl) { it.copy(badge = summary.badge, hasUnread = summary.hasUnread) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // offline: the last known marks stay (a refused session ends through clientSignedOut)
                }
            }
        }
    }

    /**
     * Where this device's push token goes (WORKSPACES.md §8): every signed-in workspace. The one on screen registers
     * once its engine has a session; the others (and a start by a push) through their own client, which renews
     * its access token with the stored refresh token first.
     */
    private suspend fun pushTargets(): List<Pair<String, ApiClient>> {
        ensureWorkspacesLoaded()
        return workspaces.filter { !it.signedOut }.mapNotNull { entry ->
            val onScreen = entry.serverUrl == activeKey && api != null
            if (onScreen) {
                api?.takeIf { attachedKey == entry.serverUrl }?.let { entry.serverUrl to it }
            } else {
                clientFor(entry)?.let { entry.serverUrl to it }
            }
        }
    }

    /**
     * Login form (SYNC_PROTOCOL.md §7.2 first login, WORKSPACES.md §5.1): the URL is normalized and GET /server
     * checked; when adding, a server that is not ChikuwaChat is refused and an already registered workspace
     * (same workspace_id) is switched to instead of signing in twice (one account per server).
     */
    suspend fun login(server: String, username: String, password: String, totpCode: String? = null) =
        // In the controller's scope: the form goes away half-way (the workspace it opens replaces it).
        scope.launch { loginNow(server, username, password, totpCode) }.join()

    private suspend fun loginNow(server: String, username: String, password: String, totpCode: String?) {
        val normalized = Workspaces.normalizeServerUrl(server)
        if (normalized == null) {
            error = L10n.str(R.string.app_controller_the_server_url_is_not_valid)
            return
        }
        busy = true
        try {
            val (key, info) = signInTarget(normalized) ?: return
            val api = makeApi(key, username)
            val tokens = api.login(username, password, "android", Build.MODEL, BuildConfig.VERSION_NAME, totpCode?.let(Totp::normalize))
            secrets.putSetting(SERVER_KEY, key)
            secrets.putSetting(USERNAME_KEY, username)
            error = null
            totpRequired = false
            sessionLock.withLock { adoptSession(api, username, tokens.user, info) }
        } catch (e: ApiException.Api) {
            when (e.code) {
                "totp_required" -> { totpRequired = true; error = null }
                "invalid_totp" -> { totpRequired = true; error = Totp.errorText(e.code) }
                else -> { totpRequired = false; error = describe(e) }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            report(e)
        } finally {
            busy = false
        }
    }

    /**
     * The server a sign-in form goes to (password or Google): GET /server checked; when adding, a server that is not
     * ChikuwaChat is refused. Null when the form stops: a failure in [error], or an already registered and signed-in
     * workspace (same workspace_id) opened instead of signing in twice (one account per server).
     */
    private suspend fun signInTarget(normalized: String): Pair<String, ServerInfoOut?>? {
        // A registered address keeps its spelling: it names the saved token and the local store.
        var key = workspaces.firstOrNull { Workspaces.sameServer(it.serverUrl, normalized) }?.serverUrl ?: normalized
        val info = try {
            ApiClient(key, http).serverInfo().takeIf { it.product == Workspaces.PRODUCT }
        } catch (e: ApiException.Network) {
            error = describe(e)
            return null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (addingWorkspace && e is ApiException.Api && e.status >= 500) {
                error = describe(e)
                return null
            }
            null
        }
        if (addingWorkspace && info == null) {
            error = NOT_CHIKUWA
            return null
        }
        val known = info?.let { Workspaces.findRegistered(workspaces, it.workspaceId, key) }
        if (known != null && !known.signedOut && (addingWorkspace || known.serverUrl != activeKey)) {
            // Registered and signed in already: that workspace opens instead.
            error = null
            totpRequired = false
            sessionLock.withLock { switchLocked(known.serverUrl) }
            notice = L10n.str(R.string.app_controller_is_already_added, known.name)
            return null
        }
        if (known != null) key = known.serverUrl // registered but signed out: sign in to it again
        return key to info
    }

    // --- Google sign-in (M48, docs/SSO.md §6) -----------------------------------------------------

    /** The login form's Google button for this address (null: none, also for a server before M48 or offline). */
    suspend fun googleSignInButton(server: String): GoogleButtonText? {
        val normalized = Workspaces.normalizeServerUrl(server) ?: return null
        val key = workspaces.firstOrNull { Workspaces.sameServer(it.serverUrl, normalized) }?.serverUrl ?: normalized
        return Sso.googleButton(ApiClient(key, http))
    }

    /**
     * 「Google でログイン」: checks the server as the password form does, keeps a new verifier with the server it is for
     * (a previous pending sign-in is replaced), and returns the start URL for the browser; null when the form stops.
     */
    suspend fun beginGoogleSignIn(server: String): String? = scope.async { beginGoogleSignInNow(server) }.await()

    private suspend fun beginGoogleSignInNow(server: String): String? {
        val normalized = Workspaces.normalizeServerUrl(server)
        if (normalized == null) {
            error = L10n.str(R.string.app_controller_the_server_url_is_not_valid)
            return null
        }
        busy = true
        try {
            val (key, _) = signInTarget(normalized) ?: return null
            val verifier = Sso.newVerifier()
            ssoPending.save(key, verifier)
            // Deleted after ten minutes even when the browser never comes back (and at the next start otherwise).
            scope.launch { delay(Sso.PENDING_TTL_MS); ssoPending.purgeExpired() }
            error = null
            totpRequired = false
            return Sso.startUrl(key, Sso.challenge(verifier))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            report(e)
            return null
        } finally {
            busy = false
        }
    }

    /** The browser could not be opened: the sign-in it would have finished is dropped. */
    fun googleSignInNotOpened() {
        scope.launch { ssoPending.take() }
        error = L10n.str(R.string.app_controller_couldnt_open_the_browser)
    }

    /**
     * `chikuwachat://sso?ticket=…` (or `?sso_error=`) from the browser (MainActivity). Ignored unless a sign-in is pending:
     * a replayed or foreign link finds none. The pending verifier is used once, whatever the outcome; the ticket is
     * exchanged with the server the sign-in started on (not the workspace on screen).
     */
    fun handleSsoCallback(url: String?) {
        val callback = Sso.parseCallback(url) ?: return
        scope.launch {
            bootDone.await()
            val pending = ssoPending.take() ?: return@launch
            when (callback) {
                is Sso.Callback.Failure -> error = Sso.errorText(callback.code)
                is Sso.Callback.Ticket -> exchangeSsoTicket(pending, callback.ticket)
            }
        }
    }

    private suspend fun exchangeSsoTicket(pending: PendingSso, ticket: String) {
        val key = pending.serverUrl
        busy = true
        try {
            // The account (and so where its refresh token is kept) is known from the answer only.
            val client = ApiClient(key, http)
            val tokens = client.ssoExchange(ticket, pending.verifier, Sso.PLATFORM, Build.MODEL, BuildConfig.VERSION_NAME)
            val username = tokens.user.username
            wire(client, key, username)
            secrets.putSecret(account(key, username), tokens.refreshToken)
            val info = try {
                client.serverInfo().takeIf { it.product == Workspaces.PRODUCT }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null // the name follows when the workspace opens
            }
            secrets.putSetting(SERVER_KEY, key)
            secrets.putSetting(USERNAME_KEY, username)
            error = null
            totpRequired = false
            sessionLock.withLock { adoptSession(client, username, tokens.user, info) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            report(e)
        } finally {
            busy = false
        }
    }

    /**
     * A new sign-in (login form or invite): the workspace joins the list, or its entry is renewed, and opens. A
     * session this replaces on the same server ends on this device (one account per server).
     */
    private suspend fun adoptSession(client: ApiClient, username: String, me: UserMe, info: ServerInfoOut?) {
        screen = Screen.BOOT
        val serverUrl = client.baseUrl
        val known = workspaces.firstOrNull { it.serverUrl == serverUrl }
        if (api != null || engine != null) closeActive()
        val previous = clients.remove(serverUrl)
        if (previous != null && previous !== client) {
            // Revoked on the server; a token it rotates on the way must not overwrite the new one, and its end
            // finds itself replaced (clientSignedOut).
            previous.onTokens = null
            scope.launch { attempt { previous.logout() } }
        }
        // One account per server: the account this replaces leaves nothing on this device.
        if (known != null && known.username != username) forgetAccountData(account(serverUrl, known.username))
        clients[serverUrl] = client
        push.detach(serverUrl)
        val entry = Workspace(
            serverUrl = serverUrl,
            workspaceId = info?.workspaceId ?: known?.workspaceId,
            name = info?.name?.ifBlank { null } ?: known?.name ?: Workspaces.hostLabel(serverUrl),
            username = username,
            userId = me.id,
            iconVersion = if (info?.knowsIcon == true) info.iconVersion else known?.iconVersion,
        )
        workspaces = if (known != null) workspaces.map { if (it.serverUrl == serverUrl) entry else it } else workspaces + entry
        activeKey = serverUrl
        saveWorkspaces()
        addingWorkspace = false
        switcherOpen = false
        savedServer = serverUrl
        if (info == null) scope.launch { refreshServerInfo(serverUrl) }
        enterSession(client, username, me)
    }

    // --- two-factor authentication (M12i): the settings dialog drives these -----------------

    suspend fun totpStatus(): TotpStatusOut? = attempt { api!!.totpStatus() }.getOrElse { error = describe(it); null }

    /** The failure text is `Totp.errorText` when 2FA specific, else the general description. */
    suspend fun beginTotpSetup(password: String): Result<TotpSetupOut> = attempt { api!!.totpSetup(password) }

    suspend fun enableTotp(code: String): Result<TotpEnabledOut> = attempt { api!!.totpEnable(Totp.normalize(code)) }

    suspend fun disableTotp(password: String): String? =
        attempt { api!!.totpDisable(password); null }.getOrElse { totpFailure(it) }

    fun totpFailure(e: Throwable): String = (e as? ApiException.Api)?.let { Totp.errorText(it.code) } ?: describe(e)

    /** M12h: what an invite link offers, before any account exists (throws on a dead link). */
    suspend fun previewInvite(server: String, token: String): InvitePreviewOut = ApiClient(server, http).invitePreview(token)

    /** M12h: create the account the link allows and enter the session; returns the failure text, if any. */
    suspend fun acceptInvite(server: String, token: String, username: String, displayName: String, password: String): String? =
        scope.async { acceptInviteNow(server, token, username, displayName, password) }.await()

    private suspend fun acceptInviteNow(server: String, token: String, username: String, displayName: String, password: String): String? {
        val normalized = Workspaces.normalizeServerUrl(server) ?: return L10n.str(R.string.app_controller_the_server_url_is_not_valid)
        val key = workspaces.firstOrNull { Workspaces.sameServer(it.serverUrl, normalized) }?.serverUrl ?: normalized
        val api = makeApi(key, username)
        busy = true
        return try {
            val tokens = api.acceptInvite(token, username, displayName, password, "android", Build.MODEL, BuildConfig.VERSION_NAME)
            val info = try {
                api.serverInfo().takeIf { it.product == Workspaces.PRODUCT }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null // the name follows when the workspace opens
            }
            secrets.putSetting(SERVER_KEY, key)
            secrets.putSetting(USERNAME_KEY, username)
            error = null
            sessionLock.withLock { adoptSession(api, username, tokens.user, info) }
            null
        } catch (e: CancellationException) {
            throw e
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
            report(e)
        } finally {
            busy = false
        }
    }

    private suspend fun enterSession(api: ApiClient, username: String, me: UserMe) {
        activate(api)
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
        persistence?.let { old -> withContext(Dispatchers.IO) { old.close() } }
        val account = account(api.baseUrl, savedUsername)
        val persistence = withContext(Dispatchers.IO) { runCatching { RoomPersistence.open(app, account) }.getOrNull() }
        val store = Store(persistence)
        withContext(Dispatchers.IO) { store.load() }
        this.persistence = persistence
        this.store = store
        timesFeedState = jp.chikuwachat.android.ui.TimesFeedState() // another account's rows never show
        if (restoring) {
            val cached = store.me ?: return false
            if (cached.mustChangePassword) return false
            me = cached
        } else me?.let { store.setMe(it) }
        // Notifications of this engine belong to its workspace, even when one arrives after a switch.
        val workspaceUrl = api.baseUrl
        fun workspace() = workspaces.firstOrNull { it.serverUrl == workspaceUrl }
        me?.let { known -> updateWorkspace(workspaceUrl) { if (it.userId == null) it.copy(userId = known.id) else it } }
        // M93 (WORKSPACES.md §3.4.1): an admin changed the workspace icon (bootstrap, workspace.settings_updated).
        // docs/I18N.md: my `locale` (bootstrap, user.updated) and this device's language are kept in step.
        scope.launch {
            store.version.map { store.me?.let { it.id to it.locale } }.distinctUntilChanged().collect {
                if (this@AppController.store === store) store.me?.let { reconcileLanguage(api, it) }
            }
        }
        store.onWorkspaceIcon = { version -> scope.launch { if (this@AppController.store === store) updateWorkspace(workspaceUrl) { it.copy(iconVersion = version) } } }
        val engine = SyncEngine(
            api = api,
            connect = { url, _ -> OkHttpWsTransport.connect(http, url) },
            wsUrl = api.wsUrl,
            store = store,
            getAccessToken = { api.accessToken },
            scope = scope,
        )
        // The session ended (4003, refused token): the client signs out, which ends this workspace (clientSignedOut).
        engine.onSignedOut = { scope.launch { if (this@AppController.engine === engine) api.signOut() } }
        engine.isActive = { appForeground }
        engine.onRead = { channelId -> notifier.clear(channelId) }
        // M12e: a reminder that fires while the app is open (the push is suppressed then) still shows up,
        // as its own notification (the channel's next message must not replace it, nor a read clear it).
        engine.onReminder = { row ->
            val text = (row.note?.takeIf { it.isNotBlank() }?.let { "$it — " } ?: "") + row.preview
            notice = "⏰ $text"
            // Worded like the server's push (確認のお願い, L6 提出のお願い).
            val title = Recurring.reminderBadge(row.kind) ?: L10n.str(R.string.common_reminders)
            if (!dndActive(store)) notify(workspace(), row.channelId, title, text, key = "reminder:${row.id}", messageId = row.messageId)
        }
        // M52: my calendar alarm fired while the app is open (the server's push is not shown then), worded like that push.
        // Review v0.1.22 #9: said for the occurrence it is for; when this device cannot tell which, neutrally (never another's).
        engine.calendar.onAlarm = { fired ->
            val text = CalendarDates.alarmText(fired.event, fired.channelId?.let { store.channels[it]?.channel?.name })
            notice = "📅 $text"
            if (!dndActive(store)) notify(workspace(), fired.channelId, L10n.str(R.string.common_event), text, key = "calendar:${fired.eventId}", eventId = fired.eventId)
        }
        // M56: task.assigned / task.due while the app is open (the server's push is not shown then), worded like that push;
        // not with 「タスク (割り当て・期限)」 off (the server sends the event either way, TASKS.md §8).
        engine.tasks.onNotice = { said ->
            val text = when (said) {
                is jp.chikuwachat.android.sync.TaskNotice.Assigned -> TaskRules.assignedText(said.data) { id -> store.users[id]?.displayName }
                is jp.chikuwachat.android.sync.TaskNotice.Due -> TaskRules.dueText(said.data)
                is jp.chikuwachat.android.sync.TaskNotice.ReviewDone -> TaskRules.reviewDoneText(said.data) { id -> store.users[id]?.displayName }
            }
            if (store.me?.notifyTasks != false) {
                notice = "☑ ${text.body}"
                if (!dndActive(store)) notify(workspace(), text.channelId, L10n.str(R.string.common_tasks), text.body, key = "task:${text.taskId}", taskId = text.taskId)
            }
        }
        // M73 (CANVAS.md §18.1): a canvas newly mentions me while the app is open (the server's push is not shown then),
        // worded like that push; the engine has checked the conversation's level and mute.
        engine.onCanvasMention = { mention, channel ->
            val text = jp.chikuwachat.android.ui.CanvasTasks.mentionText(mention, channel) { id -> store.users[id]?.displayName }
            notice = "📝 $text"
            if (!dndActive(store)) notify(workspace(), channel.id, L10n.str(R.string.common_canvas), text, key = "canvas:${mention.canvasId}", canvasId = mention.canvasId)
        }
        // M122 (docs/WIKI.md §9.3): mentioned in a page, or a page shared with me by name, while the app is open: the
        // banner and a local notification worded like the push (which is not shown then); its tap opens the page.
        engine.onWikiNotice = { wiki, shared ->
            val who = wiki.byUserId?.let { store.users[it]?.displayName } ?: L10n.str(R.string.docs_someone)
            val title = wiki.title.ifBlank { L10n.str(R.string.docs_untitled) }
            val text = if (shared) L10n.str(R.string.docs_shared_with_you, who, title) else L10n.str(R.string.docs_mentioned_you, who, title)
            notice = "📄 $text"
            if (!dndActive(store)) notify(workspace(), null, L10n.str(R.string.docs_title), text, key = "page:${wiki.pageId}", pageId = wiki.pageId)
        }
        // M112: a reservation notice while the app is open: the banner and a local notification (the push is not shown then).
        engine.onReservationNotice = { notice ->
            notice.text.let { text ->
                this.notice = "🎫 $text"
                if (!dndActive(store)) notify(workspace(), null, L10n.str(R.string.common_reservations), text, key = "reservation:${notice.itemId}", reservations = true)
            }
        }
        engine.onNotify = { message, channel ->
            // M12c: Do Not Disturb / quiet hours hold local alerts back as well (the server does so for pushes).
            if (!dndActive(store)) {
                val sender = store.users[message.senderId]?.displayName ?: "?"
                val title = if (channel.channel.isDm) sender else channelTitle(channel, store) + " · " + sender
                // §16: shown as a conversation with the sender's picture, like the push.
                val group = ConversationNote.isGroup(channel.channel.type)
                val note = ConversationNote(
                    senderId = message.senderId, senderName = sender, senderAvatar = store.users[message.senderId]?.avatarUpdatedAt,
                    isGroup = group, conversationTitle = if (group) channelTitle(channel, store) else null,
                )
                // M117 (docs/CALLS.md §6): a call says who started it, as the push does.
                val text = jp.chikuwachat.android.ui.Calls.notificationLine(message.call, message.deleted, store.users)
                    ?: messageLine(message.body, message.attachments, store).ifEmpty { L10n.str(R.string.common_new_message) }
                notify(
                    workspace(), channel.id, title, text,
                    messageId = message.id, parentId = message.parentId, conversation = note,
                )
            }
        }
        this.engine = engine
        // M66: the AI status and the summary sheet follow this engine's AI hub (another workspace's never show).
        aiStatus = null
        aiSummary = null
        aiSummaryChooser = null
        aiSummaryTargets = emptyMap()
        aiAsk = null
        aiAskTarget = null
        aiAskShown = false
        scope.launch {
            engine.ai.version.collect {
                if (this@AppController.engine !== engine) return@collect
                aiStatus = engine.ai.status
                aiSummary = engine.ai.summary
                aiSummaryTargets = engine.ai.targets
                aiAsk = engine.ai.ask // M71
                aiAskTarget = engine.ai.askTarget
                if (aiAsk == null) aiAskShown = false
            }
        }
        scope.launch {
            engine.status.collect { status ->
                if (this@AppController.engine !== engine) return@collect
                engineStatus = status
                // The access token is no longer refreshed on every connect: take role and flags from bootstrap.
                if (status == EngineStatus.ONLINE) store.me?.let { me = it; followUsername(api.baseUrl, it.username) }
            }
        }
        var attached = false
        engine.prepareConnection = prepare@{ refresh ->
            // §7.2: renew only a missing or expiring token (or one the socket refused, 4001). Each refresh
            // rotates the refresh token, and every needless rotation is a chance to lose it (reuse detection).
            if (refresh || !api.hasFreshAccessToken()) {
                val tokens = api.refresh()
                if (this.api !== api || this.engine !== engine) return@prepare
                me = tokens.user
                store.setMe(tokens.user)
                followUsername(api.baseUrl, tokens.user.username)
                if (tokens.user.mustChangePassword) {
                    engine.stop()
                    screen = Screen.CHANGE_PASSWORD
                    throw IllegalStateException("Password change required")
                }
            }
            if (!attached) {
                attached = true
                attachedKey = api.baseUrl
                push.attach(api.baseUrl) // this session's device row gets the push token
            }
        }
        screen = Screen.MAIN
        scope.launch { engine.start() }
        return true
    }

    /**
     * A local notification, for the workspace it belongs to (named when there are two or more, WORKSPACES.md §7). M28c:
     * with the message (and its thread for a reply), and my unread count across the workspaces as the icon's number.
     */
    private fun notify(
        entry: Workspace?, channelId: String?, title: String, body: String, key: String = channelId ?: "", messageId: String? = null, parentId: String? = null,
        reveal: Boolean = false, eventId: String? = null, taskId: String? = null, canvasId: String? = null, reservations: Boolean = false,
        conversation: ConversationNote? = null, pageId: String? = null,
    ) {
        val named = workspaces.size >= 2
        if (conversation != null && channelId != null) {
            // §16: the sender's picture loads through the workspace's own signed-in client (at most 3 s, else initials).
            // One at a time, so a quick second message never lands before the first.
            val server = entry?.serverUrl
            val client = if (server != null && server == activeKey) api else server?.let { clients[it] }
            val fetch: (suspend (String) -> ByteArray)? = client?.let { c -> { path: String -> c.fetchBytes(path) } }
            scope.launch {
                conversationPosts.withLock {
                    val avatar = notifier.avatars.bitmap(server, conversation, fetch)
                    notifier.notifyConversation(
                        channelId, title, body, conversation, avatar, key = key, workspace = server,
                        subText = if (named) entry?.name else null, messageId = messageId, parentId = parentId, badge = totalBadge(),
                    )
                }
            }
            return
        }
        notifier.notifyMessage(
            channelId, title, body, key = key, workspace = entry?.serverUrl, subText = if (named) entry?.name else null,
            messageId = messageId, parentId = parentId, reveal = reveal, badge = totalBadge(), eventId = eventId, taskId = taskId,
            canvasId = canvasId, reservations = reservations, pageId = pageId,
        )
    }

    /**
     * My unread count across the workspaces (WORKSPACES.md §6): the one on screen from its own store, by the shared rule
     * of SYNC_PROTOCOL.md §10.5 (mentions in channels, every message in DMs), the others from their last summary or push.
     */
    private fun totalBadge(): Int {
        val active = if (api != null) store.channels.values.sumOf { Channels.badgeCount(it) } else 0
        return active + workspaces.filter { !it.signedOut && it.serverUrl != activeKey }.sumOf { it.badge }
    }

    /** M28c: whether the system lets the app post notifications (asked once by the main screen; refusals show in the settings). */
    val notificationsPermitted: Boolean get() = notifier.permitted

    /** The system's notification page for this app, from the settings' hint after a refusal (M28c). */
    fun openNotificationSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, app.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { app.startActivity(intent) }.onFailure { error = ErrorTexts.unknown }
    }

    /**
     * A data-only push (PUSH_NOTIFICATIONS.md §9, WORKSPACES.md §7), routed to its workspace. For the workspace on
     * screen it is shown unless the app is in the foreground with a live socket (the event arrives over the socket,
     * which alerts for every conversation but the open one); the engine catches up either way. Another workspace's
     * push is always shown (its server sees no connection) and marks that workspace unread.
     * M39: a reaction's push (`kind = reaction`, sent only to those who turned 「リアクションのバナー」 on) shows the same
     * way, as its own notification; its tap opens the message reacted to. It marks nothing unread.
     */
    fun handlePush(message: PushMessage) {
        scope.launch {
            ensureWorkspacesLoaded()
            // §11: signed out on this device (the server may not know it yet): nothing is shown.
            val target = routePush(message) ?: return@launch
            // An entry that predates GET /server learns its id from the payload (routing, duplicate checks).
            if (target.workspaceId == null && message.workspaceId != null) updateWorkspace(target.serverUrl) { it.copy(workspaceId = message.workspaceId) }
            val key = message.notificationKey
            // §15: each test alerts again (an update of the one still on screen would be silent: setOnlyAlertOnce).
            if (message.isTest && key != null) notifier.clear(key)
            if (target.serverUrl == activeKey && api != null) {
                // The conversation being read is never announced; while the socket is live everything else arrives
                // over it (and alerts from there).
                val live = appForeground && engineStatus == EngineStatus.ONLINE
                val reading = appForeground && message.kind == "message" && message.channelId != null && message.channelId == openChannelId
                // M52: a calendar alarm's push is shown the same way (while live, the socket's calendar.alarm.updated says it).
                // §15: a test push is what the reader just asked for: shown even with the app open and the socket live.
                if (message.shown && (message.isTest || (!live && !reading)) && key != null) {
                    notify(target, message.channelId, message.displayTitle, message.body, key, messageId = message.messageId, parentId = message.parentId, reveal = message.isReaction, eventId = message.eventId, taskId = message.taskId, canvasId = message.canvasId, reservations = message.isReservation, conversation = message.conversation, pageId = message.pageId)
                }
                // M28c: the push's own conversation catches up too (the socket may be stale), not only the open one.
                engine?.pushReceived(message.channelId, message.messageId)
                return@launch
            }
            // The mark first: the notification's number counts this workspace's badge with the others'.
            if (message.kind == "message") updateWorkspace(target.serverUrl) { it.copy(hasUnread = true, badge = message.badge ?: it.badge) }
            if (message.shown && key != null) {
                notify(target, message.channelId, message.displayTitle, message.body, key, messageId = message.messageId, parentId = message.parentId, reveal = message.isReaction, eventId = message.eventId, taskId = message.taskId, canvasId = message.canvasId, reservations = message.isReservation, conversation = message.conversation, pageId = message.pageId)
            }
        }
    }

    private suspend fun routePush(message: PushMessage): Workspace? =
        Workspaces.route(workspaces, activeKey, message.workspaceId, message.channelId) { entry, channelId ->
            if (entry.serverUrl == activeKey && persistence != null) {
                store.channel(channelId) != null
            } else {
                withContext(Dispatchers.IO) { RoomPersistence.hasChannel(app, account(entry.serverUrl, entry.username), channelId) }
            }
        }

    /**
     * A tapped notification (WORKSPACES.md §7): its workspace comes on screen (switching if needed), then the
     * conversation opens as before (the main screen opens [pendingChannelId] once the store knows it).
     */
    fun openFromNotification(workspaceKey: String?, channelId: String, messageId: String? = null, parentId: String? = null, reveal: Boolean = false) {
        pendingWorkspaceKey = workspaceKey
        pendingChannelId = channelId
        // M28c: a reply's notification opens its thread at the reply (the main screen reveals it once the store knows the channel).
        pendingReply = if (messageId != null && parentId != null) messageId to parentId else null
        // M39: a reaction's notification opens the message reacted to (in its thread when it is a reply).
        pendingRevealId = if (reveal && pendingReply == null) messageId else null
        bringWorkspace { pendingChannelId = channelId }
    }

    /**
     * M52: a tapped calendar alarm (CALENDAR.md §6): its workspace comes on screen, then the main screen opens the event, in
     * its channel's 「予定」 tab (or the calendar for my own calendar's event).
     */
    fun openEventFromNotification(workspaceKey: String?, channelId: String?, eventId: String) {
        pendingWorkspaceKey = workspaceKey
        val target = PendingEvent(channelId, eventId)
        pendingEvent = target
        bringWorkspace { pendingEvent = target }
    }

    /**
     * M56: a tapped task notification (TASKS.md §5): its workspace comes on screen, then the main screen opens the task, in
     * its channel's 「タスク」 tab (or 「自分のタスク」 for a personal one).
     */
    fun openTaskFromNotification(workspaceKey: String?, channelId: String?, taskId: String) {
        pendingWorkspaceKey = workspaceKey
        val target = PendingTask(channelId, taskId)
        pendingTask = target
        bringWorkspace { pendingTask = target }
    }

    /**
     * M73 (CANVAS.md §18.5): a tapped canvas mention: its workspace comes on screen, then the main screen opens the canvas in
     * its conversation's 「キャンバス」 tab (once the store knows the conversation).
     */
    fun openCanvasFromNotification(workspaceKey: String?, channelId: String, canvasId: String) {
        pendingWorkspaceKey = workspaceKey
        val target = channelId to canvasId
        pendingCanvas = target
        bringWorkspace { pendingCanvas = target }
    }

    /** M122 (docs/WIKI.md §9.3): a tapped page notification: its workspace comes on screen, then the page on the home tab. */
    fun openPageFromNotification(workspaceKey: String?, pageId: String) {
        pendingWorkspaceKey = workspaceKey
        pendingPage = pageId
        bringWorkspace { pendingPage = pageId }
    }

    /**
     * M77 (CANVAS.md §20.7): a canvas row of the activity tab whose conversation the store does not know yet: it lands like
     * a tapped canvas push in the workspace on screen, once the conversation is known (a known one goes on the activity
     * tab's stack instead; MainScreen).
     */
    fun openCanvasFromActivity(channelId: String, canvasId: String) {
        pendingCanvas = channelId to canvasId
    }

    /** The pending workspace on screen (switching if needed); `after` restores what the switch cleared. */
    private fun bringWorkspace(after: () -> Unit) {
        scope.launch {
            sessionLock.withLock {
                if (!restored) return@withLock // startup opens the pending workspace itself
                val key = pendingWorkspaceKey ?: return@withLock
                pendingWorkspaceKey = null
                if (workspaces.none { it.serverUrl == key }) return@withLock
                if (key != activeKey || screen == Screen.LOGIN) {
                    switchLocked(key)
                    after()
                }
            }
        }
    }

    private fun dndActive(store: Store): Boolean = Dnd.isActive(store.me?.let { store.users[it.id] ?: it.asPublic })

    /** Foreground / background from the activity: drives push suppression and reconnects (§7.5). */
    fun setForeground(active: Boolean) {
        appForeground = active
        engine?.reportActivity()
        if (!active) engine?.canvases?.flushAll() // M46 (CANVAS.md §4.4): what is typed is saved when the app goes to the background
        if (!active) engine?.wiki?.flushAll() // M122: a page's too
        if (!active) engine?.stopCanvasEditing() // M73 (§18.2): no 「編集中」 from a phone in a pocket
        if (active) {
            // M86 (DEADLINES.md §8 1.): the deadlines' window read again (a reconnect reads it anyway).
            if (engineStatus == EngineStatus.ONLINE) engine?.tasks?.refreshDeadlines()
            engine?.reconnectNow()
            if (api != null) push.refresh()
            refreshSummaries() // WORKSPACES.md §6: the other workspaces' marks
        }
    }

    suspend fun openChannel(channelId: String) {
        openChannelId = channelId
        try { engine?.openChannel(channelId) } catch (e: Exception) { report(e) }
    }

    fun closeChannel() {
        openChannelId = null
        // M28c: the engine forgets the open conversation too (§7.7, §10): its rows may be trimmed, its notices show
        // again, a mark-as-unread hold ends, and a closed preview is not kept (§7.6.1) nor opened again on a reconnect.
        engine?.closeConversation()
    }

    /** §7.6.1: more of a previewed channel as the reader scrolls up. False when the page failed (the pane offers 「再読み込み」, M28c). */
    suspend fun loadOlderPreview(channelId: String): Boolean =
        try { engine?.loadOlderPreview(channelId); true } catch (e: Exception) { report(e); false }

    /** §7.6.1: a thread opened from a preview; its replies stay in the preview. False when the fetch failed (M28c). */
    suspend fun loadPreviewReplies(channelId: String, parentId: String): Boolean =
        try { engine?.loadPreviewReplies(channelId, parentId); true } catch (e: Exception) { report(e); false }

    /**
     * THREADS.md §5: follow or unfollow a thread. Offline it says so (M28c): the engine's queued call returned without
     * effect, and the toggle looked as if it had worked. A failure on the way is reported too.
     */
    suspend fun setThreadFollow(parentId: String, following: Boolean): Boolean {
        if (engineStatus != EngineStatus.ONLINE) { error = ErrorTexts.network; return false }
        val engine = engine ?: return false
        return attempt { engine.setThreadFollow(parentId, following) }.onFailure { report(it) }.isSuccess
    }

    /** 「ここから未読にする」 (SYNC_PROTOCOL.md §10): the position it now holds, or null; offline it says so (M28c). */
    fun markUnread(channelId: String, seq: Int): Int? {
        if (engineStatus != EngineStatus.ONLINE) { error = ErrorTexts.network; return null }
        return engine?.markUnread(channelId, seq)
    }

    /**
     * A public channel from the browser's list, opened to read before joining (§7.6.1): the list it came from may be
     * newer than the sidebar's, so it joins the store as browsable first (the screen only opens channels it knows).
     */
    fun notePublicChannel(channel: jp.chikuwachat.android.api.ChannelOut) {
        if (store.channel(channel.id) == null && channel.type == "public" && channel.membership == null) store.upsertChannel(channel, isMember = false)
    }

    /** 「ログアウト」: sign out of the workspace on screen; it leaves the list and the next one opens (§5.3). */
    suspend fun logout() {
        val key = activeKey
        if (key == null) {
            screen = Screen.LOGIN
            return
        }
        signOutWorkspace(key)
    }

    /**
     * Sign out of a workspace, on screen or not (SYNC_PROTOCOL.md §11 for that workspace only): the server revokes the
     * session first (an expired access token is renewed and the call sent again); then its local store, token and
     * notifications go and it leaves the list (clientSignedOut). When the server could not be told, the push token
     * is deleted so that the still-valid session cannot keep notifying this device. One already signed out just
     * leaves the list.
     */
    suspend fun signOutWorkspace(serverUrl: String) =
        // In the controller's scope: the screen that asked goes away with the workspace.
        scope.launch { signOutNow(serverUrl) }.join()

    private suspend fun signOutNow(serverUrl: String) {
        val entry = workspaces.firstOrNull { it.serverUrl == serverUrl }
        val onScreen = serverUrl == activeKey && api != null
        val client = when {
            entry == null -> null
            onScreen -> api
            else -> clientFor(entry)
        }
        if (client == null) {
            sessionLock.withLock { forgetWorkspace(serverUrl) }
            return
        }
        leaving.add(serverUrl)
        if (onScreen) {
            val engine = engine
            if (engine != null) attempt { engine.flushDrafts() } // typed but not saved yet: kept on the server
            if (engine != null) {
                // M46: a canvas typed in the last seconds too (briefly: the sign-out does not wait on a dead network).
                engine.canvases.flushAll()
                engine.wiki.flushAll() // M122: a page's too
                kotlinx.coroutines.withTimeoutOrNull(3_000) {
                    engine.canvases.settleAll()
                    engine.wiki.settleAll()
                }
            }
            engine?.stop()
        }
        val revoked = client.logout() // onSignedOut → clientSignedOut
        if (!revoked) push.forget()
    }

    /** A client's session is over: refused refresh, revoked, or signed out on purpose (§11). */
    private suspend fun clientSignedOut(serverUrl: String, client: ApiClient) {
        if (clients[serverUrl] !== client) return // replaced by a newer sign-in, or handled already
        clients.remove(serverUrl)
        sessionLock.withLock { endSession(serverUrl, client) }
    }

    /**
     * SYNC_PROTOCOL.md §11 for one workspace: its local store (messages, drafts, send queue), stored token and
     * notifications go. A workspace the user left goes from the list (the first remaining one opens, else the login
     * form); one whose session ended stays, signed out, and shows its login form when it was on screen.
     */
    private suspend fun endSession(serverUrl: String, client: ApiClient) {
        val entry = workspaces.firstOrNull { it.serverUrl == serverUrl }
        val wasActive = api === client
        if (wasActive) {
            closeActive()
            pendingChannelId = null
            pendingReply = null
            pendingRevealId = null
        }
        push.detach(serverUrl)
        val username = entry?.username ?: if (wasActive) savedUsername else null
        if (username != null) {
            secrets.putSecret(account(serverUrl, username), null)
            withContext(Dispatchers.IO) { RoomPersistence.delete(app, account(serverUrl, username)) }
        }
        notifier.clearWorkspace(serverUrl, everything = workspaces.size <= 1)
        val leave = leaving.remove(serverUrl)
        if (leave) {
            username?.let {
                RecentSearches.clear(prefs, RecentSearches.key(account(serverUrl, it)))
                RecentConversations.clear(prefs, RecentConversations.key(account(serverUrl, it)))
            }
            replaceWorkspaces(workspaces.filterNot { it.serverUrl == serverUrl })
        } else {
            updateWorkspace(serverUrl) { it.copy(signedOut = true, badge = 0, hasUnread = false) }
        }
        if (!wasActive && !(leave && serverUrl == activeKey)) return
        if (leave) {
            val next = workspaces.firstOrNull { !it.signedOut } ?: workspaces.firstOrNull()
            if (next != null) openWorkspace(next) else showLogin(null)
        } else {
            showLogin(serverUrl)
        }
    }

    /** A workspace without a session leaves the list (「一覧から外す」); nothing of it stays on this device. */
    private suspend fun forgetWorkspace(serverUrl: String) {
        val entry = workspaces.firstOrNull { it.serverUrl == serverUrl } ?: return
        forgetAccountData(account(serverUrl, entry.username))
        push.detach(serverUrl)
        notifier.clearWorkspace(serverUrl, everything = workspaces.size <= 1)
        replaceWorkspaces(workspaces.filterNot { it.serverUrl == serverUrl })
        if (serverUrl != activeKey) return
        if (api != null || engine != null) closeActive()
        val next = workspaces.firstOrNull { !it.signedOut } ?: workspaces.firstOrNull()
        if (next != null) openWorkspace(next) else showLogin(null)
    }

    /** An account's token, local store, recent searches and conversations (§11); its database must not be open. */
    private suspend fun forgetAccountData(account: String) {
        secrets.putSecret(account, null)
        RecentSearches.clear(prefs, RecentSearches.key(account))
        RecentConversations.clear(prefs, RecentConversations.key(account))
        withContext(Dispatchers.IO) { RoomPersistence.delete(app, account) }
    }

    // --- channel actions used by the dialogs (results carry the channel id to open) ----------------

    suspend fun createChannel(name: String, type: String): Result<String> = attempt {
        val channel = api!!.createChannel(name, type)
        store.upsertChannel(channel, isMember = true).id
    }

    suspend fun createDm(userIds: List<String>): Result<String> = attempt {
        val channel = api!!.createDm(userIds)
        store.upsertChannel(channel, isMember = true).id
    }

    /**
     * Joining; a channel on screen (its preview, §7.6.1) then opens as a joined one: the preview goes and the timeline
     * loads like any conversation (§7.3).
     */
    suspend fun joinChannel(channelId: String): Boolean = attempt {
        val channel = api!!.joinChannel(channelId)
        store.upsertChannel(channel, isMember = true)
        true
    }.getOrElse { error = describe(it); false }.also { joined -> if (joined && openChannelId == channelId) openChannel(channelId) }

    /**
     * M24: my times (made on the first call; the supervisors on the roster join it); returns its id to open, or null
     * with the reason in `error`. The server's channel.created follows and is merged into the same row.
     */
    suspend fun ensureTimes(): String? = attempt {
        store.upsertChannel(api!!.ensureTimes(), isMember = true).id
    }.getOrElse { error = describe(it); null }

    // --- message actions (M8a): apply the server's answer at once; the WS event is deduplicated -----

    suspend fun editMessage(messageId: String, body: String): Result<Unit> =
        attempt { store.upsertMessage(api!!.editMessage(messageId, body)); Unit }.onFailure { error = describe(it) }

    suspend fun deleteMessage(messageId: String): Result<Unit> =
        attempt { store.upsertMessage(api!!.deleteMessage(messageId)); Unit }.onFailure { error = describe(it) }

    suspend fun listPins(channelId: String): Result<List<jp.chikuwachat.android.api.MessageOut>> = attempt { api!!.listPins(channelId) }
    suspend fun listBookmarks(cursor: String? = null): Result<jp.chikuwachat.android.api.BookmarkListOut> = attempt { api!!.listBookmarks(cursor) }
    /** L8: a page of the Times feed (TIMES_FEED.md §3). */
    suspend fun loadTimesFeed(cursor: String? = null): Result<jp.chikuwachat.android.api.TimesFeedOut> = attempt { api!!.timesFeed(cursor) }

    /** L8: one message by its id (a thread's parent held nowhere on this device); null when it cannot be read now. */
    suspend fun fetchMessage(id: String): jp.chikuwachat.android.api.MessageOut? = attempt { api!!.message(id) }.getOrNull()

    /**
     * L8 (TIMES_FEED.md §5): the Times feed's rows, kept here while its pane is closed (a row opened and back again shows
     * them at once, offline too), read again whenever the pane opens. Not stored on the device.
     */
    var timesFeedState by mutableStateOf(jp.chikuwachat.android.ui.TimesFeedState())
    suspend fun listMentions(cursor: String? = null): Result<jp.chikuwachat.android.api.MentionListOut> = attempt { api!!.listMentions(cursor) }

    /** M39: the activity badge read again (the tab's pull to refresh). */
    suspend fun refreshActivity() {
        engine?.refreshActivity()
    }

    /** M39: a page of the activity tab (`filter` all / mentions / reactions / threads). */
    suspend fun listActivity(filter: String, cursor: String? = null): Result<jp.chikuwachat.android.api.ActivityListOut> =
        attempt { api!!.listActivity(filter, cursor) }

    /**
     * M39: 「すべて既読にする」 (MOBILE_UI.md §6.4): the activity is read up to `readAt` (the server only moves it forward);
     * the dots and the badge take the answer; a failure says so. Since 2026-10-07 nothing calls it on its own (looking
     * at the list reads nothing).
     */
    suspend fun markActivityRead(readAt: String): jp.chikuwachat.android.api.ActivitySummaryOut? =
        attempt { engine?.markActivityRead(readAt) ?: api!!.markActivityRead(readAt).also { store.setActivity(it) } }
            .onFailure { error = describe(it) }
            .getOrNull()

    /**
     * 2026-10-07 (MOBILE_UI.md §6.4, 「開いたら既読」): a row of the activity was opened: its dot goes at once and the
     * server is told (SyncEngine.markActivityItemsRead). In the app's scope: the row's screen leaves as its item opens.
     * A failure only goes to the log (the item is still read by opening it on the next try, or by its conversation).
     */
    fun markActivityItemsRead(item: jp.chikuwachat.android.api.ActivityItem) {
        val engine = engine ?: return
        if (item.id == null) return
        scope.launch {
            runCatching { engine.markActivityItemsRead(listOf(item)) }
                .onFailure { if (it is kotlinx.coroutines.CancellationException) throw it else Log.i("AppController", "activity item read not saved: $it") }
        }
    }
    suspend fun listFiles(channelId: String? = null, query: String? = null, cursor: String? = null): Result<jp.chikuwachat.android.api.FileListOut> =
        attempt { api!!.listFiles(channelId, query, cursor) }
    /** M11h: every public channel plus my private ones, for the channel browser. */
    suspend fun browseChannels(): Result<List<jp.chikuwachat.android.api.ChannelOut>> =
        attempt { api!!.channels(includePublic = true).filter { it.type == "public" || it.type == "private" } }

    // --- link previews (M11g): one fetch per URL per session ------------------------------------

    /** url → preview (null value = failed / none); Compose reads this map, [loadLinkPreview] fills it. */
    val linkPreviews = mutableStateMapOf<String, LinkPreviewOut?>()
    private val previewLoads = HashSet<String>()
    /**
     * Review v0.1.18 #5: the messages (by id) whose preview was asked for by a tap on 「プレビューを表示」, for the ones
     * that never load it by themselves (an AI bot's, [jp.chikuwachat.android.ui.LinkPreviewPolicy]); kept for the session.
     */
    val previewsAsked = mutableStateMapOf<String, Boolean>()

    suspend fun loadLinkPreview(url: String) {
        val api = api ?: return
        if (linkPreviews.containsKey(url) || !previewLoads.add(url)) return
        try {
            val preview = api.linkPreview(url)
            linkPreviews[url] = if (preview.status == "ok") preview else null
        } catch (e: CancellationException) {
            throw e // the row scrolled away: a later render asks again
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
        } catch (e: Exception) { report(e) }
    }

    // --- custom emoji (M12f) ----------------------------------------------------------------------

    private val emojiLoads = HashSet<String>()

    /** M100: text emoji pills follow the app's light / dark look (MainActivity sets it); a change draws them again. */
    var textEmojiDark = false
        set(value) {
            if (field == value) return
            field = value
            store.dropTextEmojiImages()
        }

    /**
     * Fetches an emoji image once into the store's cache. M100: a text emoji's pill is drawn here instead (no request),
     * so every place that shows a custom emoji's image shows the pill.
     */
    fun loadEmojiImage(emoji: CustomEmojiOut) {
        if (store.emojiImages.containsKey(emoji.id) || !emojiLoads.add(emoji.id)) return
        if (emoji.isText) {
            val dark = textEmojiDark
            // Not while composing (onNeed is called from a composable): the next turn of the main loop.
            scope.launch {
                try { store.setEmojiImage(emoji.id, jp.chikuwachat.android.ui.TextEmojiPill.draw(emoji, dark).asImageBitmap()) }
                finally { emojiLoads.remove(emoji.id) }
            }
            return
        }
        scope.launch {
            try {
                val bytes = fetchBytes("/api/v1/emoji/${emoji.id}/image")
                val (bitmap, animation) = withContext(Dispatchers.Default) {
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() to jp.chikuwachat.android.ui.EmojiAnimation.decode(bytes)
                }
                if (bitmap != null) store.setEmojiImage(emoji.id, bitmap, animation)
            } catch (_: Exception) {
                // the text form stays; a later render retries
            } finally { emojiLoads.remove(emoji.id) }
        }
    }

    /** M100: a pack's tab icon, once per version. */
    fun loadPackTab(pack: jp.chikuwachat.android.api.EmojiPackOut) {
        val version = pack.tabVersion ?: return
        val key = "${pack.id}:$version"
        if (store.packTabImages.containsKey(key) || !emojiLoads.add(key)) return
        scope.launch {
            try {
                val bytes = fetchBytes("/api/v1/emoji/packs/${pack.id}/tab")
                val bitmap = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
                if (bitmap != null) store.setPackTab(key, bitmap)
            } catch (_: Exception) {
                // the first emoji stands in
            } finally { emojiLoads.remove(key) }
        }
    }

    // --- reminders (M12e) -------------------------------------------------------------------------

    suspend fun setReminder(messageId: String, at: ZonedDateTime, note: String? = null): Boolean {
        val api = api ?: return false
        return try {
            store.applyReminder(api.createReminder(messageId, at.toInstant().toString(), note))
            notice = L10n.str(R.string.common_will_remind_at, Schedule.label(at))
            true
        } catch (e: Exception) { report(e); false }
    }

    /** Cancels a pending reminder or marks a fired one done. */
    suspend fun closeReminder(row: ReminderOut) {
        val api = api ?: return
        try {
            api.closeReminder(row.id)
            store.applyReminder(row.copy(status = if (row.status == "fired") "done" else "cancelled"))
        } catch (e: Exception) { report(e) }
    }

    // --- scheduled messages (M12d) ----------------------------------------------------------------

    /** 「後で送信」: the server posts the draft at `sendAt`; the row shows up under 下書き. */
    /**
     * `clientMsgId` stays the same while the reader schedules the same draft again after a failure, so a lost response
     * cannot make a second row (Codex audit C2): the server answers with the row it made.
     */
    suspend fun scheduleMessage(channelId: String, parentId: String?, body: String, attachmentIds: List<String>, sendAt: ZonedDateTime, clientMsgId: String = UUID.randomUUID().toString()): Boolean {
        val api = api ?: return false
        return try {
            val row = api.scheduleMessage(channelId, clientMsgId, body, parentId, attachmentIds, sendAt.toInstant().toString())
            store.applyScheduled(row)
            notice = L10n.str(R.string.common_will_send_at, Schedule.label(sendAt))
            true
        } catch (e: Exception) { report(e); false }
    }

    /** Codex audit C3: 「削除」 on a failed scheduled message, whose text the reader does not want back. */
    suspend fun dismissScheduled(row: ScheduledOut) {
        val api = api ?: return
        try {
            api.cancelScheduled(row.id)
            store.applyScheduled(row.copy(status = "cancelled"))
        } catch (e: Exception) { report(e) }
    }

    /** Cancel a scheduled message; its text returns to the conversation's draft so nothing is lost. */
    suspend fun cancelScheduled(row: ScheduledOut) {
        val api = api ?: return
        try {
            api.cancelScheduled(row.id)
            store.applyScheduled(row.copy(status = "cancelled"))
            if (row.body.isNotEmpty()) store.setDraft(row.channelId, row.parentId) {
                jp.chikuwachat.android.ui.restoreScheduledDraft(it, row.body, store.users, store.groups)
            }
        } catch (e: Exception) { report(e) }
    }

    suspend fun sendScheduledNow(row: ScheduledOut) {
        val api = api ?: return
        try {
            api.sendScheduledNow(row.id)
            store.applyScheduled(row.copy(status = "sent"))
        } catch (e: Exception) { report(e) }
    }

    // --- permalinks (M12b) ------------------------------------------------------------------------

    fun copyPermalink(messageId: String) {
        val base = serverBase ?: return
        val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Taylis", Permalink.url(base, messageId)))
        notice = L10n.str(R.string.app_controller_link_copied)
    }

    /** 「テキストをコピー」: the body as it reads, mentions as @names. */
    fun copyText(message: MessageState) {
        val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Taylis", jp.chikuwachat.android.ui.Mentions.decode(message.body, store.users, store.groups)))
        notice = L10n.str(R.string.app_controller_text_copied)
    }

    /**
     * A permalink tapped in a body: fetch the message (membership is checked there) and hand it to the screen. M39: also
     * a reaction's notification. Whether it will show.
     */
    suspend fun openPermalink(messageId: String): Boolean {
        val api = api ?: return false
        return try {
            val message = api.message(messageId)
            revealMessage(message).also { if (it) pendingReveal = message }
        } catch (e: Exception) { report(e); false }
    }

    // --- canvases (M46, CANVAS.md §4.5) ---------------------------------------------------------

    /** M78 (CANVAS.md §21.2): `GET /canvases` for the home's 「キャンバス」 (null: signed out). */
    val myCanvasesApi: jp.chikuwachat.android.sync.MyCanvasesApi? get() = api

    /**
     * A `/c/<id>` link (CANVAS.md §4.13): the canvas opens in its conversation's 「キャンバス」 tab. Someone outside the
     * conversation is told so (403 not_a_member), a canvas in the trash or gone as not found.
     */
    suspend fun openCanvasLink(canvasId: String): Boolean {
        val api = api ?: return false
        return try {
            val canvas = api.getCanvas(canvasId, null) ?: return false
            canvasLinks[canvasId] = jp.chikuwachat.android.sync.CanvasLinkState.Ok(canvas.meta) // a tap asks again (joined since, restored)
            if (store.channel(canvas.channelId)?.isMember != true) {
                error = L10n.str(R.string.app_controller_youre_not_a_member_of_this)
                return false
            }
            pendingCanvas = canvas.channelId to canvas.id
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val state = jp.chikuwachat.android.sync.CanvasLinkState.of(e)
            if (state != jp.chikuwachat.android.sync.CanvasLinkState.Failed) canvasLinks[canvasId] = state
            error = when (state) {
                jp.chikuwachat.android.sync.CanvasLinkState.Forbidden -> L10n.str(R.string.app_controller_youre_not_a_member_of_this)
                jp.chikuwachat.android.sync.CanvasLinkState.Missing -> ErrorTexts.code("canvas_not_found") ?: describe(e)
                else -> describe(e)
            }
            false
        }
    }

    /**
     * M58: what a `/c/<id>` card shows, read once per session (the card prefers the store's list, which events keep
     * current). A failure on the network is not kept: the card asks again the next time it is drawn.
     */
    val canvasLinks = mutableStateMapOf<String, jp.chikuwachat.android.sync.CanvasLinkState>()
    private val canvasLinksAsked = HashSet<String>()

    fun loadCanvasLink(canvasId: String) {
        val api = api ?: return
        if (canvasLinks.containsKey(canvasId) || !canvasLinksAsked.add(canvasId)) return
        scope.launch {
            val state = try {
                api.getCanvas(canvasId, null)?.let { jp.chikuwachat.android.sync.CanvasLinkState.Ok(it.meta) } ?: jp.chikuwachat.android.sync.CanvasLinkState.Failed
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) { jp.chikuwachat.android.sync.CanvasLinkState.of(e) }
            canvasLinksAsked.remove(canvasId)
            canvasLinks[canvasId] = state
        }
    }

    /** A card that could not be read: tapped, it asks again. */
    fun forgetCanvasLink(canvasId: String) { canvasLinks.remove(canvasId) }

    /**
     * M58 「会話に共有」 (§4.13): the canvas's link posted to its conversation as an ordinary message (nothing new while
     * that message exists). The answer names the message, whose thread holds the comments.
     */
    suspend fun shareCanvas(canvasId: String): jp.chikuwachat.android.api.CanvasOut? {
        val api = api ?: return null
        return attempt { api.shareCanvas(canvasId) }
            .onSuccess { canvas ->
                store.applyCanvasMeta(canvas.meta)
                engine?.canvases?.current(canvasId)?.applyMeta(canvas.meta)
            }
            .onFailure { report(it) }.getOrNull()
    }

    /**
     * M58 「コメント」: the shared message (its thread holds the comments), sharing the canvas first when it never was or
     * its message is gone. The message is put in the store so the thread shows it as its parent.
     */
    suspend fun canvasCommentsMessage(canvas: jp.chikuwachat.android.api.CanvasMeta): String? {
        val api = api ?: return null
        canvas.shareMessageId?.let { id ->
            if (store.message(canvas.channelId, id)?.deleted == false) return id
            val message = try { api.message(id) } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
            if (message != null && !message.deleted) {
                store.upsertMessage(message)
                return id
            }
        }
        val shared = shareCanvas(canvas.id) ?: return null
        val id = shared.shareMessageId ?: return null
        if (store.message(shared.channelId, id) == null) {
            attempt { api.message(id) }.onSuccess { store.upsertMessage(it) }
        }
        return id
    }

    /** M58 (§4.8): one page of canvases whose title or body matches (the search's 「キャンバス」 tab). */
    suspend fun searchCanvases(query: jp.chikuwachat.android.api.CanvasSearchRequest, offset: Int = 0): Result<jp.chikuwachat.android.api.CanvasSearchOut> =
        attempt { api!!.searchCanvases(query, limit = 20, offset = offset) }.onFailure { error = describe(it) }

    /** The templates to start a canvas from (read each time the picker opens: they send no events, CANVAS.md §11). */
    suspend fun canvasTemplates(): List<jp.chikuwachat.android.api.CanvasTemplateOut>? {
        val api = api ?: return null
        return attempt { api.canvasTemplates() }.onFailure { report(it) }.getOrNull()
    }

    /**
     * A new canvas in the conversation, empty or from a template (the server fills {{date}} and the rest in my zone). A
     * failure on the network is retried with the same key, so a retry never makes a second canvas.
     */
    suspend fun createCanvas(channelId: String, templateKey: String?, title: String?, asTab: Boolean): jp.chikuwachat.android.api.CanvasOut? {
        val api = api ?: return null
        val key = UUID.randomUUID().toString()
        val zone = java.time.ZoneId.systemDefault().id
        var attemptNo = 0
        while (true) {
            try {
                val canvas = api.createCanvas(channelId, key, templateKey, title, asTab, zone)
                store.applyCanvasMeta(canvas.meta)
                return canvas
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (attemptNo < 2 && e is ApiException.Network) { attemptNo++; kotlinx.coroutines.delay(1_000L * attemptNo); continue }
                report(e)
                return null
            }
        }
    }

    /** Title, who may edit, the conversation's tab (§4.7: the creator, owners and administrators; anyone in a DM). */
    suspend fun updateCanvas(canvasId: String, title: String? = null, editPolicy: String? = null, isChannelTab: Boolean? = null): Boolean {
        val api = api ?: return false
        return attempt { api.updateCanvas(canvasId, title, editPolicy, isChannelTab) }
            .onSuccess { canvas ->
                store.applyCanvasMeta(canvas.meta)
                engine?.canvases?.current(canvasId)?.applyMeta(canvas.meta)
            }
            .onFailure { report(it) }.isSuccess
    }

    /** To the trash (restorable from the conversation's canvas list for 30 days). */
    suspend fun trashCanvas(canvasId: String, channelId: String): Boolean {
        val api = api ?: return false
        return attempt { api.deleteCanvas(canvasId) }
            .onSuccess { engine?.canvases?.trashed(canvasId, channelId) }
            .onFailure { report(it) }.isSuccess
    }

    suspend fun trashedCanvases(channelId: String): List<jp.chikuwachat.android.api.CanvasMeta>? {
        val api = api ?: return null
        return attempt { api.listCanvases(channelId, trashed = true) }.onFailure { report(it) }.getOrNull()
    }

    suspend fun restoreCanvas(canvasId: String): jp.chikuwachat.android.api.CanvasOut? {
        val api = api ?: return null
        return attempt { api.restoreCanvas(canvasId) }.onSuccess { store.applyCanvasMeta(it.meta) }.onFailure { report(it) }.getOrNull()
    }

    /** The history: a page of versions, newest first (`cursor`: the page after). */
    suspend fun canvasRevisions(canvasId: String, cursor: String? = null): jp.chikuwachat.android.api.CanvasRevisionPage? {
        val api = api ?: return null
        return attempt { api.canvasRevisions(canvasId, cursor) }.onFailure { report(it) }.getOrNull()
    }

    suspend fun canvasRevision(canvasId: String, revisionId: String): jp.chikuwachat.android.api.CanvasRevisionOut? {
        val api = api ?: return null
        return attempt { api.canvasRevision(canvasId, revisionId) }.onFailure { report(it) }.getOrNull()
    }

    /**
     * M58 (§4.9): that version's body as a new version. What is typed here is saved first (it stays in the history); a
     * failure on the network is sent again with the same key, so a retry never makes a second version.
     */
    suspend fun restoreCanvasRevision(canvasId: String, revisionId: String): jp.chikuwachat.android.api.CanvasOut? {
        val api = api ?: return null
        val saver = engine?.canvases?.current(canvasId)
        saver?.flush()
        saver?.settled()
        return attempt {
            jp.chikuwachat.android.sync.CanvasRequests.sameKey(UUID.randomUUID().toString()) { key -> api.restoreCanvasRevision(canvasId, revisionId, key) }
        }.onSuccess { canvas ->
            store.applyCanvasMeta(canvas.meta)
            saver?.remoteVersion(canvas.version)
        }.onFailure { report(it) }.getOrNull()
    }

    /** M58: a version's name; null takes it off. */
    suspend fun labelCanvasRevision(canvasId: String, revisionId: String, label: String?): jp.chikuwachat.android.api.CanvasRevisionMeta? {
        val api = api ?: return null
        return attempt { api.labelCanvasRevision(canvasId, revisionId, label) }.onFailure { report(it) }.getOrNull()
    }

    /** M58: a version's body erased (§4.7: owners and administrators; in a DM its creator). The server audits it. */
    suspend fun eraseCanvasRevision(canvasId: String, revisionId: String): jp.chikuwachat.android.api.CanvasRevisionMeta? {
        val api = api ?: return null
        return attempt { api.eraseCanvasRevision(canvasId, revisionId) }.onFailure { report(it) }.getOrNull()
    }

    /** Canvas images' metadata, once per session (M58: an image uploaded here is known at once). */
    private val canvasAttachments = HashMap<String, AttachmentOut>()

    /** A canvas image's metadata (the body names only its id); null when it cannot be seen. */
    suspend fun canvasAttachment(attachmentId: String): AttachmentOut? {
        canvasAttachments[attachmentId]?.let { return it }
        val api = api ?: return null
        return attempt { api.attachment(attachmentId) }.getOrNull()?.also { canvasAttachments[attachmentId] = it }
    }

    /**
     * M58 (§4.10): a photo picked or taken for a canvas, uploaded as pending; the save that names it binds it. Only images:
     * a canvas draws nothing else (the picker offers images only; a file that is not one is refused here).
     */
    suspend fun uploadCanvasImage(uri: Uri): AttachmentOut? {
        val uploaded = uploadAttachment(uri).getOrNull() ?: return null
        if (!uploaded.contentType.startsWith("image/")) {
            error = L10n.str(R.string.app_controller_only_images_can_go_in_a)
            return null
        }
        canvasAttachments[uploaded.id] = uploaded
        return uploaded
    }

    /** A canvas's text to the clipboard (mentions as @names, M83: task markers left out), e.g. when saving it stopped. */
    fun copyCanvasText(stored: String) {
        val clipboard = app.getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText("Taylis", Mentions.decode(CanvasMarkers.strip(stored), store.users, store.groups)))
        notice = L10n.str(R.string.app_controller_text_copied_2)
    }

    // --- calls (M117, docs/CALLS.md §7) ---------------------------------------------------------

    private val callKeys = jp.chikuwachat.android.ui.CallKeys()

    /**
     * The 📞 after its question: posts a new room (a retry after an unknown outcome sends the same key, [CallKeys]),
     * shows the message like a send from here and opens the room outside the app. 409 calls_disabled: the workspace
     * turned calls off since the settings were read, so the 📞 goes away.
     */
    suspend fun startCall(channelId: String) {
        val api = api ?: return
        val key = callKeys.take(channelId)
        val result = attempt { api.startCall(channelId, key) }
        callKeys.settle(channelId, result.exceptionOrNull())
        result.onSuccess { call ->
            engine?.postedFromHere(call.message) ?: store.upsertMessage(call.message)
            openCall(call.url)
        }.onFailure { e ->
            if (e is ApiException.Api && e.code == "calls_disabled") store.setWorkspaceSettings(store.workspaceSettings.copy(callsEnabled = false))
            report(e)
        }
    }

    /** 「参加する」 and the 📞's room: outside the app (Calls.open). */
    fun openCall(url: String) {
        if (!jp.chikuwachat.android.ui.Calls.open(app, url)) error = L10n.str(R.string.calls_could_not_open)
    }

    /** M12a: a starred channel; the flag moves at once, favorite.updated confirms on every device. */
    suspend fun toggleFavorite(channelId: String) {
        val api = api ?: return
        val on = !store.isFavorite(channelId)
        // Starring takes it out of my section at once (DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」; the server
        // does the same and sidebar.updated confirms); a refusal puts both back.
        store.setFavorite(channelId, on)
        val sections = if (on) store.takeOutOfSections(channelId) else store.sidebarSections
        try {
            if (on) api.favoriteChannel(channelId) else api.unfavoriteChannel(channelId)
        } catch (e: Exception) {
            store.setFavorite(channelId, !on)
            if (on) store.replaceSidebar(sections)
            report(e)
        }
    }

    /**
     * M118 「上に固定」/「固定を外す」: the row moves at once (a new pin last), dm_pin.updated brings my other devices along;
     * a refusal puts the pins back as they were.
     */
    suspend fun toggleDmPin(channelId: String) {
        val api = api ?: return
        val before = store.dmPins.toList()
        val on = channelId !in before
        store.setDmPin(channelId, on)
        try {
            if (on) api.pinDm(channelId) else api.unpinDm(channelId)
        } catch (e: Exception) {
            store.restoreDmPins(before)
            report(e)
        }
    }

    /**
     * M104 「ブロック」/「ブロックを解除」 (MODERATION.md §4): the flag moves at once, block.updated brings my other devices
     * along. The blocked person is not told.
     */
    suspend fun setUserBlocked(userId: String, on: Boolean) {
        val api = api ?: return
        val before = store.isBlocked(userId)
        store.setBlocked(userId, on)
        try {
            if (on) api.blockUser(userId) else api.unblockUser(userId)
            notice = if (on) L10n.str(R.string.app_controller_blocked) else L10n.str(R.string.app_controller_unblocked)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            store.setBlocked(userId, before)
            report(e)
        }
    }

    /** M104 「報告する」 (MODERATION.md §3): true when the server took it. */
    suspend fun reportMessage(messageId: String, reason: String, note: String): Boolean {
        val api = api ?: return false
        return try {
            api.reportMessage(messageId, reason, note.trim().ifEmpty { null })
            notice = L10n.str(R.string.app_controller_reported_an_administrator_will_review_it)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            report(e)
            false
        }
    }

    /**
     * M119 「問題を報告・ご意見」 / a person's 「報告する」 (MODERATION.md §3.1): `body` from Reports.body. Returns the
     * error to show in the form (validation, rate limit, network…), or null when the server took it.
     */
    suspend fun submitReport(body: JsonObject): String? {
        val api = api ?: return L10n.str(R.string.app_controller_not_signed_in)
        return try {
            api.submitReport(body)
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            describe(e)
        }
    }

    /**
     * M104 「アカウントを削除」 (MODERATION.md §2): my password, or my username for an account without one. On success the
     * server has ended every session and this workspace is signed out here. Returns the error to show, or null.
     */
    suspend fun deleteAccount(secret: String): String? {
        val api = api ?: return L10n.str(R.string.app_controller_not_signed_in)
        val key = activeKey ?: return L10n.str(R.string.app_controller_not_signed_in)
        val hasPassword = store.me?.hasPassword ?: true
        try {
            api.deleteAccount(password = if (hasPassword) secret else null, confirmUsername = if (hasPassword) null else secret)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return describe(e)
        }
        signOutWorkspace(key)
        return null
    }

    /** M12a 「すべて既読にする」; `scope` "times": the Times feed's 「すべて既読にする」 (L8, TIMES_FEED.md §4). */
    suspend fun markAllRead(scope: String? = null) {
        val engine = engine ?: return
        try { engine.markAllRead(scope) } catch (e: Exception) { report(e) }
    }

    /** M37 pull to refresh: the engine's bootstrap and catch-up again (a reconnect when offline); a failure is reported. */
    suspend fun resync() {
        val engine = engine ?: return
        try { engine.resync() } catch (e: Exception) { report(e) }
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
            report(e)
        }
    }

    suspend fun toggleReaction(message: MessageState, emoji: String): Result<Unit> = attempt {
        val me = store.me ?: return@attempt
        val adding = !message.reactedBy(me.id, emoji)
        if (adding) QuickReactions.remember(prefs, emoji) // the sheet puts what I use first
        val updated = if (adding) api!!.addReaction(message.id, emoji) else api!!.removeReaction(message.id, emoji)
        store.upsertMessage(updated)
        Unit
    }.onFailure { error = describe(it) }

    val isAdmin: Boolean get() = me?.role == "admin"

    // --- the calendar (M52, CALENDAR.md) -----------------------------------------------------------

    /** The engine's calendar; null before sign-in. */
    val calendar: jp.chikuwachat.android.sync.CalendarHub? get() = engine?.calendar

    /** The channels whose calendars I see (and filter by): public and private ones I belong to (CALENDAR.md §3; not DMs). */
    fun calendarChannels(): List<jp.chikuwachat.android.sync.ChannelState> = CalendarChannels.readable(store.channels.values)

    /** M56: the engine's tasks; null before sign-in. */
    val tasks: jp.chikuwachat.android.sync.TaskHub? get() = engine?.tasks

    // --- 「ドキュメント」 (M122, docs/WIKI.md §9.2) ---------------------------------------------------------

    /** The tree, the open pages' save loops and the titles of linked pages (null: signed out). */
    val wiki: jp.chikuwachat.android.sync.WikiHub? get() = engine?.wiki

    /**
     * A new page: under `parentId` (it takes the parent's access), or top-level with `access` "workspace" (everyone edits,
     * I manage it) or "private" (only me) — WIKI.md §4.2. A network failure is sent again with the same key, so a retry
     * never makes a second page. The page joins the tree at once (the feed confirms it).
     */
    suspend fun createWikiPage(parentId: String?, title: String?, access: String): jp.chikuwachat.android.api.PageOut? {
        val api = api ?: return null
        val zone = java.util.TimeZone.getDefault().id
        return try {
            jp.chikuwachat.android.sync.CanvasRequests.sameKey(java.util.UUID.randomUUID().toString()) { key ->
                api.createWikiPage(parentId, title, access, zone, key)
            }.also { page -> engine?.wiki?.noteItem(page.item) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            report(e)
            null
        }
    }

    /** A page's title (edit or full). */
    suspend fun renameWikiPage(pageId: String, title: String): Boolean {
        val api = api ?: return false
        return attempt { api.renameWikiPage(pageId, title) }
            .onSuccess { page ->
                engine?.wiki?.noteItem(page.item)
                engine?.wiki?.current(pageId)?.remoteVersion(page.version)
            }
            .onFailure { report(it) }.isSuccess
    }

    /** The readable pages that link to this one (null: could not be read). */
    suspend fun wikiBacklinks(pageId: String): List<jp.chikuwachat.android.api.PageItem>? {
        val api = api ?: return null
        return attempt { api.wikiBacklinks(pageId) }.getOrNull()
    }

    /** The search's 「ドキュメント」 tab (GET /search/pages): only pages I can read come back. */
    suspend fun searchPages(q: String, offset: Int = 0): Result<jp.chikuwachat.android.api.PageSearchOut> =
        attempt { api!!.searchPages(q, limit = 20, offset = offset) }.onFailure { error = describe(it) }

    /** A file link in a page (`attachment:<id>`): its metadata, then it opens like a message's file. */
    fun openAttachmentById(attachmentId: String) {
        val api = api ?: return
        scope.launch {
            attempt { api.attachment(attachmentId) }.onSuccess { openAttachment(it) }.onFailure { report(it) }
        }
    }

    /** 「リンクをコピー」: the page's `<server>/p/<id>` (WIKI.md §9.3). */
    fun copyPageLink(pageId: String) {
        val base = serverBase ?: return
        val clipboard = app.getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText("Taylis", jp.chikuwachat.android.ui.Permalink.pageUrl(base, pageId)))
        notice = L10n.str(R.string.docs_link_copied)
    }

    /** The channels I may add events to: those I may post in, not archived (§3). */
    fun writableCalendars(): List<jp.chikuwachat.android.sync.ChannelState> = CalendarChannels.writable(store.channels.values, isAdmin)

    /** M13e: confined to the channels they were added to; browsing and creation are hidden. */
    val isGuest: Boolean get() = me?.role == "guest"

    /** M16b: one page of results (30, like the desktop); a failure shows as the error snackbar. */
    suspend fun searchMessages(query: SearchRequest, offset: Int = 0): Result<SearchOut> =
        attempt { api!!.searchMessages(query, limit = SEARCH_PAGE, offset = offset) }.onFailure { error = describe(it) }

    /** "server|username" of the account on screen: names this device's data for it (recent searches). */
    val accountKey: String? get() = workspaceKey

    // --- attachments (M9a) ---------------------------------------------------------------------------

    suspend fun fetchBytes(path: String): ByteArray = api!!.fetchBytes(path)

    /**
     * Upload a picked content URI, streamed from the provider (a large file never sits in memory); the id is
     * bound when the message is sent. The size is checked against bootstrap.limits before anything is sent.
     */
    suspend fun uploadAttachment(uri: Uri): Result<AttachmentOut> = attempt {
        val api = api ?: throw Refusal(L10n.str(R.string.app_controller_you_need_to_sign_in))
        val resolver = app.contentResolver
        val (name, size) = withContext(Dispatchers.IO) { describeDocument(resolver, uri) }
        val limit = store.limits?.maxAttachmentBytes
        if (limit != null && size != null && size > limit) throw Refusal(L10n.str(R.string.app_controller_the_file_is_too_large_limit, formatSize(limit)))
        api.uploadAttachment(ContentUriBody(resolver, uri, size), name ?: "file")
    }.onFailure { error = describe(it) }

    /** Display name and size of a picked document (either may be unknown); refuses one that cannot be opened. */
    private fun describeDocument(resolver: ContentResolver, uri: Uri): Pair<String?, Long?> {
        var name: String? = null
        var size: Long? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                if (!cursor.isNull(0)) name = cursor.getString(0)
                if (!cursor.isNull(1)) size = cursor.getLong(1)
            }
        }
        val readable = runCatching { resolver.openInputStream(uri)?.use { true } }.getOrNull() == true
        if (!readable) throw Refusal(L10n.str(R.string.app_controller_couldnt_read_the_file))
        return name to size
    }

    fun openAttachment(attachment: AttachmentOut) {
        scope.launch {
            attempt {
                if (attachment.isVideo) {
                    // A video the player fetched already is handed over as it is (and one opened here streams to disk).
                    openCachedFile(app as Context, attachment, videoFile(attachment))
                } else {
                    val bytes = fetchBytes("/api/v1/attachments/${attachment.id}/content")
                    openDownloaded(app as Context, attachment, bytes)
                }
            }.onFailure { error = describe(it) }
        }
    }

    /**
     * M82: the clip of a video attachment as a file in the download cache, fetched (streamed) only the first time it is
     * opened; the tile shows the server's poster and never downloads it. A cached file of the attachment's size is reused.
     */
    suspend fun videoFile(attachment: AttachmentOut): java.io.File {
        val api = api ?: throw Refusal(L10n.str(R.string.app_controller_you_need_to_sign_in))
        val file = java.io.File(java.io.File(app.cacheDir, "downloads"), DownloadCache.path(attachment.id, attachment.filename))
        if (withContext(Dispatchers.IO) { file.isFile && file.length() == attachment.sizeBytes }) return file
        api.downloadTo("/api/v1/attachments/${attachment.id}/content", file)
        return file
    }

    suspend fun members(channelId: String): Result<List<String>> = attempt { api!!.members(channelId).map { it.userId } }

    suspend fun memberList(channelId: String): Result<List<MemberOut>> = attempt { api!!.members(channelId) }

    // --- recurring posts (L6, M60, RECURRING.md §5) ---------------------------------------------------
    // Not in the Store: the list is read each time the details page opens (its changes send no events, §7). Failures
    // come back as results; the page shows them in place (the snackbar would sit behind the form).

    suspend fun recurringPosts(channelId: String): Result<List<RecurringPostOut>> =
        attempt { api!!.recurringPosts(channelId) }

    /** Creates (`postId` null; the device's zone) or saves the form's draft. */
    suspend fun saveRecurringPost(channelId: String, postId: String?, draft: RecurringDraft): Result<RecurringPostOut> = attempt {
        if (postId == null) api!!.createRecurringPost(channelId, Recurring.createBody(draft, java.time.ZoneId.systemDefault().id))
        else api!!.updateRecurringPost(postId, Recurring.updateBody(draft))
    }

    suspend fun setRecurringEnabled(postId: String, enabled: Boolean): Result<RecurringPostOut> =
        attempt { api!!.updateRecurringPost(postId, Recurring.enabledBody(enabled)) }

    suspend fun deleteRecurringPost(postId: String): Result<Unit> = attempt { api!!.deleteRecurringPost(postId) }

    suspend fun runRecurringPost(postId: String): Result<RecurringRunOut> = attempt { api!!.runRecurringPost(postId) }

    // --- workflows (M95, WORKFLOWS.md §8) -------------------------------------------------------------
    // Phones run workflows only (§8 5.). Failures of the list come back as results (the menu says so in place).

    /** The channel's workflows (the ＋ menu, channel details, `/`); `fresh` reads past the one-minute cache. */
    suspend fun channelWorkflows(channelId: String, fresh: Boolean = false): Result<List<jp.chikuwachat.android.api.WorkflowOut>> {
        if (!fresh) workflowLists.get(channelId)?.let { return Result.success(it) }
        return attempt { api!!.channelWorkflows(channelId) }.onSuccess { workflowLists.put(channelId, it) }
    }

    /** 「#name」 of a workflow's target, or words for one this device does not know. */
    fun workflowTarget(channelId: String): String = store.channel(channelId)?.channel?.name?.let { "#$it" } ?: L10n.str(R.string.app_controller_the_destination_channel)

    /** Opens the form, or says why it cannot run (the desktop's runBlockedText). `here`: the conversation it is opened from. */
    fun openWorkflow(workflow: jp.chikuwachat.android.api.WorkflowOut, here: String?) {
        if (!workflow.canRun) {
            error = jp.chikuwachat.android.ui.Workflows.runBlockedText(workflow.runBlocked, workflowTarget(workflow.channelId)) ?: L10n.str(R.string.common_this_workflow_cant_be_used)
            return
        }
        workflowForm = jp.chikuwachat.android.ui.WorkflowSession(workflow, here, java.time.LocalDate.now(), store.me?.id)
    }

    /** The 「⚡ name」 label: the workflow as it is now (it may have changed, stopped or gone since the message). */
    suspend fun openWorkflowById(workflowId: String, here: String?) {
        attempt { api!!.workflow(workflowId) }
            .onSuccess { openWorkflow(it, here) }
            .onFailure { report(it) }
    }

    /**
     * Posts the open form (the server renders the message, as me). On success the form closes and the message shows like
     * a send from here; a target other than `here` is said. A refusal stays in the form ([WorkflowSession.problem]).
     */
    suspend fun submitWorkflow(session: jp.chikuwachat.android.ui.WorkflowSession) {
        val api = api ?: return
        val message = session.submit({ id, body -> api.submitWorkflow(id, body) }, ::describe) ?: return
        engine?.postedFromHere(message) ?: store.upsertMessage(message)
        postedHere = message.id
        if (workflowForm === session) workflowForm = null
        if (session.here != null && message.channelId != session.here) notice = L10n.str(R.string.app_controller_posted_to, workflowTarget(message.channelId))
    }

    // --- channel info & settings (UI brush-up) --------------------------------------------------

    suspend fun updateTopic(channelId: String, topic: String): Boolean = attempt {
        val channel = api!!.updateChannel(channelId, topic = topic.trim())
        store.upsertChannel(channel)
        true
    }.getOrElse { error = describe(it); false }

    // --- channel management (M11h) ------------------------------------------------------------------

    suspend fun updatePurpose(channelId: String, purpose: String): Boolean = attempt {
        store.upsertChannel(api!!.updateChannel(channelId, purpose = purpose.trim()))
        true
    }.getOrElse { error = describe(it); false }

    suspend fun renameChannel(channelId: String, name: String): Boolean = attempt {
        store.upsertChannel(api!!.updateChannel(channelId, name = name.trim()))
        true
    }.getOrElse { error = describe(it); false }

    /** M15a: "owners" makes an announcement channel (owners and admins start the posts). */
    suspend fun setPostingPolicy(channelId: String, policy: String): Boolean = attempt {
        store.upsertChannel(api!!.updateChannel(channelId, postingPolicy = policy))
        true
    }.getOrElse { error = describe(it); false }

    /** L4 (M31): make a member an owner ("owner") or a member again ("member"); the Store follows at once. */
    suspend fun setMemberRole(channelId: String, userId: String, role: String): Boolean = attempt {
        val member = api!!.updateMemberRole(channelId, userId, role)
        store.applyMemberUpdated(channelId, member.userId, member.role)
        true
    }.getOrElse { error = describe(it); false }

    /** L4 (M31): 「在席を隠す」; others always see me offline. */
    suspend fun setPresenceHidden(hidden: Boolean): Boolean = updateProfileJson(buildJsonObject { put("presence_hidden", hidden) })

    /** M15b: public → private (owner / admin) or private → public (an admin who is a member, L4). */
    suspend fun convertChannel(channelId: String, type: String): Boolean = attempt {
        store.upsertChannel(api!!.updateChannel(channelId, type = type))
        true
    }.getOrElse { error = describe(it); false }

    suspend fun archiveChannel(channelId: String): Boolean = attempt {
        store.upsertChannel(api!!.archiveChannel(channelId))
        true
    }.getOrElse { error = describe(it); false }

    suspend fun unarchiveChannel(channelId: String): Boolean = attempt {
        store.upsertChannel(api!!.unarchiveChannel(channelId))
        true
    }.getOrElse { error = describe(it); false }

    /** M13c: post a quote of `message` and its permalink into another conversation. */
    suspend fun shareMessage(message: MessageState, channelId: String, comment: String): Boolean {
        val base = serverBase ?: return false
        val engine = engine ?: return false
        engine.send(channelId, Share.body(message.body, Permalink.url(base, message.id), comment))
        notice = L10n.str(R.string.app_controller_shared)
        return true
    }

    /** Leaving drops the channel locally at once; the server's member_removed confirms it. */
    suspend fun leaveChannel(channelId: String): Boolean = attempt {
        api!!.leaveChannel(channelId)
        engine?.dropChannel(channelId) ?: store.removeChannel(channelId) // its fetched threads go with it (§10.2)
        true
    }.getOrElse { error = describe(it); false }

    /**
     * PUT the channel's notification preference (M35): `level` null follows the overall setting; `mutedUntil` is sent
     * as given (null ends a timed mute); `muted` null leaves the mute-until-unmuted as it is.
     */
    suspend fun setNotification(channelId: String, level: String?, mutedUntil: String? = null, muted: Boolean? = null): Boolean = attempt {
        store.setNotification(api!!.setNotificationPreference(channelId, level, mutedUntil, muted))
        true
    }.getOrElse { error = describe(it); false }

    /** The channel's menu: its own level (null = 「既定」), keeping a running timed mute and the mute as they are. */
    suspend fun setChannelLevel(channelId: String, level: String?): Boolean {
        val state = store.channels[channelId] ?: return false
        return setNotification(channelId, level, NotificationLevels.keptMutedUntil(state))
    }

    /** 「ミュート」 (M35, until unmuted) on or off, keeping the channel's own level (or none) and a running timed mute. */
    suspend fun setChannelMuted(channelId: String, on: Boolean): Boolean {
        val state = store.channels[channelId] ?: return false
        return setNotification(channelId, NotificationLevels.own(state), NotificationLevels.keptMutedUntil(state), muted = on)
    }

    /** 「8 時間ミュート」 (until = the end) and its ミュート解除 (null), keeping the channel's own level (or none). */
    suspend fun setChannelTimedMute(channelId: String, until: String?): Boolean {
        val state = store.channels[channelId] ?: return false
        return setNotification(channelId, NotificationLevels.own(state), until)
    }

    /**
     * M35: the overall notification setting (「自分」の通知). The Store's UserMe takes the answer, so channels following
     * the default show the new level at once; my other devices learn it on their next bootstrap.
     */
    suspend fun setNotificationDefault(overall: String): Boolean = updateProfileJson(buildJsonObject { put("notification_default", overall) })

    /** M56: 「タスク (割り当て・期限)」, the pushes (and the open app's notices) of task.assigned / task.due. */
    suspend fun setNotifyTasks(on: Boolean): Boolean = updateProfileJson(buildJsonObject { put("notify_tasks", on) })

    /** M39: 「リアクションのバナー」, a push when someone reacts to my message (the activity lists it either way). */
    suspend fun setNotifyReactions(on: Boolean): Boolean = updateProfileJson(buildJsonObject { put("notify_reactions", on) })

    /**
     * M50: the long-press sheet's reactions (1–6 plain emoji, in order; the server checks), or null for 「元に戻す」 (recent
     * first, then the defaults). On my account: my other devices take it with UserMe, as they do notify_reactions.
     */
    suspend fun setQuickReactions(emoji: List<String>?): Boolean = updateProfileJson(buildJsonObject {
        if (emoji == null) put("quick_reactions", JsonNull) else put("quick_reactions", JsonArray(emoji.map { JsonPrimitive(it) }))
    })

    /**
     * M111: 「ホームのタイル」 (the whole list, apps/shared/nav-items.json), or null for 「元に戻す」 (the defaults). Shown at
     * once and taken back when the server refuses (the reason is shown); my other devices read it again on user.updated.
     */
    suspend fun setNavItems(items: List<NavItem>?): Boolean {
        val before = store.me ?: return false
        val json = items?.let { list -> JsonArray(list.map { buildJsonObject { put("key", it.key); put("visible", it.visible) } }) } ?: JsonNull
        val shown = before.copy(navItemsJson = json)
        store.setMe(shown)
        if (updateProfileJson(buildJsonObject { put("nav_items", json) })) return true
        if (store.me == shown) store.setMe(before)
        return false
    }

    /** M11d: title / custom status. Pass null for a field to clear it; absent keys keep their value. */
    suspend fun updateProfile(fields: Map<String, String?>): Boolean =
        updateProfileJson(buildJsonObject { fields.forEach { (key, value) -> if (value == null) put(key, JsonNull) else put(key, value) } })

    /** M12c: quiet_hours is an object, so the status dialog builds the body itself. */
    suspend fun updateProfileJson(body: JsonObject): Boolean = attempt {
        val updated = api!!.updateProfile(body)
        me = updated
        store.setMe(updated)
        store.upsertUser(updated.asPublic)
        true
    }.getOrElse { error = describe(it); false }

    /** M23: my research topic and reading on the lab roster; null clears (roster.updated tells my other devices). */
    suspend fun updateMyRosterLine(researchTopic: String?, reading: String?): Boolean = attempt {
        val myId = (store.me ?: me)?.id ?: return false
        store.applyRoster(myId, api!!.updateMyRosterLine(researchTopic, reading))
        true
    }.getOrElse { error = describe(it); false }

    /**
     * Open (or create) the DM with one user; returns its channel id. The existing one has exactly that user and me as its
     * members, so my own id finds my own DM (made on the first call), not one of my 1:1 DMs.
     */
    suspend fun openDmWith(userId: String): String? {
        MainTabs.findDmWith(store.channels.values, userId, (store.me ?: me)?.id)?.let { return it.id }
        return createDm(listOf(userId)).getOrElse { error = describe(it); null }
    }

    /** M16g: a picked photo, decoded small and upright for the crop dialog; null (the error shown) when unreadable. */
    suspend fun loadAvatarPhoto(uri: Uri): Bitmap? =
        withContext(Dispatchers.Default) { AvatarPhoto.decode(app.contentResolver, uri) }
            ?: run { error = ErrorTexts.code("avatar_not_image"); null }

    /** M14a / M16g: the cropped square (a 512 px JPEG) becomes my profile picture; the store learns it at once. */
    suspend fun uploadAvatar(jpeg: ByteArray): Boolean = attempt {
        val api = api ?: throw Refusal(L10n.str(R.string.app_controller_you_need_to_sign_in))
        val updated = api.uploadAvatar(jpeg.toRequestBody("image/jpeg".toMediaTypeOrNull()))
        me = updated
        store.setMe(updated)
        true
    }.getOrElse { error = describe(it); false }

    suspend fun deleteAvatar(): Boolean = attempt {
        val updated = api!!.deleteAvatar()
        me = updated
        store.setMe(updated)
        true
    }.getOrElse { error = describe(it); false }

    /** M96: rename myself; null when done, else the reason for under the field (taken, reserved, 3 times in 24 hours …). */
    suspend fun renameMe(username: String): String? = attempt {
        val client = api ?: return L10n.str(R.string.app_controller_not_signed_in)
        val updated = client.updateUsername(username)
        me = updated
        store.setMe(updated)
        store.upsertUser(updated.asPublic)
        followUsername(client.baseUrl, updated.username)
        null
    }.getOrElse { describe(it) }

    suspend fun updateDisplayName(displayName: String): Boolean = attempt {
        val updated = api!!.updateMe(displayName = displayName.trim())
        me = updated
        store.setMe(updated)
        true
    }.getOrElse { error = describe(it); false }

    /** Password change from the settings sheet; returns the error text or null. */
    // --- sidebar sections (M14f) -------------------------------------------------------------

    private suspend fun sidebarChange(work: suspend (ApiClient) -> List<jp.chikuwachat.android.api.SidebarSectionOut>): Boolean = attempt {
        store.replaceSidebar(work(api!!)); true
    }.getOrElse { error = describe(it); false }

    /** A new section at the end (M26: with its icon); `channelIds` move into it from wherever they were. */
    suspend fun createSection(name: String, emoji: String?, channelIds: List<String>): Boolean =
        // DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」: they are no longer starred. The server unstarred them in the
        // same change (favorite.updated confirms); the rows move here at once.
        sidebarChange { it.createSidebarSection(name, emoji, channelIds) }.also { if (it) store.leaveFavorites(channelIds) }

    /** M26: the name and the icon (null takes it off). */
    suspend fun editSection(id: String, name: String, emoji: String?): Boolean = sidebarChange { it.editSidebarSection(id, name, emoji) }

    /**
     * M26: folds or unfolds one of my sections on all my devices. The list changes at once; if the server refuses, it
     * goes back.
     */
    suspend fun setSectionCollapsed(id: String, collapsed: Boolean): Boolean {
        val before = store.sidebarSections
        store.replaceSidebar(before.map { if (it.id == id) it.copy(collapsed = collapsed) else it })
        return sidebarChange { it.updateSidebarSection(id, collapsed = collapsed) }.also { if (!it) store.replaceSidebar(before) }
    }

    suspend fun moveSection(id: String, position: Int): Boolean = sidebarChange { it.updateSidebarSection(id, position = position) }
    suspend fun deleteSection(id: String): Boolean = sidebarChange { it.deleteSidebarSection(id) }

    /** Which section a sort belongs to: one of mine (its id) or a default one ("favorites", "channels", "dms"). */
    sealed interface SortTarget {
        data class Section(val id: String) : SortTarget
        data class Default(val key: String) : SortTarget
    }

    /**
     * DATA_MODEL.md sidebar_sections 「並べ替え」: a section's sort. 「手動」 starts from the order shown now (`shownIds`), so
     * nothing jumps. Changes at once here; a refusal puts it back.
     */
    suspend fun setSectionSort(target: SortTarget, sort: String, shownIds: List<String>): Boolean =
        applySort(target, sort, if (sort == "manual") shownIds else null)

    /** The order made by hand (「順番を編集」's arrows); the section stays 「手動」. */
    suspend fun reorderSection(target: SortTarget, ids: List<String>): Boolean = applySort(target, "manual", ids)

    private suspend fun applySort(target: SortTarget, sort: String, manualOrder: List<String>?): Boolean = when (target) {
        is SortTarget.Section -> {
            val before = store.sidebarSections
            store.replaceSidebar(before.map { if (it.id == target.id) it.copy(sort = sort, manualOrder = manualOrder ?: it.manualOrder) else it })
            sidebarChange { it.updateSidebarSection(target.id, sort = sort, manualOrder = manualOrder) }.also { if (!it) store.replaceSidebar(before) }
        }
        is SortTarget.Default -> {
            val before = store.sidebarDefaults
            val row = store.defaultSort(target.key).let { it.copy(sort = sort, manualOrder = manualOrder ?: it.manualOrder) }
            store.replaceSidebarDefaults(before.filter { it.key != target.key } + row)
            attempt { store.replaceSidebarDefaults(api!!.updateSidebarDefault(target.key, sort, manualOrder)); true }
                .getOrElse { store.replaceSidebarDefaults(before); error = describe(it); false }
        }
    }

    /** `sectionId` null puts it back in the default sections; into a section it leaves お気に入り too. */
    suspend fun moveToSection(channelId: String, sectionId: String?): Boolean =
        sidebarChange { api -> if (sectionId != null) api.placeInSidebarSection(sectionId, channelId) else api.removeFromSidebarSection(channelId) }
            .also { if (it && sectionId != null) store.leaveFavorites(listOf(channelId)) }

    // --- edit history (M14c) -------------------------------------------------------------------

    suspend fun messageRevisions(messageId: String): List<jp.chikuwachat.android.api.MessageRevisionOut>? =
        attempt { api!!.messageRevisions(messageId) }.getOrElse { error = describe(it); null }

    // --- channel links (M15f) ----------------------------------------------------------------

    suspend fun addChannelLink(channelId: String, title: String, url: String): Boolean = attempt {
        store.setChannelLinks(channelId, api!!.addChannelLink(channelId, title, url)); true
    }.getOrElse { error = describe(it); false }

    suspend fun updateChannelLink(channelId: String, linkId: String, title: String? = null, url: String? = null, position: Int? = null): Boolean = attempt {
        store.setChannelLinks(channelId, api!!.updateChannelLink(channelId, linkId, title, url, position)); true
    }.getOrElse { error = describe(it); false }

    suspend fun deleteChannelLink(channelId: String, linkId: String): Boolean = attempt {
        store.setChannelLinks(channelId, api!!.deleteChannelLink(channelId, linkId)); true
    }.getOrElse { error = describe(it); false }

    // --- reservation pools (M99, M112, docs/RESERVATIONS.md §6) ----------------------------------------

    /** M112: a booking (start on the hour, `hours` long). */
    suspend fun bookReservation(poolId: String, startAt: java.time.Instant, hours: Int): PoolOut? =
        withPool { it.bookReservation(poolId, startAt.toString(), hours) }

    /** M112: 「延長」 by an hour. */
    suspend fun extendReservation(reservationId: String): PoolOut? = withPool { it.extendReservation(reservationId) }

    /** M112: the main screen should open 「予約」 (a tapped notification). */
    var pendingReservations by mutableStateOf(false)

    /** M112: a tapped reservation notification: its workspace comes on screen, then 「予約」 opens on the home tab. */
    fun openReservationsFromNotification(workspaceKey: String?) {
        pendingWorkspaceKey = workspaceKey
        pendingReservations = true
        bringWorkspace { pendingReservations = true }
    }

    /** Runs one call that answers with the pool and puts it in the store; an error goes to the banner. */
    private suspend fun withPool(call: suspend (ApiClient) -> PoolOut): PoolOut? = attempt {
        val pool = call(api!!)
        store.putReservationPool(pool)
        pool
    }.getOrElse { error = describe(it); null }

    /** 「今すぐ (順番待ち)」. */
    suspend fun reservePool(poolId: String): PoolOut? = withPool { it.reserve(poolId) }

    /** cancel / return / assign / remove. */
    suspend fun reservationAction(reservationId: String, action: String): PoolOut? = withPool { it.reservationAction(reservationId, action) }

    /** 「入れ替えた」. */
    suspend fun swapReservations(poolId: String, removeId: String, assignId: String): PoolOut? =
        withPool { it.swapReservations(poolId, removeId, assignId) }

    // --- 在室状況 (M140, docs/PRESENCE.md §9) ----------------------------------------------------------

    /** My state and note; the answer is my row at once (the event follows for my other devices). */
    suspend fun setMyAttendance(stateId: String, note: String?): Boolean = attempt {
        store.applyAttendanceEntry(api!!.setMyAttendance(stateId, note)); true
    }.getOrElse { error = describe(it); false }

    /** Adds (`id` null) or changes one of my own states; the board is read again (the states list). */
    suspend fun saveMyAttendanceState(id: String?, label: String, emoji: String?, color: String, kind: String): Boolean = attempt {
        if (id == null) api!!.createMyAttendanceState(label, emoji, color, kind) else api!!.updateMyAttendanceState(id, label, emoji, color, kind)
        engine?.loadAttendance(); true
    }.getOrElse { error = describe(it); false }

    suspend fun deleteMyAttendanceState(id: String): Boolean = attempt {
        api!!.deleteMyAttendanceState(id)
        engine?.loadAttendance(); true
    }.getOrElse { error = describe(it); false }

    // --- acknowledgements (M15e) ----------------------------------------------------------------

    suspend fun toggleAck(message: MessageState) {
        val me = store.me ?: return
        val mine = message.acks.any { it.userId == me.id }
        attempt { store.upsertMessage(api!!.acknowledge(message.id, !mine)) }.onFailure { error = describe(it) }
    }

    /** L4 (M31): who has not acknowledged `messageId` yet, by display name (a failure is shown in the dialog, see [describe]). */
    suspend fun ackPending(messageId: String): Result<List<String>> = attempt { api!!.ackPending(messageId).userIds }

    /**
     * L4 (M31): the author or an admin reminds those who have not acknowledged. The outcome in words, shown in the
     * acknowledgement dialog itself (the snackbar would be hidden behind it): the count, or the failure (e.g. once an hour).
     */
    suspend fun remindAck(messageId: String): AckReminders.Outcome = attempt {
        AckReminders.Outcome(AckReminders.notice(api!!.remindAck(messageId).reminded), failed = false)
    }.getOrElse { AckReminders.Outcome(describe(it), failed = true) }

    // --- polls (M14b) ------------------------------------------------------------------------

    /** M27: the response's `mine` is mine whatever arrived meanwhile (Store.applyMyPollResponse). */
    suspend fun vote(message: MessageState, option: Int, present: Boolean): Boolean = attempt {
        store.applyMyPollResponse(api!!.vote(message.id, option, present)); true
    }.getOrElse { error = describe(it); false }

    suspend fun closePoll(message: MessageState): Boolean = attempt {
        store.applyMyPollResponse(api!!.closePoll(message.id)); true
    }.getOrElse { error = describe(it); false }

    /** M27: `anonymous` hides who voted from everyone (fixed once made). */
    suspend fun createPoll(channelId: String, parentId: String?, question: String, options: List<String>, multiple: Boolean, anonymous: Boolean = false): Boolean = attempt {
        val message = api!!.postPoll(channelId, parentId, question, options, multiple, anonymous)
        engine?.postedFromHere(message) ?: store.upsertMessage(message)
        postedHere = message.id
        true
    }.getOrElse { error = describe(it); false }

    // --- scheduling polls (M53/M54, SCHEDULING.md) -----------------------------------------------

    /** What deciding came to: done, refused because the event cannot be made (offer to decide without), or failed (shown). */
    enum class DecideOutcome { DONE, NEEDS_NO_EVENT, FAILED }

    /** A scheduling poll: the candidates as UTC instants (or dates) and the device's zone, in which the server labels them. */
    suspend fun createSchedulePoll(channelId: String, parentId: String?, question: String, slots: List<jp.chikuwachat.android.api.ScheduleSlotIn>, tz: String, anonymous: Boolean = false): Boolean = attempt {
        val message = api!!.postSchedulePoll(channelId, parentId, question, slots, tz, anonymous)
        engine?.postedFromHere(message) ?: store.upsertMessage(message)
        postedHere = message.id
        true
    }.getOrElse { error = describe(it); false }

    /**
     * My ○ / △ / × for every candidate at once (null = unanswered); `comment` null keeps mine, "" removes it. The response's
     * my_answers / my_comment are mine whatever arrived meanwhile (Store.applyMyPollResponse, SYNC_PROTOCOL.md §8).
     */
    suspend fun answerSchedule(message: MessageState, answers: List<String?>, comment: String? = null): Boolean = attempt {
        val change = if (comment == null) jp.chikuwachat.android.api.CommentChange.Keep
        else jp.chikuwachat.android.api.CommentChange.Set(comment.trim().ifEmpty { null })
        store.applyMyPollResponse(api!!.answerPoll(message.id, jp.chikuwachat.android.ui.SchedulePolls.answersBody(answers), change)); true
    }.getOrElse { error = describe(it); false }

    /**
     * Decide a candidate: the server makes the channel's event (not in a DM) and replies in the thread. SCHEDULING.md §7 3.:
     * when I may not add to the channel's calendar (an announcement channel I do not own) the whole decision is refused
     * with 403 posting_restricted; the card then offers to decide without the event (`createEvent` false).
     */
    suspend fun decideSchedule(message: MessageState, index: Int, createEvent: Boolean = true): DecideOutcome = attempt {
        store.applyMyPollResponse(api!!.decidePoll(message.id, index, createEvent))
        notice = L10n.str(R.string.app_controller_date_decided)
        DecideOutcome.DONE
    }.getOrElse {
        if (createEvent && it is ApiException.Api && it.code == "posting_restricted") DecideOutcome.NEEDS_NO_EVENT
        else { error = describe(it); DecideOutcome.FAILED }
    }

    /** Take the decision back: answering reopens (`decided` and `closed_at` both null); the event stays. */
    suspend fun undecideSchedule(message: MessageState): Boolean = attempt {
        store.applyMyPollResponse(api!!.undecidePoll(message.id)); true
    }.getOrElse { error = describe(it); false }

    /** The card's 「予定を開く」: the event the decision made, in the M52 event form (read from the server: it may be outside every range). */
    suspend fun openDecidedEvent(eventId: String) {
        val hub = calendar ?: return
        attempt { hub.get(eventId) }
            .onSuccess { calendarForm = jp.chikuwachat.android.ui.CalendarForm(it, null) }
            .onFailure { error = describe(it) }
    }

    /**
     * §10.1 rule 11 (M28c): the id of my latest post (top-level or a reply) made through an endpoint of its own (a poll), for the
     * open conversation to show it at the bottom like a send from the outbox (the desktop's and iOS's postedHere).
     */
    var postedHere by mutableStateOf<String?>(null)

    // --- slash commands (M13b) ---------------------------------------------------------------

    /** Runs a command typed in the composer; false when it could not (the reason is in `error`). */
    suspend fun runCommand(command: SlashCommands.Parsed, channelId: String, parentId: String?): Boolean {
        val api = api ?: return false
        val state = store.channels[channelId] ?: return false
        val isDm = state.channel.type == "dm" || state.channel.type == "group_dm"
        val spec = SlashCommands.all.firstOrNull { it.name == command.name }
        if (spec == null) { error = L10n.str(R.string.common_there_is_no_command_help_lists, command.name); return false }
        if (spec.channelOnly && isDm) { error = L10n.str(R.string.app_controller_can_only_be_used_in_channels, command.name); return false }
        fun user(handle: String) = store.users.values.firstOrNull { it.username.equals(handle.removePrefix("@"), ignoreCase = true) }
        // M35: the channel's own level, null while it follows the overall setting (so a mute does not pin a level).
        val level = NotificationLevels.own(state)
        return when (command.name) {
            "help" -> {
                // M30: the templates' names too, in the order the template button shows them.
                val templates = Templates.ordered(store.templates.values, inTimes = state.channel.isTimes)
                notice = SlashCommands.all.joinToString(" · ") { it.usage } +
                    if (templates.isEmpty()) "" else L10n.str(R.string.app_controller_templates) + templates.map { it.name }.distinct().joinToString(" ") { "/$it" }
                true
            }
            "status" -> {
                if (command.args.isEmpty() || command.args == "clear") {
                    updateProfileJson(buildJsonObject { put("status_text", JsonNull); put("status_emoji", JsonNull); put("status_expires_at", JsonNull) })
                        .also { if (it) notice = L10n.str(R.string.app_controller_status_cleared) }
                } else {
                    val (emoji, text) = SlashCommands.splitStatus(command.args)
                    updateProfileJson(buildJsonObject {
                        put("status_text", text.ifEmpty { null }?.let { JsonPrimitive(it) } ?: JsonNull)
                        put("status_emoji", emoji?.let { JsonPrimitive(it) } ?: JsonNull)
                        put("status_expires_at", JsonNull)
                    }).also { if (it) notice = L10n.str(R.string.app_controller_status_updated) }
                }
            }
            "dnd" -> {
                if (command.args.isEmpty() || command.args == "off") {
                    updateProfileJson(buildJsonObject { put("dnd_until", JsonNull) }).also { if (it) notice = L10n.str(R.string.app_controller_notifications_resumed) }
                } else {
                    val until = SlashCommands.duration(command.args)
                    if (until == null) { error = "/dnd 30m | 1h | 2h | 4h | tomorrow | off"; false }
                    else updateProfileJson(buildJsonObject { put("dnd_until", until.toInstant().toString()) }).also { if (it) notice = L10n.str(R.string.common_notifications_paused_until, Schedule.label(until)) }
                }
            }
            "topic" -> updateTopic(channelId, command.args)
            "leave" -> leaveChannel(channelId)
            "invite" -> {
                val handles = command.args.split(Regex("\\s+")).filter { it.isNotEmpty() }
                if (handles.isEmpty()) { error = L10n.str(R.string.app_controller_invite_name); return false }
                // M89: everyone named first, then one batch (one 「追加しました」 line, MEMBERSHIP.md §5 item 6).
                val targets = handles.map { handle -> user(handle) ?: run { error = L10n.str(R.string.app_controller_there_is_no_user_called, handle); return false } }
                val added = addMembers(channelId, targets.map { it.id })
                if (added.isFailure) { error = describe(added.exceptionOrNull()!!); return false }
                notice = L10n.plural(R.plurals.app_controller_added_people, handles.size, handles.size)
                true
            }
            "join" -> {
                val name = command.args.removePrefix("#").lowercase()
                val target = store.channels.values.firstOrNull { it.channel.type == "public" && (it.channel.name ?: "").lowercase() == name }
                if (target == null) { error = L10n.str(R.string.app_controller_there_is_no_public_channel_called, name); return false }
                if (!target.isMember && !joinChannel(target.id)) return false
                pendingChannelId = target.id
                true
            }
            "dm" -> {
                val target = user(command.args.substringBefore(' '))
                if (target == null) { error = L10n.str(R.string.common_dm_name); return false }
                val id = openDmWith(target.id) ?: return false
                pendingChannelId = id
                true
            }
            "mute" -> {
                val until = if (command.args.isEmpty()) ZonedDateTime.now().plusHours(8) else SlashCommands.duration(command.args)
                if (until == null) { error = "/mute 1h | 8h | tomorrow"; return false }
                setNotification(channelId, level, until.toInstant().toString()).also { if (it) notice = L10n.str(R.string.common_notifications_paused_until, Schedule.label(until)) }
            }
            // Both mutes end: the timed one and the one until unmuted (M35).
            "unmute" -> setNotification(channelId, level, null, muted = false).also { if (it) notice = L10n.str(R.string.app_controller_notifications_resumed_2) }
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
                if (parts.size < 3) { error = L10n.str(R.string.common_poll_question_option_option); return false }
                createPoll(channelId, parentId, parts[0], parts.drop(1), multiple = false)
            }
            SlashCommands.SCHEDULE -> {
                // M54: a scheduling poll of the dates read (the composer opens the form with them instead, to check first).
                val read = Templates.readSchedule(command.args, LocalDate.now())
                val slots = read?.let { jp.chikuwachat.android.ui.SchedulePolls.slotsFromEntries(it.entries) } ?: emptyList()
                if (read == null || slots.size < jp.chikuwachat.android.ui.SchedulePolls.MIN_SLOTS || slots.size > jp.chikuwachat.android.ui.SchedulePolls.MAX_SLOTS) {
                    error = Templates.SCHEDULE_USAGE
                    return false
                }
                createSchedulePoll(channelId, parentId, read.question, slots.map { jp.chikuwachat.android.ui.SchedulePolls.slotToIn(it) }, java.time.ZoneId.systemDefault().id)
            }
            else -> false
        }
    }

    /** M40: my signed-in devices (GET /auth/sessions); the failure is for the screen to show. */
    suspend fun sessions(): Result<List<jp.chikuwachat.android.api.SessionOut>> = attempt { api!!.sessions() }

    /**
     * 「テスト通知を送る」 (PUSH_NOTIFICATIONS.md §15): the server pushes to every device of mine (this one too; [handlePush]
     * shows a test push even with the app open). The failure is for the screen to show.
     */
    suspend fun sendTestNotification(): Result<jp.chikuwachat.android.api.TestNotificationOut> = attempt { api!!.sendTestNotification() }

    /** M40: signs another device out (DELETE /auth/sessions/{id}); false with the error shown. */
    suspend fun revokeSession(id: String): Boolean = attempt { api!!.revokeSession(id); true }.getOrElse { error = describe(it); false }

    /** M40: the web client of the workspace on screen in the browser (the administration lives there). */
    fun openWebClient() {
        val base = serverBase ?: return
        val intent = Intent(Intent.ACTION_VIEW, base.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { app.startActivity(intent) }.onFailure { error = ErrorTexts.unknown }
    }

    suspend fun changePasswordInSession(current: String, new: String): String? =
        attempt { api!!.changePassword(current, new); null }.getOrElse { describe(it) }

    suspend fun addMember(channelId: String, userId: String): Result<Unit> = attempt<Unit> { api!!.addMember(channelId, userId) }

    /** M89 (MEMBERSHIP.md §5 item 6): several people in one batch (one line); one at a time on a 405 from an older server. */
    suspend fun addMembers(channelId: String, userIds: List<String>): Result<Unit> = attempt {
        val api = api!!
        jp.chikuwachat.android.sync.AddMembers.add(userIds, batch = { api.addMembers(channelId, it) }, single = { api.addMember(channelId, it) })
    }

    /**
     * A failure in words (ARCHITECTURE.md §9): the Japanese table by code, then by HTTP status, never the
     * server's English message or an exception's own text.
     */
    fun describe(e: Throwable): String = when (e) {
        is ApiException.Api -> ErrorTexts.code(e.code) ?: ErrorTexts.status(e.status) ?: ErrorTexts.unknown
        is ApiException.Network -> ErrorTexts.network
        is Refusal -> e.message ?: ErrorTexts.unknown
        else -> ErrorTexts.unknown
    }

    /**
     * Shows a failure as the error snackbar. Cancellation (the screen that asked went away) is passed on,
     * never shown: it is not a failure, and its text ("The coroutine scope left the composition") is not for users.
     */
    fun report(e: Throwable) {
        if (e is CancellationException) throw e
        error = describe(e)
    }

    /** runCatching for calls made from screens: cancellation propagates instead of becoming a failure (see [report]). */
    private inline fun <T> attempt(block: () -> T): Result<T> =
        try {
            Result.success(block())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            Result.failure(e)
        }

    /** A failure whose message is already the Japanese text to show (checked here, not by the server). */
    private class Refusal(message: String) : Exception(message)

    /**
     * A picked document as a request body that streams from the content provider. It can be written again
     * (a new stream each time) when the upload is retried after a token refresh.
     */
    private class ContentUriBody(
        private val resolver: ContentResolver,
        private val uri: Uri,
        private val size: Long?,
        private val fallbackType: String = "application/octet-stream",
    ) : RequestBody() {
        override fun contentType(): MediaType? = (resolver.getType(uri) ?: fallbackType).toMediaTypeOrNull()
        override fun contentLength(): Long = size ?: -1L
        override fun writeTo(sink: BufferedSink) {
            val input = resolver.openInputStream(uri) ?: throw IOException("cannot open $uri")
            input.source().use { sink.writeAll(it) }
        }
    }

    private companion object {
        const val SEARCH_PAGE = 30
        private const val LANGUAGE_DEVICE = "device"
        val NOT_CHIKUWA: String get() = L10n.str(R.string.app_controller_this_is_not_a_taylis_server)
        const val SERVER_KEY = "server"
        const val USERNAME_KEY = "username"
        /** M48: the pending Google sign-in's secret name (never an account's `server|username`). */
        const val SSO_PENDING_KEY = "sso.pending"
        // 10.0.2.2 is the host machine from the Android emulator.
        const val DEFAULT_SERVER = "http://10.0.2.2:8000"
    }
}
