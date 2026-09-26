package jp.chikuwachat.android.app

import android.app.Application
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import jp.chikuwachat.android.BuildConfig
import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.platform.RoomPersistence
import jp.chikuwachat.android.platform.SecretStore
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.OkHttpWsTransport
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.channelTitle
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
    var savedServer = DEFAULT_SERVER
        private set
    var savedUsername = ""
        private set

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val secrets = SecretStore(app)
    private val notifier = Notifier(app)
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private var api: ApiClient? = null
    private var persistence: RoomPersistence? = null
    private var foreground = false
    private var booted = false

    private fun account(server: String, username: String) = "$server|$username"

    private fun makeApi(server: String, username: String): ApiClient {
        val account = account(server, username)
        val api = ApiClient(server, http)
        api.onTokens = { tokens -> scope.launch { secrets.putSecret(account, tokens.refreshToken) } }
        api.onSignedOut = { scope.launch { handleSignedOut(account) } }
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

    suspend fun login(server: String, username: String, password: String) {
        val trimmed = server.trim().trimEnd('/')
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
            error = "サーバ URL が正しくありません"
            return
        }
        val api = makeApi(trimmed, username)
        busy = true
        try {
            val tokens = api.login(username, password, "android", Build.MODEL, BuildConfig.VERSION_NAME)
            secrets.putSetting(SERVER_KEY, trimmed)
            secrets.putSetting(USERNAME_KEY, username)
            savedServer = trimmed
            savedUsername = username
            error = null
            enterSession(api, username, tokens.user)
        } catch (e: Exception) {
            error = describe(e)
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

    private suspend fun startEngine(api: ApiClient) {
        engine?.stop()
        persistence?.close()
        val account = account(api.baseUrl, savedUsername)
        val persistence = withContext(Dispatchers.IO) { runCatching { RoomPersistence.open(app, account) }.getOrNull() }
        val store = Store(persistence)
        withContext(Dispatchers.IO) { store.load() }
        this.persistence = persistence
        this.store = store
        val engine = SyncEngine(
            api = api,
            connect = { url, _ -> OkHttpWsTransport.connect(http, url) },
            wsUrl = api.wsUrl,
            store = store,
            getAccessToken = { api.accessToken },
            scope = scope,
        )
        engine.onSignedOut = { scope.launch { handleSignedOut(account) } }
        engine.isActive = { foreground }
        engine.onNotify = { message, channel ->
            val sender = store.users[message.senderId]?.displayName ?: "?"
            val title = if (channel.channel.isDm) sender else channelTitle(channel, store) + " · " + sender
            notifier.notifyMessage(channel.id, title, message.body)
        }
        this.engine = engine
        scope.launch { engine.status.collect { engineStatus = it } }
        screen = Screen.MAIN
        scope.launch { engine.start() }
    }

    /** Foreground / background from the activity: drives push suppression and reconnects (§7.5). */
    fun setForeground(active: Boolean) {
        foreground = active
        if (active) engine?.reconnectNow()
    }

    suspend fun openChannel(channelId: String) {
        notifier.clear(channelId)
        engine?.openChannel(channelId)
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

    suspend fun members(channelId: String): Result<List<String>> = runCatching { api!!.members(channelId).map { it.userId } }

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
