package jp.chikuwachat.android.api

import jp.chikuwachat.android.sync.SyncApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder

/** Structured API errors (ARCHITECTURE.md §9). */
sealed class ApiException(message: String) : Exception(message) {
    class Api(val status: Int, val code: String, val detail: String) : ApiException("$detail ($code)") {
        val isAuth: Boolean get() = status == 401
        /** Temporary failures worth retrying; the idempotency key prevents duplicates. */
        val isRetryable: Boolean get() = status == 429 || status >= 500
    }

    class Network(cause: Throwable) : ApiException(cause.message ?: "network error")
}

fun Throwable.isRetryable(): Boolean = this is ApiException.Network || (this is ApiException.Api && isRetryable)

/** Thin HTTP client: bearer auth, single-flight refresh on token_expired, structured errors. */
class ApiClient(
    val baseUrl: String,
    private val http: OkHttpClient = OkHttpClient(),
) : SyncApi {
    @Volatile var accessToken: String? = null
    @Volatile var refreshToken: String? = null
    var onTokens: ((TokenResponse) -> Unit)? = null
    var onSignedOut: (() -> Unit)? = null
    private val refreshMutex = Mutex()

    val wsUrl: String
        get() = baseUrl.trimEnd('/').replaceFirst("http", "ws") + "/api/v1/ws"

    // --- auth -------------------------------------------------------------------------------

    suspend fun login(username: String, password: String, platform: String, deviceName: String?, appVersion: String?): TokenResponse {
        val body = buildJsonObject {
            put("username", username)
            put("password", password)
            put("device", buildJsonObject {
                put("platform", platform)
                put("device_name", deviceName?.let { JsonPrimitive(it) } ?: JsonNull)
                put("app_version", appVersion?.let { JsonPrimitive(it) } ?: JsonNull)
            })
        }
        val tokens: TokenResponse = request("POST", "/api/v1/auth/login", body, auth = false)
        apply(tokens)
        return tokens
    }

    suspend fun refresh(): TokenResponse = refreshMutex.withLock {
        val token = refreshToken ?: throw ApiException.Api(401, "missing_token", "No refresh token")
        try {
            val tokens: TokenResponse = request("POST", "/api/v1/auth/refresh", buildJsonObject { put("refresh_token", token) }, auth = false)
            apply(tokens)
            tokens
        } catch (e: ApiException.Api) {
            if (e.isAuth) signOut()
            throw e
        }
    }

    suspend fun logout() {
        runCatching { requestRaw("POST", "/api/v1/auth/logout", null, auth = true, retry401 = false) }
        signOut()
    }

    fun signOut() {
        accessToken = null
        refreshToken = null
        onSignedOut?.invoke()
    }

    private fun apply(tokens: TokenResponse) {
        accessToken = tokens.accessToken
        refreshToken = tokens.refreshToken
        onTokens?.invoke(tokens)
    }

    // --- endpoints --------------------------------------------------------------------------

    suspend fun me(): UserMe = request("GET", "/api/v1/users/me")

    suspend fun changePassword(current: String, new: String) {
        requestRaw("PUT", "/api/v1/users/me/password", buildJsonObject { put("current_password", current); put("new_password", new) }, auth = true, retry401 = true)
    }

    suspend fun users(): List<UserPublic> = request("GET", "/api/v1/users")

    override suspend fun bootstrap(): BootstrapOut = request("GET", "/api/v1/sync/bootstrap")

    suspend fun channels(includePublic: Boolean): List<ChannelOut> =
        request("GET", "/api/v1/channels" + if (includePublic) "?include=public" else "")

    override suspend fun publicChannels(): List<ChannelOut> = channels(includePublic = true).filter { it.membership == null }

    suspend fun createChannel(name: String, type: String): ChannelOut =
        request("POST", "/api/v1/channels", buildJsonObject { put("name", name); put("type", type) })

    suspend fun joinChannel(id: String): ChannelOut = request("POST", "/api/v1/channels/$id/join", buildJsonObject {})

    suspend fun members(channelId: String): List<MemberOut> = request("GET", "/api/v1/channels/$channelId/members")

    suspend fun addMember(channelId: String, userId: String): MemberOut =
        request("POST", "/api/v1/channels/$channelId/members", buildJsonObject { put("user_id", userId) })

    suspend fun createDm(userIds: List<String>): ChannelOut =
        request("POST", "/api/v1/dms", buildJsonObject { put("user_ids", buildJsonArray { userIds.forEach { add(JsonPrimitive(it)) } }) })

    /** Register (or clear, with null) this session's push token (PUSH_NOTIFICATIONS.md §3). */
    suspend fun updateDevice(pushProvider: String, pushToken: String?): DeviceOut =
        request("PUT", "/api/v1/devices/current", buildJsonObject {
            put("push_provider", pushProvider)
            put("push_token", pushToken?.let { JsonPrimitive(it) } ?: JsonNull)
        })

    override suspend fun history(channelId: String, beforeSeq: Int?, limit: Int): HistoryOut {
        val query = "limit=$limit" + (beforeSeq?.let { "&before_seq=$it" } ?: "")
        return request("GET", "/api/v1/channels/$channelId/messages?$query")
    }

    override suspend fun delta(channelId: String, sinceSeq: Int, limit: Int): DeltaOut =
        request("GET", "/api/v1/channels/$channelId/sync?since_seq=$sinceSeq&limit=$limit")

    suspend fun editMessage(messageId: String, body: String): MessageOut =
        request("PATCH", "/api/v1/messages/$messageId", buildJsonObject { put("body", body) })

    /** Returns the tombstone (deleted = true) so the caller can apply it locally. */
    suspend fun deleteMessage(messageId: String): MessageOut = request("DELETE", "/api/v1/messages/$messageId")

    suspend fun addReaction(messageId: String, emoji: String): MessageOut =
        request("PUT", "/api/v1/messages/$messageId/reactions/" + URLEncoder.encode(emoji, "UTF-8"), buildJsonObject {})

    suspend fun removeReaction(messageId: String, emoji: String): MessageOut =
        request("DELETE", "/api/v1/messages/$messageId/reactions/" + URLEncoder.encode(emoji, "UTF-8"))

    override suspend fun postMessage(channelId: String, clientMsgId: String, body: String): Pair<MessageOut, Boolean> {
        val (text, status) = requestRaw(
            "POST", "/api/v1/channels/$channelId/messages",
            buildJsonObject { put("client_msg_id", clientMsgId); put("body", body) }, auth = true, retry401 = true,
        )
        return Codec.snake.decodeFromString(MessageOut.serializer(), text) to (status == 201)
    }

    // --- transport --------------------------------------------------------------------------

    private suspend inline fun <reified T> request(method: String, path: String, body: JsonElement? = null, auth: Boolean = true): T {
        val (text, _) = requestRaw(method, path, body, auth, retry401 = true)
        return try {
            Codec.snake.decodeFromString(text)
        } catch (e: Exception) {
            throw ApiException.Api(0, "decode_error", "Unexpected response: ${e.message}")
        }
    }

    private suspend fun requestRaw(method: String, path: String, body: JsonElement?, auth: Boolean, retry401: Boolean): Pair<String, Int> {
        val builder = Request.Builder().url(baseUrl.trimEnd('/') + path).header("Accept", "application/json")
        val requestBody = body?.let { Codec.plain.encodeToString(JsonElement.serializer(), it).toRequestBody("application/json".toMediaType()) }
        builder.method(method, requestBody ?: if (method == "GET") null else "".toRequestBody(null))
        if (auth) accessToken?.let { builder.header("Authorization", "Bearer $it") }

        val (status, text) = withContext(Dispatchers.IO) {
            try {
                http.newCall(builder.build()).execute().use { response -> response.code to (response.body.string()) }
            } catch (e: IOException) {
                throw ApiException.Network(e)
            }
        }
        if (status in 200..299) return text to status

        val envelope = runCatching { Codec.plain.decodeFromString(ErrorEnvelope.serializer(), text) }.getOrNull()
        val error = ApiException.Api(status, envelope?.error?.code ?: "http_$status", envelope?.error?.message ?: "Request failed")
        if (auth && status == 401 && error.code == "token_expired" && retry401) {
            refresh()
            return requestRaw(method, path, body, auth, retry401 = false)
        }
        if (auth && status == 401 && error.code != "token_expired") signOut()
        throw error
    }
}
