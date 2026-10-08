package jp.chikuwachat.android.api

import jp.chikuwachat.android.sync.ActivityApi
import jp.chikuwachat.android.sync.CalendarApi
import jp.chikuwachat.android.sync.CalendarFeedApi
import jp.chikuwachat.android.ui.CalendarRecurrence
import jp.chikuwachat.android.ui.OccurrenceScope
import jp.chikuwachat.android.sync.TaskApi
import jp.chikuwachat.android.sync.AiApi
import jp.chikuwachat.android.sync.CanvasApi
import jp.chikuwachat.android.sync.MyCanvasesApi
import jp.chikuwachat.android.sync.WikiApi
import jp.chikuwachat.android.sync.ChannelApi
import jp.chikuwachat.android.sync.ChannelLinksApi
import jp.chikuwachat.android.sync.ReservationsApi
import jp.chikuwachat.android.sync.AttendanceApi
import jp.chikuwachat.android.sync.ActionsApi
import jp.chikuwachat.android.sync.DraftApi
import jp.chikuwachat.android.sync.SendOptions
import jp.chikuwachat.android.sync.SyncApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.net.URLEncoder as Enc

/** Structured API errors (ARCHITECTURE.md §9). */
sealed class ApiException(message: String) : Exception(message) {
    /** `details`: the error envelope's extra facts (M46: a canvas conflict carries the current canvas), when it has any. */
    class Api(val status: Int, val code: String, val detail: String, val details: JsonElement? = null) : ApiException("$detail ($code)") {
        val isAuth: Boolean get() = status == 401
        /** Temporary failures worth retrying; the idempotency key prevents duplicates. */
        val isRetryable: Boolean get() = status == 429 || status >= 500
    }

    class Network(cause: Throwable) : ApiException(cause.message ?: "network error")
}

fun Throwable.isRetryable(): Boolean = this is ApiException.Network || (this is ApiException.Api && isRetryable)

/**
 * Refused for good (4xx other than 429 and 401): sending the same request again cannot succeed. A 401 is temporary
 * (§7.2, M28c): the reconnect renews the token, or signs the workspace out; the desktop keeps the send queued and iOS
 * treats it the same, so an unsent message or read mark waits rather than being dropped or marked failed.
 */
fun Throwable.isRefusal(): Boolean = this is ApiException.Api && status in 400..499 && status != 429 && status != 401

/** Thin HTTP client: bearer auth, single-flight refresh on token_expired, structured errors. */
class ApiClient(
    val baseUrl: String,
    private val http: OkHttpClient = OkHttpClient(),
    /**
     * Wall-clock ms (a token keeps expiring while the device sleeps, unlike a monotonic clock) and a wait;
     * injectable for tests (access token expiry, refresh retries).
     */
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) : SyncApi, DraftApi, ChannelLinksApi, ReservationsApi, AttendanceApi, ActionsApi, ActivityApi, CanvasApi, MyCanvasesApi, ChannelApi, CalendarApi, CalendarFeedApi, TaskApi, AiApi, WikiApi,
    jp.chikuwachat.android.sync.WikiDbApi, jp.chikuwachat.android.sync.WikiTemplatesApi {
    @Volatile private var sessionVersion = 0
    @Volatile var accessToken: String? = null
    @Volatile var refreshToken: String? = null
    /** When the access token stops being accepted, on [clock]; 0 = unknown (a token set by hand). */
    @Volatile private var accessExpiresAt = 0L
    var onTokens: ((TokenResponse) -> Unit)? = null
    var onSignedOut: (() -> Unit)? = null
    private val refreshMutex = Mutex()

    val wsUrl: String
        get() = baseUrl.trimEnd('/').replaceFirst("http", "ws") + "/api/v1/ws"

    // --- auth -------------------------------------------------------------------------------

    /** `totpCode` (M12i) is the authenticator or recovery code once the server answered 401 totp_required. */
    suspend fun login(username: String, password: String, platform: String, deviceName: String?, appVersion: String?, totpCode: String? = null): TokenResponse {
        val body = buildJsonObject {
            put("username", username)
            put("password", password)
            put("device", device(platform, deviceName, appVersion))
            if (!totpCode.isNullOrEmpty()) put("totp_code", totpCode)
        }
        val tokens: TokenResponse = request("POST", "/api/v1/auth/login", body, auth = false)
        apply(tokens)
        return tokens
    }

    /** The `device` of a sign-in (DeviceCreate): the same for a password login, an invite and a Google sign-in. */
    private fun device(platform: String, deviceName: String?, appVersion: String?): JsonObject = buildJsonObject {
        put("platform", platform)
        put("device_name", deviceName?.let { JsonPrimitive(it) } ?: JsonNull)
        put("app_version", appVersion?.let { JsonPrimitive(it) } ?: JsonNull)
    }

    /** M48 (docs/SSO.md §3): GET /auth/methods, no sign-in. 404 on a server before M48. */
    suspend fun authMethods(): AuthMethodsOut = request("GET", "/api/v1/auth/methods", auth = false)

    /**
     * M48: the one-time ticket the browser brought back and the verifier this app made when it opened the start URL →
     * the same tokens as a login. 401 invalid_ticket (unknown, used, expired, wrong verifier) or account_disabled.
     */
    suspend fun ssoExchange(ticket: String, verifier: String, platform: String, deviceName: String?, appVersion: String?): TokenResponse {
        val body = buildJsonObject {
            put("ticket", ticket)
            put("verifier", verifier)
            put("device", device(platform, deviceName, appVersion))
        }
        val tokens: TokenResponse = request("POST", "/api/v1/auth/sso/exchange", body, auth = false)
        apply(tokens)
        return tokens
    }

    /** SYNC_PROTOCOL.md §7.2: an access token that is still good for `marginMs` needs no refresh (and no rotation). */
    fun hasFreshAccessToken(marginMs: Long = 60_000): Boolean = accessToken != null && accessExpiresAt - clock() > marginMs

    /**
     * A request that finds no access token (a restored session, a workspace in the background) gets one first. When
     * several start together only the first refreshes; the others use its token (every rotation risks the token).
     */
    private suspend fun ensureAccessToken() = refreshMutex.withLock { if (accessToken == null && refreshToken != null) rotate() }

    /**
     * Rotates the refresh token. When the answer is lost (network error, 429 / 5xx) the server may already
     * have rotated it; the old token is accepted again for 30 s (SECURITY.md §2.3), so the retry comes
     * quickly and inside that window instead of after the reconnect backoff (which would look like reuse).
     */
    suspend fun refresh(): TokenResponse = refreshMutex.withLock { rotate() }

    private suspend fun rotate(): TokenResponse {
        val version = sessionVersion
        val token = refreshToken ?: throw ApiException.Api(401, "missing_token", "No refresh token")
        val started = clock()
        var wait = REFRESH_RETRY_FIRST_MS
        while (true) {
            try {
                val tokens: TokenResponse = request("POST", "/api/v1/auth/refresh", buildJsonObject { put("refresh_token", token) }, auth = false)
                if (version != sessionVersion) throw ApiException.Api(401, "session_changed", "Session changed")
                apply(tokens)
                return tokens
            } catch (e: ApiException) {
                if (e.isRetryable() && version == sessionVersion && clock() - started + wait <= REFRESH_GRACE_MS) {
                    sleep(wait)
                    wait *= 2
                    continue
                }
                if (e is ApiException.Api && e.isAuth && version == sessionVersion) signOut()
                throw e
            }
        }
    }

    /**
     * SYNC_PROTOCOL.md §11: revokes the session on the server (an expired access token is refreshed and the
     * call sent again), then forgets the tokens either way. False when the server could not be told.
     */
    suspend fun logout(): Boolean {
        val revoked = try {
            requestRaw("POST", "/api/v1/auth/logout", null, auth = true, retry401 = true)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException.Api) {
            e.isAuth // refused as signed out: the session is gone already
        } catch (e: ApiException) {
            false
        }
        signOut()
        return revoked
    }

    fun signOut() {
        sessionVersion++
        accessToken = null
        refreshToken = null
        onSignedOut?.invoke()
    }

    private fun apply(tokens: TokenResponse) {
        accessToken = tokens.accessToken
        accessExpiresAt = clock() + tokens.expiresIn * 1000L
        refreshToken = tokens.refreshToken
        onTokens?.invoke(tokens)
    }

    // --- endpoints --------------------------------------------------------------------------

    override suspend fun me(): UserMe = request("GET", "/api/v1/users/me")

    suspend fun changePassword(current: String, new: String) {
        requestRaw("PUT", "/api/v1/users/me/password", buildJsonObject { put("current_password", current); put("new_password", new) }, auth = true, retry401 = true)
    }

    /** M40: my signed-in sessions, this one marked `current`. */
    suspend fun sessions(): List<SessionOut> = request("GET", "/api/v1/auth/sessions")

    /** 「テスト通知を送る」 (PUSH_NOTIFICATIONS.md §15): a push to every device of mine, with what happened on each. */
    suspend fun sendTestNotification(): TestNotificationOut = request("POST", "/api/v1/users/me/test-notification")

    /** M40: signs another of my sessions out (its refresh token stops working; 204). */
    suspend fun revokeSession(id: String) {
        requestRaw("DELETE", "/api/v1/auth/sessions/$id", null, auth = true, retry401 = true)
    }

    suspend fun users(): List<UserPublic> = request("GET", "/api/v1/users")

    /** M77: `activity_include` makes its `activity` badge count the canvas items too (CANVAS.md §20.3). */
    override suspend fun bootstrap(): BootstrapOut = request("GET", "/api/v1/sync/bootstrap?" + ActivityInclude.query("activity_include"))

    suspend fun channels(includePublic: Boolean): List<ChannelOut> =
        request("GET", "/api/v1/channels" + if (includePublic) "?include=public" else "")

    override suspend fun publicChannels(): List<ChannelOut> = channels(includePublic = true).filter { it.membership == null }

    /** One channel: mine (with `last_message`, M49), or any public one (a link into a channel not in the browse list, M27 preview). */
    override suspend fun channel(id: String): ChannelOut = request("GET", "/api/v1/channels/$id")

    suspend fun createChannel(name: String, type: String): ChannelOut =
        request("POST", "/api/v1/channels", buildJsonObject { put("name", name); put("type", type) })

    suspend fun joinChannel(id: String): ChannelOut = request("POST", "/api/v1/channels/$id/join", buildJsonObject {})

    /** M24: my times, made on the first call (201) and returned afterwards (200); 403 for guests. */
    suspend fun ensureTimes(): ChannelOut = request("POST", "/api/v1/times", buildJsonObject {})

    /** M11h: leaving answers 204, so nothing is decoded. */
    suspend fun leaveChannel(id: String) {
        requestRaw("POST", "/api/v1/channels/$id/leave", buildJsonObject {}, auth = true, retry401 = true)
    }

    suspend fun archiveChannel(id: String): ChannelOut = request("POST", "/api/v1/channels/$id/archive", buildJsonObject {})
    /** M13d: owner or administrator; the channel becomes writable again. */
    suspend fun unarchiveChannel(id: String): ChannelOut = request("POST", "/api/v1/channels/$id/unarchive", buildJsonObject {})

    /** `postingPolicy` (M15a) and `type` (M15b: "public" / "private") are for owners and admins. */
    suspend fun updateChannel(
        channelId: String, topic: String? = null, name: String? = null, purpose: String? = null,
        postingPolicy: String? = null, type: String? = null,
    ): ChannelOut =
        request("PATCH", "/api/v1/channels/$channelId", buildJsonObject {
            topic?.let { put("topic", it) }
            name?.let { put("name", it) }
            purpose?.let { put("purpose", it) }
            postingPolicy?.let { put("posting_policy", it) }
            type?.let { put("type", it) }
        })

    /** M35: `level` null follows the overall setting; `muted` null leaves the mute-until-unmuted as it is. */
    suspend fun setNotificationPreference(channelId: String, level: String?, mutedUntil: String?, muted: Boolean? = null): NotificationPreferenceOut =
        request("PUT", "/api/v1/channels/$channelId/notification-preference", buildJsonObject {
            put("level", level)
            put("muted_until", mutedUntil)
            muted?.let { put("muted", it) }
        })

    suspend fun updateMe(displayName: String? = null, email: String? = null): UserMe =
        request("PATCH", "/api/v1/users/me", buildJsonObject {
            displayName?.let { put("display_name", it) }
            email?.let { put("email", it) }
        })

    /** M11d: profile card fields; JsonNull clears a field, omitted fields keep their value. */
    suspend fun updateProfile(fields: JsonObject): UserMe = request("PATCH", "/api/v1/users/me", fields)

    /** M96: a new username (409 username_taken / username_reserved, 429 username_change_limited). */
    suspend fun updateUsername(username: String): UserMe =
        request("PATCH", "/api/v1/users/me", buildJsonObject { put("username", username) })

    /**
     * M23: my research topic and reading on the lab roster (404 roster_entry_not_found while I am not on it). Both are
     * always sent, null as JSON null: an omitted field keeps its value on the server, and a data class body would lose
     * its nulls to `explicitNulls = false`.
     */
    suspend fun updateMyRosterLine(researchTopic: String?, reading: String?): LabProfileOut =
        request("PATCH", "/api/v1/lab/roster/me", buildJsonObject {
            put("research_topic", researchTopic)
            put("reading", reading)
        })

    suspend fun members(channelId: String): List<MemberOut> = request("GET", "/api/v1/channels/$channelId/members")

    suspend fun addMember(channelId: String, userId: String): MemberOut =
        request("POST", "/api/v1/channels/$channelId/members", buildJsonObject { put("user_id", userId) })

    /**
     * M88 (MEMBERSHIP.md §1): several people in one action, so the channel gets one 「A が B、C を追加しました」 (at most 50;
     * those already in are answered as they are). 405 from a server before M88 (AppController.addMembers falls back).
     */
    suspend fun addMembers(channelId: String, userIds: List<String>): List<MemberOut> =
        request("POST", "/api/v1/channels/$channelId/members/batch", buildJsonObject { put("user_ids", buildJsonArray { userIds.forEach { add(JsonPrimitive(it)) } }) })

    /** L4 (M31): make a member an owner ("owner") or a member again ("member"); owners and admins. */
    suspend fun updateMemberRole(channelId: String, userId: String, role: String): MemberOut =
        request("PATCH", "/api/v1/channels/$channelId/members/$userId", buildJsonObject { put("role", role) })

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
    suspend fun message(messageId: String): MessageOut = request("GET", "/api/v1/messages/$messageId")

    suspend fun addReaction(messageId: String, emoji: String): MessageOut =
        request("PUT", "/api/v1/messages/$messageId/reactions/" + URLEncoder.encode(emoji, "UTF-8"), buildJsonObject {})

    suspend fun removeReaction(messageId: String, emoji: String): MessageOut =
        request("DELETE", "/api/v1/messages/$messageId/reactions/" + URLEncoder.encode(emoji, "UTF-8"))

    override suspend fun markRead(channelId: String, lastReadSeq: Int): ReadStateOut =
        request("PUT", "/api/v1/channels/$channelId/read", buildJsonObject { put("last_read_seq", lastReadSeq) })

    /** 「ここから未読にする」: the exact position, may move backwards (SYNC_PROTOCOL.md §10 mode=set). */
    override suspend fun setReadPosition(channelId: String, lastReadSeq: Int): ReadStateOut =
        request("PUT", "/api/v1/channels/$channelId/read", buildJsonObject { put("last_read_seq", lastReadSeq); put("mode", "set") })

    override suspend fun postMessage(
        channelId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: List<String>, options: SendOptions,
    ): Pair<MessageOut, Boolean> {
        val (text, status) = requestRaw(
            "POST", "/api/v1/channels/$channelId/messages",
            buildJsonObject {
                put("client_msg_id", clientMsgId)
                put("body", body)
                put("parent_id", parentId?.let { JsonPrimitive(it) } ?: JsonNull)
                put("attachment_ids", buildJsonArray { attachmentIds.forEach { add(JsonPrimitive(it)) } })
                if (options.alsoInChannel) put("also_in_channel", true) // M15c
                options.priority?.let { put("priority", it) } // M15e
                if (options.ackRequested) put("ack_requested", true)
            },
            auth = true, retry401 = true,
        )
        return Codec.snake.decodeFromString(MessageOut.serializer(), text) to (status == 201)
    }

    /**
     * GET /search/messages (M16b): words and / or structured filters across my channels (the server applies the
     * membership filter, SECURITY.md). `has` repeats; typed before: / after: / on: dates are read in the caller's
     * zone (DATA_MODEL.md 検索), so the offset goes along.
     */
    suspend fun searchMessages(query: SearchRequest, limit: Int = 20, offset: Int = 0): SearchOut {
        val tzOffset = java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
        val params = buildList {
            add("q=" + Enc.encode(query.q, "UTF-8"))
            query.channelId?.let { add("channel_id=" + Enc.encode(it, "UTF-8")) }
            query.fromUserId?.let { add("from_user_id=" + Enc.encode(it, "UTF-8")) }
            query.after?.let { add("after=" + Enc.encode(it, "UTF-8")) }
            query.before?.let { add("before=" + Enc.encode(it, "UTF-8")) }
            query.has.forEach { add("has=" + Enc.encode(it, "UTF-8")) }
            if (query.isThread) add("is_thread=true")
            if (query.isTimes) add("is_times=true") // L8 (TIMES_FEED.md §6)
            add("sort=" + Enc.encode(query.sort, "UTF-8"))
            add("tz_offset_minutes=$tzOffset")
            add("limit=$limit")
            add("offset=$offset")
        }.joinToString("&")
        return request("GET", "/api/v1/search/messages?$params")
    }

    /**
     * POST /attachments (multipart): the server sniffs the type and keeps it pending until a send binds it.
     * `file` may stream from disk (it is written again if the upload is retried after a token refresh).
     */
    suspend fun uploadAttachment(file: RequestBody, filename: String): AttachmentOut =
        Codec.snake.decodeFromString(AttachmentOut.serializer(), upload("/api/v1/attachments", filename, file))

    /** M14a: my profile picture (any common image; the server stores a 256px PNG). */
    suspend fun uploadAvatar(file: RequestBody): UserMe =
        Codec.snake.decodeFromString(UserMe.serializer(), upload("/api/v1/users/me/avatar", "avatar", file))

    private suspend fun upload(path: String, filename: String, file: RequestBody, retry401: Boolean = true): String {
        if (accessToken == null && refreshToken != null) ensureAccessToken()
        val part = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", filename, file).build()
        val request = Request.Builder().url(baseUrl.trimEnd('/') + path).post(part).header("Accept", "application/json")
        accessToken?.let { request.header("Authorization", "Bearer $it") }
        val (status, text) = execute(request.build())
        if (status == 401 && retry401) { refresh(); return upload(path, filename, file, retry401 = false) }
        if (status !in 200..299) throw decodeError(status, text)
        return text
    }

    suspend fun deleteAvatar(): UserMe = request("DELETE", "/api/v1/users/me/avatar")

    /** Authenticated GET returning raw bytes (thumbnails and downloads). */
    suspend fun fetchBytes(path: String): ByteArray {
        if (accessToken == null && refreshToken != null) ensureAccessToken()
        val request = Request.Builder().url(baseUrl.trimEnd('/') + path)
        accessToken?.let { request.header("Authorization", "Bearer $it") }
        return withContext(Dispatchers.IO) {
            try {
                http.newCall(request.build()).execute().use { response ->
                    if (response.code == 401) null else if (response.code !in 200..299) throw ApiException.Api(response.code, "http_${response.code}", "Download failed") else response.body.bytes()
                }
            } catch (e: IOException) {
                throw ApiException.Network(e)
            }
        } ?: run { refresh(); fetchBytes(path) }
    }

    /**
     * M82: stream a download into `target` (a video for the in-app player: it never sits in memory as a whole). Written
     * to a sibling `.part` first and moved into place only once complete, so a cut-off download is never taken for the file.
     */
    suspend fun downloadTo(path: String, target: java.io.File) {
        if (accessToken == null && refreshToken != null) ensureAccessToken()
        val request = Request.Builder().url(baseUrl.trimEnd('/') + path)
        accessToken?.let { request.header("Authorization", "Bearer $it") }
        val done = withContext(Dispatchers.IO) {
            val part = java.io.File(target.parentFile, target.name + ".part")
            try {
                http.newCall(request.build()).execute().use { response ->
                    if (response.code == 401) return@use false
                    if (response.code !in 200..299) throw ApiException.Api(response.code, "http_${response.code}", "Download failed")
                    target.parentFile?.mkdirs()
                    part.outputStream().use { out -> response.body.byteStream().copyTo(out) }
                    if (!part.renameTo(target)) { target.delete(); if (!part.renameTo(target)) throw IOException("could not save the download") }
                    true
                }
            } catch (e: IOException) {
                part.delete()
                throw ApiException.Network(e)
            }
        }
        if (!done) { refresh(); downloadTo(path, target) }
    }

    private suspend fun execute(request: Request): Pair<Int, String> = withContext(Dispatchers.IO) {
        try {
            http.newCall(request).execute().use { response -> response.code to response.body.string() }
        } catch (e: IOException) {
            throw ApiException.Network(e)
        }
    }

    private fun decodeError(status: Int, text: String): ApiException.Api {
        val envelope = runCatching { Codec.plain.decodeFromString(ErrorEnvelope.serializer(), text) }.getOrNull()
        return ApiException.Api(status, envelope?.error?.code ?: "http_$status", envelope?.error?.message ?: "Request failed", envelope?.error?.details)
    }

    suspend fun messageContext(messageId: String): List<MessageOut> = request("GET", "/api/v1/messages/$messageId/context")
    /** M14c: the bodies earlier edits replaced, oldest first (author only; 403 for others). */
    suspend fun messageRevisions(messageId: String): List<MessageRevisionOut> = request("GET", "/api/v1/messages/$messageId/revisions")

    override suspend fun replies(messageId: String): List<MessageOut> = request("GET", "/api/v1/messages/$messageId/replies")

    // --- link previews (M11g) -------------------------------------------------------------------

    suspend fun linkPreview(url: String): LinkPreviewOut = request("GET", "/api/v1/link-previews?url=" + Enc.encode(url, "UTF-8"))

    // --- reminders (M12e) -----------------------------------------------------------------------

    suspend fun createReminder(messageId: String, remindAt: String, note: String?): ReminderOut =
        request("POST", "/api/v1/messages/$messageId/reminders", buildJsonObject {
            put("remind_at", remindAt)
            if (note == null) put("note", JsonNull) else put("note", note)
        })
    override suspend fun listReminders(): List<ReminderOut> = request("GET", "/api/v1/reminders")
    /** Cancels a pending reminder or marks a fired one done. */
    suspend fun closeReminder(id: String) { requestRaw("DELETE", "/api/v1/reminders/$id", null, auth = true, retry401 = true) }

    // --- scheduled messages (M12d) --------------------------------------------------------------

    suspend fun scheduleMessage(channelId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: List<String>, sendAt: String): ScheduledOut =
        request("POST", "/api/v1/channels/$channelId/scheduled", buildJsonObject {
            put("client_msg_id", clientMsgId)
            put("body", body)
            if (parentId == null) put("parent_id", JsonNull) else put("parent_id", parentId)
            put("attachment_ids", buildJsonArray { attachmentIds.forEach { add(JsonPrimitive(it)) } })
            put("send_at", sendAt)
        })
    override suspend fun listScheduled(): List<ScheduledOut> = request("GET", "/api/v1/scheduled")
    // --- drafts (M15d) -----------------------------------------------------------------------------

    override suspend fun saveDraft(channelId: String, parentId: String?, body: String): DraftOut =
        request("PUT", "/api/v1/drafts", buildJsonObject {
            put("channel_id", channelId)
            put("parent_id", parentId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("body", body)
        })

    override suspend fun deleteDraft(channelId: String, parentId: String?) {
        val query = "channel_id=" + java.net.URLEncoder.encode(channelId, "UTF-8") +
            (parentId?.let { "&parent_id=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: "")
        requestRaw("DELETE", "/api/v1/drafts?$query", null, auth = true, retry401 = true)
    }

    suspend fun cancelScheduled(id: String) { requestRaw("DELETE", "/api/v1/scheduled/$id", null, auth = true, retry401 = true) }
    suspend fun sendScheduledNow(id: String): MessageOut = request("POST", "/api/v1/scheduled/$id/send-now", buildJsonObject {})

    // --- moderation (M104, MODERATION.md) --------------------------------------------------------

    suspend fun blockUser(userId: String): BlockStateOut = request("PUT", "/api/v1/users/$userId/block")
    suspend fun unblockUser(userId: String): BlockStateOut = request("DELETE", "/api/v1/users/$userId/block")

    /** `reason`: spam / harassment / inappropriate / child_safety / other; `note` optional. */
    suspend fun reportMessage(messageId: String, reason: String, note: String?): ReportAck =
        request("POST", "/api/v1/messages/$messageId/report", buildJsonObject {
            put("reason", reason)
            if (!note.isNullOrEmpty()) put("note", note)
        })

    /** M119 (MODERATION.md §3.1): a report without a message; `body` from Reports.body (with its `client_report_id`). */
    suspend fun submitReport(body: JsonObject): GeneralReportAck = request("POST", "/api/v1/reports", body)

    /** My password, or my username for an account without one (Google sign-in). Every session ends on success. */
    suspend fun deleteAccount(password: String?, confirmUsername: String?) {
        requestRaw("POST", "/api/v1/users/me/delete-account", buildJsonObject {
            if (password != null) put("password", password)
            if (confirmUsername != null) put("confirm_username", confirmUsername)
        }, auth = true, retry401 = true)
    }

    // --- favorites and read-all (M12a) ----------------------------------------------------------

    suspend fun favoriteChannel(channelId: String): FavoriteStateOut = request("PUT", "/api/v1/channels/$channelId/favorite")
    suspend fun unfavoriteChannel(channelId: String): FavoriteStateOut = request("DELETE", "/api/v1/channels/$channelId/favorite")
    /** M118: a DM or group DM at the top of the DM list (201 new, 200 already: it keeps its place); DELETE always 200. */
    suspend fun pinDm(channelId: String): DmPinStateOut = request("PUT", "/api/v1/channels/$channelId/dm-pin")
    suspend fun unpinDm(channelId: String): DmPinStateOut = request("DELETE", "/api/v1/channels/$channelId/dm-pin")
    /** M141 「会話を閉じる」 / opened again (SYNC_PROTOCOL.md §7.9). */
    suspend fun closeDm(channelId: String): DmCloseStateOut = request("PUT", "/api/v1/channels/$channelId/close")
    suspend fun reopenDm(channelId: String): DmCloseStateOut = request("DELETE", "/api/v1/channels/$channelId/close")
    override suspend fun readAll(scope: String?): List<ChannelReadStateOut> =
        request("POST", "/api/v1/channels/read-all", buildJsonObject { scope?.let { put("scope", it) } })

    // --- calls (M117, docs/CALLS.md §4) ---------------------------------------------------------

    /** A new meeting room posted as a message; a retry with the same `clientMsgId` gets the same call back. */
    suspend fun startCall(channelId: String, clientMsgId: String): CallOut =
        request("POST", "/api/v1/channels/$channelId/calls", buildJsonObject { put("client_msg_id", clientMsgId) })

    // --- pins and bookmarks (M11c) --------------------------------------------------------------

    suspend fun listPins(channelId: String): List<MessageOut> = request("GET", "/api/v1/channels/$channelId/pins")
    suspend fun pinMessage(messageId: String): MessageOut = request("PUT", "/api/v1/messages/$messageId/pin")
    suspend fun unpinMessage(messageId: String): MessageOut = request("DELETE", "/api/v1/messages/$messageId/pin")
    /** M11i: attached files in my channels (optionally one channel), newest first. */
    suspend fun listFiles(channelId: String? = null, query: String? = null, cursor: String? = null, limit: Int = 50): FileListOut =
        request(
            "GET",
            "/api/v1/files?limit=$limit" +
                (channelId?.let { "&channel_id=$it" } ?: "") +
                (query?.takeIf { it.isNotBlank() }?.let { "&q=" + Enc.encode(it, "UTF-8") } ?: "") +
                (cursor?.let { "&cursor=" + Enc.encode(it, "UTF-8") } ?: ""),
        )

    /** M11h: messages that mention me or everyone in my channels. */
    suspend fun listMentions(cursor: String? = null, limit: Int = 50): MentionListOut =
        request("GET", "/api/v1/mentions?limit=$limit" + (cursor?.let { "&cursor=" + Enc.encode(it, "UTF-8") } ?: ""))

    // --- activity (M39, MOBILE_UI.md §7.2) -----------------------------------------------------
    // M77 (CANVAS.md §20.5): all three calls and bootstrap name the canvas items (`include=canvas_mention`), so the
    // list and the badge count the same items. A server before M76 ignores the parameter.

    /** GET /activity: `filter` all / mentions / reactions / threads; `cursor` is the previous page's next_cursor. */
    suspend fun listActivity(filter: String = "all", cursor: String? = null, limit: Int = 50): ActivityListOut =
        request("GET", "/api/v1/activity?filter=$filter&limit=$limit&" + ActivityInclude.query("include") + (cursor?.let { "&cursor=" + Enc.encode(it, "UTF-8") } ?: ""))

    override suspend fun activitySummary(): ActivitySummaryOut = request("GET", "/api/v1/activity/summary?" + ActivityInclude.query("include"))

    /** PUT /activity/read: everything up to `readAt` is read (the server only moves it forward, never past now). */
    override suspend fun markActivityRead(readAt: String): ActivitySummaryOut =
        request("PUT", "/api/v1/activity/read?" + ActivityInclude.query("include"), buildJsonObject { put("read_at", readAt) })

    /** PUT /activity/items/read (2026-10-07, MOBILE_UI.md §6.4): I opened these items (1–100 ids); the answer is the new badge. */
    override suspend fun markActivityItemsRead(itemIds: List<String>): ActivitySummaryOut =
        request("PUT", "/api/v1/activity/items/read?" + ActivityInclude.query("include"), buildJsonObject {
            put("item_ids", kotlinx.serialization.json.JsonArray(itemIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        })

    /**
     * GET /times/feed (L8, TIMES_FEED.md §3): the timeline rows of my unmuted times, newest first; `cursor` is the
     * previous page's opaque next_cursor (null at the end).
     */
    suspend fun timesFeed(cursor: String? = null, limit: Int = 50): TimesFeedOut =
        request("GET", "/api/v1/times/feed?limit=$limit" + (cursor?.let { "&cursor=" + Enc.encode(it, "UTF-8") } ?: ""))

    suspend fun listBookmarks(cursor: String? = null, limit: Int = 50): BookmarkListOut =
        request("GET", "/api/v1/bookmarks?limit=$limit" + (cursor?.let { "&cursor=" + Enc.encode(it, "UTF-8") } ?: ""))
    suspend fun bookmarkMessage(messageId: String): BookmarkStateOut = request("PUT", "/api/v1/messages/$messageId/bookmark")
    suspend fun unbookmarkMessage(messageId: String): BookmarkStateOut = request("DELETE", "/api/v1/messages/$messageId/bookmark")

    // --- threads (THREADS.md §3) --------------------------------------------------------------

    /** GET /threads: the threads I follow, newest reply first; `cursor` is the previous page's next_cursor. */
    override suspend fun threads(filter: String, cursor: String?, limit: Int): ThreadListOut {
        val params = "filter=$filter&limit=$limit" + (cursor?.let { "&cursor=" + Enc.encode(it, "UTF-8") } ?: "")
        return request("GET", "/api/v1/threads?$params")
    }

    override suspend fun threadState(messageId: String): ThreadState = request("GET", "/api/v1/messages/$messageId/thread")

    override suspend fun markThreadRead(messageId: String, lastReadSeq: Int): ThreadState =
        request("PUT", "/api/v1/messages/$messageId/thread/read", buildJsonObject { put("last_read_seq", lastReadSeq) })

    override suspend fun setThreadFollow(messageId: String, following: Boolean): ThreadState =
        request("PUT", "/api/v1/messages/$messageId/thread/follow", buildJsonObject { put("following", following) })

    // --- two-factor authentication (M12i) ----------------------------------------------------

    suspend fun totpStatus(): TotpStatusOut = request("GET", "/api/v1/auth/totp")

    /** Needs my password; the secret and QR come back once. A wrong password is 422 invalid_password. */
    suspend fun totpSetup(password: String): TotpSetupOut = request("POST", "/api/v1/auth/totp/setup", buildJsonObject { put("password", password) })

    /** Confirms the setup with an app code; returns the recovery codes once. */
    suspend fun totpEnable(code: String): TotpEnabledOut = request("POST", "/api/v1/auth/totp/enable", buildJsonObject { put("code", code) })

    suspend fun totpDisable(password: String) {
        requestRaw("POST", "/api/v1/auth/totp/disable", buildJsonObject { put("password", password) }, auth = true, retry401 = true)
    }

    // --- sidebar sections (M14f): every call returns my whole list ------------------------------

    /**
     * M26: with its icon, and the conversations to put in it at once (they leave the section they were in). Those
     * fields go only when set: a server before M26 refuses fields it does not know.
     */
    suspend fun createSidebarSection(name: String, emoji: String? = null, channelIds: List<String> = emptyList()): List<SidebarSectionOut> =
        request("POST", "/api/v1/sidebar/sections", buildJsonObject {
            put("name", name)
            emoji?.let { put("emoji", it) }
            if (channelIds.isNotEmpty()) put("channel_ids", buildJsonArray { channelIds.forEach { add(JsonPrimitive(it)) } })
        })

    suspend fun updateSidebarSection(
        id: String, name: String? = null, position: Int? = null, collapsed: Boolean? = null,
        sort: String? = null, manualOrder: List<String>? = null,
    ): List<SidebarSectionOut> =
        request("PATCH", "/api/v1/sidebar/sections/$id", buildJsonObject {
            name?.let { put("name", it) }
            position?.let { put("position", it) }
            collapsed?.let { put("collapsed", it) }
            sort?.let { put("sort", it) }
            manualOrder?.let { ids -> put("manual_order", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }) }
        })

    /** DATA_MODEL.md 「並べ替え」: a default section's sort or hand-made order; all three come back. */
    suspend fun updateSidebarDefault(key: String, sort: String? = null, manualOrder: List<String>? = null): List<jp.chikuwachat.android.api.SidebarDefaultOut> =
        request("PATCH", "/api/v1/sidebar/defaults/$key", buildJsonObject {
            sort?.let { put("sort", it) }
            manualOrder?.let { ids -> put("manual_order", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }) }
        })

    /** M26: the name and the icon together; a null `emoji` takes the icon off. */
    suspend fun editSidebarSection(id: String, name: String, emoji: String?): List<SidebarSectionOut> =
        request("PATCH", "/api/v1/sidebar/sections/$id", buildJsonObject { put("name", name); put("emoji", emoji?.let { JsonPrimitive(it) } ?: JsonNull) })

    suspend fun deleteSidebarSection(id: String): List<SidebarSectionOut> = request("DELETE", "/api/v1/sidebar/sections/$id")

    suspend fun placeInSidebarSection(sectionId: String, channelId: String): List<SidebarSectionOut> =
        request("PUT", "/api/v1/sidebar/sections/$sectionId/channels/$channelId", buildJsonObject {})

    suspend fun removeFromSidebarSection(channelId: String): List<SidebarSectionOut> = request("DELETE", "/api/v1/sidebar/channels/$channelId")

    // --- channel links (M15f) ----------------------------------------------------------------

    override suspend fun channelLinks(channelId: String): List<ChannelLinkOut> = request("GET", "/api/v1/channels/$channelId/links")

    suspend fun addChannelLink(channelId: String, title: String, url: String): List<ChannelLinkOut> =
        request("POST", "/api/v1/channels/$channelId/links", buildJsonObject { put("title", title); put("url", url) })

    suspend fun updateChannelLink(channelId: String, linkId: String, title: String? = null, url: String? = null, position: Int? = null): List<ChannelLinkOut> =
        request("PATCH", "/api/v1/channels/$channelId/links/$linkId", buildJsonObject {
            title?.let { put("title", it) }
            url?.let { put("url", it) }
            position?.let { put("position", it) }
        })

    suspend fun deleteChannelLink(channelId: String, linkId: String): List<ChannelLinkOut> = request("DELETE", "/api/v1/channels/$channelId/links/$linkId")

    // --- reservation pools (M99, M112, docs/RESERVATIONS.md §3) ---------------------------------------------

    /** The pools I see, with today's and the coming bookings, the queue, the holders and (operators) the to-do. */
    override suspend fun reservationPools(): List<PoolOut> = request("GET", "/api/v1/reservation-pools")

    // --- 在室状況 (M140, docs/PRESENCE.md §3) ------------------------------------------------------------

    override suspend fun attendance(): AttendanceBoardOut = request("GET", "/api/v1/attendance")

    // --- 操作ボタン (M143, docs/ACTIONS.md §7.1) ---------------------------------------------------------

    override suspend fun actions(): ActionListOut = request("GET", "/api/v1/actions")

    /**
     * One press (§4): 409 actions_disabled / action_disabled / action_invoke_id_reused, 404 action_not_found, 403
     * action_not_allowed, 429 rate_limited. Never retried here (a 401 renews the token once, as every call).
     */
    override suspend fun invokeAction(actionId: String, clientInvokeId: String): ActionInvokeOut =
        request("POST", "/api/v1/actions/$actionId/invoke", buildJsonObject { put("client_invoke_id", clientInvokeId) })

    /** M143 §12.3: the state of what the buttons operate; `refresh` skips the server's cache (429 rate_limited). */
    override suspend fun actionStatuses(refresh: Boolean): ActionStatusListOut =
        request("GET", "/api/v1/actions/status" + if (refresh) "?refresh=true" else "")

    /** My state (a workspace state or one of mine) and note (null = none); 422 attendance_state_invalid. */
    suspend fun setMyAttendance(stateId: String, note: String?): AttendanceEntryOut =
        request("PUT", "/api/v1/attendance/me", buildJsonObject {
            put("state_id", stateId)
            put("note", note?.let { JsonPrimitive(it) } ?: JsonNull)
        })

    /** One of my own states (403 attendance_personal_not_allowed, 409 attendance_label_taken / attendance_state_limit). */
    suspend fun createMyAttendanceState(label: String, icon: String?, emoji: String?, color: String, kind: String): AttendanceStateOut =
        request("POST", "/api/v1/attendance/my-states", attendanceStateBody(label, icon, emoji, color, kind))

    suspend fun updateMyAttendanceState(id: String, label: String, icon: String?, emoji: String?, color: String, kind: String): AttendanceStateOut =
        request("PATCH", "/api/v1/attendance/my-states/$id", attendanceStateBody(label, icon, emoji, color, kind))

    /** Archives it (204); whoever has it keeps it. */
    suspend fun deleteMyAttendanceState(id: String) { requestRaw("DELETE", "/api/v1/attendance/my-states/$id", null, auth = true, retry401 = true) }

    /** `icon: null` / `emoji: null` remove the icon / emoji on a PATCH. */
    private fun attendanceStateBody(label: String, icon: String?, emoji: String?, color: String, kind: String) = buildJsonObject {
        put("label", label)
        put("icon", icon?.let { JsonPrimitive(it) } ?: JsonNull)
        put("emoji", emoji?.let { JsonPrimitive(it) } ?: JsonNull)
        put("color", color)
        put("kind", kind)
    }

    /** A booking: on the hour, 1 h to the pool's max_hours, up to 14 days ahead (409 reservation_slot_full …). */
    suspend fun bookReservation(poolId: String, startAt: String, hours: Int): PoolOut =
        request("POST", "/api/v1/reservation-pools/$poolId/bookings", buildJsonObject { put("start_at", startAt); put("hours", hours) })

    /** 「延長」: a booking grows by `hours` if they have a seat. */
    suspend fun extendReservation(reservationId: String, hours: Int = 1): PoolOut =
        request("POST", "/api/v1/reservations/$reservationId/extend", buildJsonObject { put("hours", hours) })

    /** 「今すぐ (順番待ち)」: join the walk-in queue (pressing again changes nothing). */
    suspend fun reserve(poolId: String): PoolOut = request("POST", "/api/v1/reservation-pools/$poolId/reserve", buildJsonObject {})

    /** cancel (取り消す) / return (返却する) / assign (割り当てた) / remove (外した). */
    suspend fun reservationAction(reservationId: String, action: String): PoolOut =
        request("POST", "/api/v1/reservations/$reservationId/$action", buildJsonObject {})

    /** 「入れ替えた」 (operators): `removeId` out, `assignId` in. */
    suspend fun swapReservations(poolId: String, removeId: String, assignId: String): PoolOut =
        request("POST", "/api/v1/reservation-pools/$poolId/swap", buildJsonObject { put("remove_id", removeId); put("assign_id", assignId) })

    // --- workflows (M95, WORKFLOWS.md §4; phones only run them) ------------------------------------------

    /** The workflows this channel offers whose target I can read (the menu and `/`), by name; stopped ones too. */
    suspend fun channelWorkflows(channelId: String): List<WorkflowOut> = request("GET", "/api/v1/channels/$channelId/workflows")

    /** One workflow (the 「⚡ name」 label); 404 workflow_not_found when it is gone or its target is not mine to read. */
    suspend fun workflow(id: String): WorkflowOut = request("GET", "/api/v1/workflows/$id")

    /** `body`: WorkflowSession.body (`client_msg_id` and the values). 201 new, 200 the same message for a retry. */
    suspend fun submitWorkflow(id: String, body: JsonObject): MessageOut = request("POST", "/api/v1/workflows/$id/submit", body)

    // --- recurring posts (L6, M59/M60, RECURRING.md §3) ----------------------------------------------

    /** Any reader of the channel; 404 on a server before M59. */
    suspend fun recurringPosts(channelId: String): List<RecurringPostOut> = request("GET", "/api/v1/channels/$channelId/recurring-posts")

    /** `body`: ui/Recurring.createBody (owners and admins who are members; 403 recurring_manage_restricted otherwise). */
    suspend fun createRecurringPost(channelId: String, body: JsonObject): RecurringPostOut = request("POST", "/api/v1/channels/$channelId/recurring-posts", body)

    /** `body`: ui/Recurring.updateBody, or just `enabled` (止める / 再開). */
    suspend fun updateRecurringPost(id: String, body: JsonObject): RecurringPostOut = request("PATCH", "/api/v1/recurring-posts/$id", body)

    /** 204; the posts made so far (and their collections) stay. */
    suspend fun deleteRecurringPost(id: String) { requestRaw("DELETE", "/api/v1/recurring-posts/$id", null, auth = true, retry401 = true) }

    /** 今すぐ投稿 (the next scheduled time stays). */
    suspend fun runRecurringPost(id: String): RecurringRunOut = request("POST", "/api/v1/recurring-posts/$id/run", buildJsonObject {})

    // --- canvases (CANVAS.md §4.5, M46) ---------------------------------------------------------

    /** The conversation's canvases without bodies, most recently updated first (`trashed`: its trash instead). */
    override suspend fun listCanvases(channelId: String, trashed: Boolean): List<CanvasMeta> =
        request("GET", "/api/v1/channels/$channelId/canvases" + if (trashed) "?trashed=true" else "")

    /** M78 (CANVAS.md §21): the canvases of all my conversations, most recently updated first, a page at a time. */
    override suspend fun myCanvases(cursor: String?, limit: Int): CanvasPage =
        request("GET", "/api/v1/canvases?limit=$limit" + (cursor?.let { "&cursor=" + URLEncoder.encode(it, "UTF-8") } ?: ""))

    /** A new canvas (a retry with the same client_save_id returns the first one). The server fills a template in `tz`. */
    override suspend fun createCanvas(channelId: String, clientSaveId: String, templateKey: String?, title: String?, asTab: Boolean, tz: String?): CanvasOut =
        request("POST", "/api/v1/channels/$channelId/canvases", buildJsonObject {
            put("client_save_id", clientSaveId)
            put("as_tab", asTab)
            put("share_to_channel", false) // M42: posting it to the conversation is its own action
            tz?.let { put("tz", it) }
            templateKey?.let { put("template_key", it) }
            title?.let { put("title", it) }
        })

    /** Metadata and body; null when `knownVersion` is still the current one (If-None-Match → 304). */
    override suspend fun getCanvas(canvasId: String, knownVersion: Long?): CanvasOut? {
        val headers = if (knownVersion == null) emptyMap() else mapOf("If-None-Match" to "\"v$knownVersion\"")
        val (text, status) = requestRaw("GET", "/api/v1/canvases/$canvasId", null, auth = true, retry401 = true, headers = headers)
        if (status == 304) return null
        return try {
            Codec.snake.decodeFromString(CanvasOut.serializer(), text)
        } catch (e: Exception) {
            throw ApiException.Api(0, "decode_error", "Unexpected response: ${e.message}")
        }
    }

    /** §4.4: the whole body written on `baseRevId`; 409 canvas_conflict / canvas_base_expired carry the head in `details`. */
    override suspend fun saveCanvas(canvasId: String, baseRevId: String, body: String, clientSaveId: String, onConflict: String): CanvasSaveOut =
        request("PUT", "/api/v1/canvases/$canvasId/content", buildJsonObject {
            put("base_rev_id", baseRevId)
            put("body", body)
            put("client_save_id", clientSaveId)
            put("on_conflict", onConflict)
        })

    /** Title, who edits (`editPolicy` "members" | "owners"), the conversation's tab. */
    override suspend fun updateCanvas(canvasId: String, title: String?, editPolicy: String?, isChannelTab: Boolean?): CanvasOut =
        request("PATCH", "/api/v1/canvases/$canvasId", buildJsonObject {
            title?.let { put("title", it) }
            editPolicy?.let { put("edit_policy", it) }
            isChannelTab?.let { put("is_channel_tab", it) }
        })

    /** To the trash (204). */
    override suspend fun deleteCanvas(canvasId: String) {
        requestRaw("DELETE", "/api/v1/canvases/$canvasId", null, auth = true, retry401 = true)
    }

    override suspend fun restoreCanvas(canvasId: String): CanvasOut = request("POST", "/api/v1/canvases/$canvasId/restore", buildJsonObject {})

    override suspend fun canvasTemplates(): List<CanvasTemplateOut> = request("GET", "/api/v1/canvas-templates")

    /** The history, newest first (no side versions, no bodies). */
    suspend fun canvasRevisions(canvasId: String, cursor: String? = null): CanvasRevisionPage =
        request("GET", "/api/v1/canvases/$canvasId/revisions" + (cursor?.let { "?cursor=" + URLEncoder.encode(it, "UTF-8") } ?: ""))

    suspend fun canvasRevision(canvasId: String, revisionId: String): CanvasRevisionOut = request("GET", "/api/v1/canvases/$canvasId/revisions/$revisionId")

    /**
     * M58 (§4.9): that version's body as a new version. `clientSaveId` is one per restore: a retry after a lost answer
     * returns the same canvas, never a second version.
     */
    suspend fun restoreCanvasRevision(canvasId: String, revisionId: String, clientSaveId: String): CanvasOut =
        request("POST", "/api/v1/canvases/$canvasId/revisions/$revisionId/restore", buildJsonObject { put("client_save_id", clientSaveId) })

    /** M58: a version's name (「提出版」); null takes it off (sent as `"label": null`). */
    suspend fun labelCanvasRevision(canvasId: String, revisionId: String, label: String?): CanvasRevisionMeta =
        request("PATCH", "/api/v1/canvases/$canvasId/revisions/$revisionId", buildJsonObject { put("label", label?.let { JsonPrimitive(it) } ?: JsonNull) })

    /** M58: a version's body erased (§4.7: owners and administrators, in a DM its creator; the server audits it). */
    suspend fun eraseCanvasRevision(canvasId: String, revisionId: String): CanvasRevisionMeta =
        request("DELETE", "/api/v1/canvases/$canvasId/revisions/$revisionId")

    /** M58 (§4.13): the canvas's link posted to its conversation (nothing new while that message exists). */
    suspend fun shareCanvas(canvasId: String): CanvasOut = request("POST", "/api/v1/canvases/$canvasId/share", buildJsonObject {})

    /** M58 (§4.8): canvases of my conversations whose title or body matches. */
    suspend fun searchCanvases(query: CanvasSearchRequest, limit: Int = 20, offset: Int = 0): CanvasSearchOut {
        val tzOffset = java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
        val params = buildList {
            add("q=" + Enc.encode(query.q, "UTF-8"))
            query.channelId?.let { add("channel_id=" + Enc.encode(it, "UTF-8")) }
            query.fromUserId?.let { add("from_user_id=" + Enc.encode(it, "UTF-8")) }
            query.after?.let { add("after=" + Enc.encode(it, "UTF-8")) }
            query.before?.let { add("before=" + Enc.encode(it, "UTF-8")) }
            add("sort=" + Enc.encode(query.sort, "UTF-8"))
            add("tz_offset_minutes=$tzOffset")
            add("limit=$limit")
            add("offset=$offset")
        }.joinToString("&")
        return request("GET", "/api/v1/search/canvases?$params")
    }

    // --- 「ドキュメント」 (docs/WIKI.md §14.2, M122) -------------------------------------------------------

    override suspend fun wikiTree(etag: String?): Pair<WikiTreeOut?, String?> {
        val tag = arrayOfNulls<String>(1)
        val headers = if (etag == null) emptyMap() else mapOf("If-None-Match" to etag)
        val (text, status) = requestRaw("GET", "/api/v1/wiki/tree", null, auth = true, retry401 = true, headers = headers, etagOut = tag)
        if (status == 304) return null to etag
        return decodeOrThrow(WikiTreeOut.serializer(), text) to tag[0]
    }

    override suspend fun wikiChanges(since: Long): WikiChangesOut = request("GET", "/api/v1/wiki/changes?since=$since")

    override suspend fun wikiPage(pageId: String, etag: String?): PageOut? {
        val headers = if (etag == null) emptyMap() else mapOf("If-None-Match" to etag)
        val (text, status) = requestRaw("GET", "/api/v1/wiki/pages/$pageId", null, auth = true, retry401 = true, headers = headers)
        if (status == 304) return null
        return decodeOrThrow(PageOut.serializer(), text)
    }

    /** CANVAS.md §4.4 on a page: 409 page_conflict / page_base_expired carry the head (PageContent) in `details`. */
    override suspend fun saveWikiPage(pageId: String, baseRevId: String, body: String, clientSaveId: String, onConflict: String): PageSaveOut =
        request("PUT", "/api/v1/wiki/pages/$pageId/content", buildJsonObject {
            put("base_rev_id", baseRevId)
            put("body", body)
            put("client_save_id", clientSaveId)
            put("on_conflict", onConflict)
        })

    /** A new page (201; a retry with the same key answers the first one, 200). `access` matters for a top-level page only. */
    override suspend fun createWikiPage(
        parentId: String?, title: String?, access: String, tz: String?, clientSaveId: String,
        template: jp.chikuwachat.android.sync.PageTemplateChoice?,
    ): PageOut = request("POST", "/api/v1/wiki/pages", jp.chikuwachat.android.sync.WikiRequests.createPage(parentId, title, access, tz, clientSaveId, template))

    // --- templates and duplicating (docs/WIKI.md §24, M146) ----------------------------------------------

    override suspend fun wikiTemplates(): jp.chikuwachat.android.api.WikiTemplatesOut = request("GET", "/api/v1/wiki/templates")

    override suspend fun applyWikiTemplate(pageId: String, template: jp.chikuwachat.android.sync.PageTemplateChoice, tz: String?, clientSaveId: String): PageOut =
        request("POST", "/api/v1/wiki/pages/$pageId/apply-template", jp.chikuwachat.android.sync.WikiRequests.applyTemplate(template, tz, clientSaveId))

    override suspend fun duplicateWikiPage(pageId: String, topLevel: Boolean, clientSaveId: String): jp.chikuwachat.android.api.PageDuplicateOut =
        request("POST", "/api/v1/wiki/pages/$pageId/duplicate", jp.chikuwachat.android.sync.WikiRequests.duplicate(topLevel, clientSaveId))

    override suspend fun renameWikiPage(pageId: String, title: String): PageOut =
        request("PATCH", "/api/v1/wiki/pages/$pageId", buildJsonObject { put("title", title) })

    override suspend fun resolveWikiPages(ids: List<String>): List<PageRef> =
        request("POST", "/api/v1/wiki/pages/resolve", buildJsonObject { put("ids", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }) })

    override suspend fun wikiBacklinks(pageId: String): List<PageItem> = request("GET", "/api/v1/wiki/pages/$pageId/backlinks")

    override suspend fun searchPages(q: String, limit: Int, offset: Int): PageSearchOut {
        val tzOffset = java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
        return request("GET", "/api/v1/search/pages?q=" + Enc.encode(q, "UTF-8") + "&tz_offset_minutes=$tzOffset&limit=$limit&offset=$offset")
    }

    // --- databases (docs/WIKI.md §18.2, M124) ---------------------------------------------------------

    override suspend fun wikiDatabase(databaseId: String): DatabaseOut = request("GET", "/api/v1/wiki/databases/$databaseId")

    override suspend fun queryRows(
        databaseId: String, viewId: String?, range: jp.chikuwachat.android.sync.DbRange?, cursor: String?, limit: Int,
        options: jp.chikuwachat.android.sync.DbQueryOptions,
    ): DbRowQueryOut = request("POST", "/api/v1/wiki/databases/$databaseId/query", jp.chikuwachat.android.sync.WikiDbViews.queryBody(viewId, range, cursor, limit, options))

    /** A new row (201; a retry with the same key answers the first one, 200). */
    override suspend fun createRow(
        databaseId: String, title: String, props: JsonObject, clientSaveId: String,
        template: jp.chikuwachat.android.sync.RowTemplateChoice, tz: String?,
    ): DbRowWithRefs = request("POST", "/api/v1/wiki/databases/$databaseId/rows", jp.chikuwachat.android.sync.WikiRequests.createRow(title, props, clientSaveId, template, tz))

    override suspend fun wikiRow(rowId: String): DbRowDetail = request("GET", "/api/v1/wiki/rows/$rowId")

    /** Cells replaced (the last write wins per cell); the same `client_op_id` again changes nothing. */
    override suspend fun setRowProps(rowId: String, set: JsonObject, clientOpId: String): DbRowWithRefs =
        request("PATCH", "/api/v1/wiki/rows/$rowId/props", buildJsonObject {
            put("set", set)
            put("client_op_id", clientOpId)
        })

    /** M148: a board card to another group (edit); the same `client_op_id` again changes no cell. */
    override suspend fun moveRow(rowId: String, set: JsonObject, clientOpId: String): DbRowWithRefs =
        request("POST", "/api/v1/wiki/rows/$rowId/move", jp.chikuwachat.android.sync.WikiDbViews.moveBody(set, clientOpId))

    override suspend fun relationCandidates(databaseId: String, propId: String, q: String): List<DbRowRef> =
        request("GET", "/api/v1/wiki/databases/$databaseId/properties/$propId/candidates?q=" + Enc.encode(q, "UTF-8") + "&limit=30")

    private fun <T> decodeOrThrow(serializer: kotlinx.serialization.KSerializer<T>, text: String): T = try {
        Codec.snake.decodeFromString(serializer, text)
    } catch (e: Exception) {
        throw ApiException.Api(0, "decode_error", "Unexpected response: ${e.message}")
    }

    /** An attachment's metadata (a canvas image knows only its id). */
    suspend fun attachment(attachmentId: String): AttachmentOut = request("GET", "/api/v1/attachments/$attachmentId")

    // --- the calendar (CALENDAR.md §4, M52) -----------------------------------------------------

    override suspend fun calendarEvents(from: String, to: String, channelId: String?): List<CalendarEventOut> =
        request("GET", "/api/v1/calendar/events?from=" + Enc.encode(from, "UTF-8") + "&to=" + Enc.encode(to, "UTF-8") + (channelId?.let { "&channel_id=$it" } ?: ""))

    override suspend fun calendarUpcoming(channelId: String?, days: Int, tz: String): List<CalendarEventOut> =
        request("GET", "/api/v1/calendar/upcoming?days=$days&tz=" + Enc.encode(tz, "UTF-8") + (channelId?.let { "&channel_id=$it" } ?: ""))

    override suspend fun calendarEvent(eventId: String): CalendarEventOut = request("GET", "/api/v1/calendar/events/$eventId")

    override suspend fun createCalendarEvent(body: CalendarEventCreate): CalendarEventOut =
        request("POST", "/api/v1/calendar/events", Codec.snake.encodeToJsonElement(CalendarEventCreate.serializer(), body))

    override suspend fun updateCalendarEvent(eventId: String, patch: CalendarEventUpdate): CalendarEventOut =
        request("PATCH", "/api/v1/calendar/events/$eventId", patch.toJson())

    override suspend fun deleteCalendarEvent(eventId: String) {
        requestRaw("DELETE", "/api/v1/calendar/events/$eventId", null, auth = true, retry401 = true)
    }

    override suspend fun setCalendarAlarm(eventId: String, minutesBefore: Int, tz: String): CalendarEventOut =
        request("PUT", "/api/v1/calendar/events/$eventId/alarm", buildJsonObject { put("minutes_before", minutesBefore); put("tz", tz) })

    override suspend fun clearCalendarAlarm(eventId: String) {
        requestRaw("DELETE", "/api/v1/calendar/events/$eventId/alarm", null, auth = true, retry401 = true)
    }

    // --- recurring events and iCal feeds (CALENDAR.md §10, M69) -----------------------------------

    override suspend fun updateCalendarOccurrence(seriesId: String, occurrenceStart: String, body: JsonObject): CalendarEventOut =
        request("PATCH", CalendarRecurrence.occurrencePath(seriesId, occurrenceStart), body)

    override suspend fun deleteCalendarOccurrence(seriesId: String, occurrenceStart: String, scope: OccurrenceScope) {
        requestRaw("DELETE", CalendarRecurrence.occurrencePath(seriesId, occurrenceStart, scope), null, auth = true, retry401 = true)
    }

    override suspend fun calendarFeeds(): List<CalendarFeedOut> = request("GET", "/api/v1/calendar/ical-feeds")

    override suspend fun createCalendarFeed(scope: String): CalendarFeedCreated =
        request("POST", "/api/v1/calendar/ical-feeds", buildJsonObject { put("scope", scope) })

    override suspend fun deleteCalendarFeed(feedId: String) {
        requestRaw("DELETE", "/api/v1/calendar/ical-feeds/$feedId", null, auth = true, retry401 = true)
    }

    // --- tasks (TASKS.md §3, M56) ---------------------------------------------------------------

    override suspend fun listTasks(channelId: String, includeDone: String): List<TaskOut> =
        request("GET", "/api/v1/tasks?channel_id=$channelId&include_done=" + Enc.encode(includeDone, "UTF-8"))

    override suspend fun myTasks(): List<TaskOut> = request("GET", "/api/v1/tasks/mine")

    override suspend fun requestedTasks(): List<TaskOut> = request("GET", "/api/v1/tasks/requested")

    override suspend fun dueTasks(from: String, to: String): List<TaskOut> =
        request("GET", "/api/v1/tasks/due?from=" + Enc.encode(from, "UTF-8") + "&to=" + Enc.encode(to, "UTF-8"))

    override suspend fun getTask(taskId: String): TaskOut = request("GET", "/api/v1/tasks/$taskId")

    override suspend fun createTask(body: TaskCreate): TaskOut =
        request("POST", "/api/v1/tasks", Codec.snake.encodeToJsonElement(TaskCreate.serializer(), body))

    override suspend fun updateTask(taskId: String, patch: TaskUpdate): TaskOut = request("PATCH", "/api/v1/tasks/$taskId", patch.toJson())

    override suspend fun moveTask(taskId: String, status: String, neighbors: TaskNeighbors): TaskOut =
        request("POST", "/api/v1/tasks/$taskId/move", taskMoveJson(status, neighbors))

    override suspend fun deleteTask(taskId: String) {
        requestRaw("DELETE", "/api/v1/tasks/$taskId", null, auth = true, retry401 = true)
    }

    // --- M84: columns and checklist items (TASKS.md §11.3) ---

    override suspend fun moveTaskToColumn(taskId: String, columnId: String, neighbors: TaskNeighbors): TaskOut =
        request("POST", "/api/v1/tasks/$taskId/move", taskColumnMoveJson(columnId, neighbors))

    override suspend fun updateSubtask(taskId: String, subtaskId: String, done: Boolean): TaskOut =
        request("PATCH", "/api/v1/tasks/$taskId/subtasks/$subtaskId", buildJsonObject { put("done", JsonPrimitive(done)) })

    /** A server before M81 answers 404 / 422 (the route read as /tasks/{task_id}): the hub reads that as no columns. */
    override suspend fun listTaskColumns(channelId: String): List<TaskColumnOut> =
        request("GET", "/api/v1/tasks/columns?channel_id=" + Enc.encode(channelId, "UTF-8"))

    override suspend fun createTaskColumn(channelId: String, name: String, status: String, afterId: String?): TaskColumnOut =
        request("POST", "/api/v1/tasks/columns", taskColumnCreateJson(channelId, name, status, afterId))

    override suspend fun updateTaskColumn(columnId: String, name: String?, move: Boolean, afterId: String?): TaskColumnOut =
        request("PATCH", "/api/v1/tasks/columns/$columnId", taskColumnUpdateJson(name, move, afterId))

    override suspend fun deleteTaskColumn(columnId: String) {
        requestRaw("DELETE", "/api/v1/tasks/columns/$columnId", null, auth = true, retry401 = true)
    }

    /** M86: a server before M85 answers 422 (the route read as /tasks/{task_id}) or 404: the hub reads that as unsupported. */
    override suspend fun deadlineTasks(): List<TaskOut> = request("GET", "/api/v1/tasks/deadlines")

    // --- AI (docs/AI.md §5, M66) -----------------------------------------------------------------

    override suspend fun aiStatus(): AiStatusOut = request("GET", "/api/v1/ai/status")

    override suspend fun createSummary(body: AiSummaryIn): AiRunOut =
        request("POST", "/api/v1/ai/summaries", Codec.snake.encodeToJsonElement(AiSummaryIn.serializer(), body))

    override suspend fun aiRun(runId: String): AiRunOut = request("GET", "/api/v1/ai/runs/$runId")

    override suspend fun summaryTarget(channelId: String): AiSummaryTargetOut =
        request("GET", "/api/v1/ai/summaries/target?channel_id=$channelId")

    // M70 「AI に聞く」 (docs/AI.md §13.5)
    override suspend fun createAsk(body: AiAskIn): AiRunOut =
        request("POST", "/api/v1/ai/ask", Codec.snake.encodeToJsonElement(AiAskIn.serializer(), body))

    override suspend fun askTarget(q: String, channelId: String?): AiAskTargetOut =
        request("GET", "/api/v1/ai/ask/target?q=" + Enc.encode(q, "UTF-8").replace("+", "%20") + (channelId?.let { "&channel_id=" + Enc.encode(it, "UTF-8") } ?: ""))

    override suspend fun aiRuns(kind: String): List<AiRunOut> = request("GET", "/api/v1/ai/runs?kind=" + Enc.encode(kind, "UTF-8"))

    // --- acknowledgements (M15e) ----------------------------------------------------------------

    suspend fun acknowledge(messageId: String, present: Boolean): MessageOut =
        if (present) request("PUT", "/api/v1/messages/$messageId/ack", buildJsonObject {})
        else request("DELETE", "/api/v1/messages/$messageId/ack")

    /** L4 (M31): who has not acknowledged yet (any member may look). */
    suspend fun ackPending(messageId: String): AckPendingOut = request("GET", "/api/v1/messages/$messageId/ack/pending")

    /** L4 (M31): the author or an admin reminds them (once an hour per message). */
    suspend fun remindAck(messageId: String): AckRemindOut = request("POST", "/api/v1/messages/$messageId/ack/remind", buildJsonObject {})

    // --- polls (M14b) ------------------------------------------------------------------------

    suspend fun vote(messageId: String, option: Int, present: Boolean): MessageOut =
        if (present) request("PUT", "/api/v1/messages/$messageId/poll/votes/$option", buildJsonObject {})
        else request("DELETE", "/api/v1/messages/$messageId/poll/votes/$option")

    suspend fun closePoll(messageId: String): MessageOut = request("POST", "/api/v1/messages/$messageId/poll/close", buildJsonObject {})

    /**
     * A message that carries a poll; posted directly (not through the offline queue). `anonymous` (M27) is sent only when
     * set: a server before M27 refuses unknown poll fields (422), and a named poll must still go through there.
     */
    suspend fun postPoll(channelId: String, parentId: String?, question: String, options: List<String>, multiple: Boolean, anonymous: Boolean = false): MessageOut =
        request("POST", "/api/v1/channels/$channelId/messages", buildJsonObject {
            put("client_msg_id", java.util.UUID.randomUUID().toString())
            put("body", "")
            put("parent_id", parentId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("poll", buildJsonObject {
                put("question", question)
                put("options", buildJsonArray { options.forEach { add(JsonPrimitive(it)) } })
                put("multiple", multiple)
                if (anonymous) put("anonymous", true)
            })
        })

    // --- scheduling polls (M53, SCHEDULING.md §3) ----------------------------------------------

    /**
     * A scheduling poll (日程調整): the candidates as UTC instants or dates, and the zone the server writes their labels in
     * (the device's). The server makes the options and always takes several answers; `anonymous` goes only when set.
     */
    suspend fun postSchedulePoll(channelId: String, parentId: String?, question: String, slots: List<ScheduleSlotIn>, tz: String, anonymous: Boolean = false): MessageOut =
        request("POST", "/api/v1/channels/$channelId/messages", buildJsonObject {
            put("client_msg_id", java.util.UUID.randomUUID().toString())
            put("body", "")
            put("parent_id", parentId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("poll", buildJsonObject {
                put("kind", "schedule")
                put("question", question)
                put("slots", buildJsonArray { slots.forEach { add(Codec.snake.encodeToJsonElement(ScheduleSlotIn.serializer(), it)) } })
                put("tz", tz)
                if (anonymous) put("anonymous", true)
            })
        })

    /**
     * PUT /messages/{id}/poll/answers: my ○ △ × for every candidate at once (those left out become unanswered).
     * `comment`: [CommentChange.Keep] leaves it out (mine stays), [CommentChange.Set] sends it (blank or null removes it).
     */
    suspend fun answerPoll(messageId: String, answers: List<PollAnswerIn>, comment: CommentChange = CommentChange.Keep): MessageOut =
        request("PUT", "/api/v1/messages/$messageId/poll/answers", buildJsonObject {
            put("answers", buildJsonArray { answers.forEach { add(buildJsonObject { put("index", it.index); put("answer", it.answer) }) } })
            if (comment is CommentChange.Set) put("comment", comment.text?.let { JsonPrimitive(it) } ?: JsonNull)
        })

    /** POST /messages/{id}/poll/decide: the author, the channel's owners and administrators; `createEvent` false makes none. */
    suspend fun decidePoll(messageId: String, index: Int, createEvent: Boolean = true): MessageOut =
        request("POST", "/api/v1/messages/$messageId/poll/decide", buildJsonObject { put("index", index); put("create_event", createEvent) })

    /** DELETE /messages/{id}/poll/decide: answering reopens (the event stays). */
    suspend fun undecidePoll(messageId: String): MessageOut = request("DELETE", "/api/v1/messages/$messageId/poll/decide")

    // --- workspaces (M16c) -------------------------------------------------------------------

    /** GET /server, no sign-in: which workspace this URL is (WORKSPACES.md §3.1). */
    suspend fun serverInfo(): ServerInfoOut = request("GET", "/api/v1/server", auth = false)

    /** GET /server/icon (M93, no sign-in, WORKSPACES.md §3.4): the workspace icon's PNG of `version` (no Authorization header). */
    suspend fun serverIcon(version: String): ByteArray {
        val request = Request.Builder().url(baseUrl.trimEnd('/') + serverIconPath(version)).build()
        return withContext(Dispatchers.IO) {
            try {
                http.newCall(request).execute().use { response ->
                    if (response.code !in 200..299) throw ApiException.Api(response.code, "http_${response.code}", "Download failed")
                    response.body.bytes()
                }
            } catch (e: IOException) {
                throw ApiException.Network(e)
            }
        }
    }

    /** GET /sync/summary: the switcher's marks for a workspace that is not open (WORKSPACES.md §3.2). */
    suspend fun syncSummary(): UnreadSummaryOut = request("GET", "/api/v1/sync/summary")

    // --- invite links (M12h) ------------------------------------------------------------------

    /** No login: what the link offers. 404 = unknown, 410 = expired / used up / revoked. */
    suspend fun invitePreview(token: String): InvitePreviewOut = request("GET", "/api/v1/invites/$token", auth = false)

    /** Creates the account and logs it in (the response is the same as a login). */
    suspend fun acceptInvite(token: String, username: String, displayName: String, password: String, platform: String, deviceName: String?, appVersion: String?): TokenResponse {
        val body = buildJsonObject {
            put("username", username)
            put("display_name", displayName)
            put("password", password)
            put("device", device(platform, deviceName, appVersion))
        }
        val tokens: TokenResponse = request("POST", "/api/v1/invites/$token/accept", body, auth = false)
        apply(tokens)
        return tokens
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

    private suspend fun requestRaw(
        method: String, path: String, body: JsonElement?, auth: Boolean, retry401: Boolean, headers: Map<String, String> = emptyMap(),
        /** M122: the answer's ETag lands here (GET /wiki/tree). */
        etagOut: Array<String?>? = null,
    ): Pair<String, Int> {
        if (auth && accessToken == null && refreshToken != null) ensureAccessToken()
        val builder = Request.Builder().url(baseUrl.trimEnd('/') + path).header("Accept", "application/json")
        headers.forEach { (name, value) -> builder.header(name, value) }
        val requestBody = body?.let { Codec.plain.encodeToString(JsonElement.serializer(), it).toRequestBody("application/json".toMediaType()) }
        builder.method(method, requestBody ?: if (method == "GET") null else "".toRequestBody(null))
        if (auth) accessToken?.let { builder.header("Authorization", "Bearer $it") }

        val (status, text) = withContext(Dispatchers.IO) {
            try {
                http.newCall(builder.build()).execute().use { response ->
                    if (etagOut != null) etagOut[0] = response.header("ETag")
                    response.code to (response.body.string())
                }
            } catch (e: IOException) {
                throw ApiException.Network(e)
            }
        }
        // 304: an If-None-Match that still matches (M46 canvases); only the caller that sent one sees it.
        if (status in 200..299 || status == 304) return text to status

        val envelope = runCatching { Codec.plain.decodeFromString(ErrorEnvelope.serializer(), text) }.getOrNull()
        val error = ApiException.Api(status, envelope?.error?.code ?: "http_$status", envelope?.error?.message ?: "Request failed", envelope?.error?.details)
        if (auth && status == 401 && error.code == "token_expired" && retry401) {
            refresh()
            return requestRaw(method, path, body, auth, retry401 = false, headers = headers, etagOut = etagOut)
        }
        if (auth && status == 401 && error.code != "token_expired") signOut()
        throw error
    }

    companion object {
        /** M93: the workspace icon of `version`; the version in the query keeps a new icon from being cached away. */
        fun serverIconPath(version: String): String = "/api/v1/server/icon?v=" + java.net.URLEncoder.encode(version, "UTF-8")

        /** Refresh retries stay this far inside the server's 30 s grace for the previous token. */
        const val REFRESH_GRACE_MS = 25_000L
        const val REFRESH_RETRY_FIRST_MS = 1_000L
    }
}
