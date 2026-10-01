package jp.chikuwachat.android.api

import jp.chikuwachat.android.sync.ActivityApi
import jp.chikuwachat.android.sync.CalendarApi
import jp.chikuwachat.android.sync.TaskApi
import jp.chikuwachat.android.sync.CanvasApi
import jp.chikuwachat.android.sync.ChannelApi
import jp.chikuwachat.android.sync.ChannelLinksApi
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
) : SyncApi, DraftApi, ChannelLinksApi, ActivityApi, CanvasApi, ChannelApi, CalendarApi, TaskApi {
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

    suspend fun me(): UserMe = request("GET", "/api/v1/users/me")

    suspend fun changePassword(current: String, new: String) {
        requestRaw("PUT", "/api/v1/users/me/password", buildJsonObject { put("current_password", current); put("new_password", new) }, auth = true, retry401 = true)
    }

    /** M40: my signed-in sessions, this one marked `current`. */
    suspend fun sessions(): List<SessionOut> = request("GET", "/api/v1/auth/sessions")

    /** M40: signs another of my sessions out (its refresh token stops working; 204). */
    suspend fun revokeSession(id: String) {
        requestRaw("DELETE", "/api/v1/auth/sessions/$id", null, auth = true, retry401 = true)
    }

    suspend fun users(): List<UserPublic> = request("GET", "/api/v1/users")

    override suspend fun bootstrap(): BootstrapOut = request("GET", "/api/v1/sync/bootstrap")

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

    // --- favorites and read-all (M12a) ----------------------------------------------------------

    suspend fun favoriteChannel(channelId: String): FavoriteStateOut = request("PUT", "/api/v1/channels/$channelId/favorite")
    suspend fun unfavoriteChannel(channelId: String): FavoriteStateOut = request("DELETE", "/api/v1/channels/$channelId/favorite")
    override suspend fun readAll(): List<ChannelReadStateOut> = request("POST", "/api/v1/channels/read-all", buildJsonObject {})

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

    /** GET /activity: `filter` all / mentions / reactions / threads; `cursor` is the previous page's next_cursor. */
    suspend fun listActivity(filter: String = "all", cursor: String? = null, limit: Int = 50): ActivityListOut =
        request("GET", "/api/v1/activity?filter=$filter&limit=$limit" + (cursor?.let { "&cursor=" + Enc.encode(it, "UTF-8") } ?: ""))

    override suspend fun activitySummary(): ActivitySummaryOut = request("GET", "/api/v1/activity/summary")

    /** PUT /activity/read: everything up to `readAt` is read (the server only moves it forward, never past now). */
    suspend fun markActivityRead(readAt: String): ActivitySummaryOut =
        request("PUT", "/api/v1/activity/read", buildJsonObject { put("read_at", readAt) })

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

    suspend fun updateSidebarSection(id: String, name: String? = null, position: Int? = null, collapsed: Boolean? = null): List<SidebarSectionOut> =
        request("PATCH", "/api/v1/sidebar/sections/$id", buildJsonObject {
            name?.let { put("name", it) }
            position?.let { put("position", it) }
            collapsed?.let { put("collapsed", it) }
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

    // --- canvases (CANVAS.md §4.5, M46) ---------------------------------------------------------

    /** The conversation's canvases without bodies, most recently updated first (`trashed`: its trash instead). */
    override suspend fun listCanvases(channelId: String, trashed: Boolean): List<CanvasMeta> =
        request("GET", "/api/v1/channels/$channelId/canvases" + if (trashed) "?trashed=true" else "")

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

    // --- tasks (TASKS.md §3, M56) ---------------------------------------------------------------

    override suspend fun listTasks(channelId: String, includeDone: String): List<TaskOut> =
        request("GET", "/api/v1/tasks?channel_id=$channelId&include_done=" + Enc.encode(includeDone, "UTF-8"))

    override suspend fun myTasks(): List<TaskOut> = request("GET", "/api/v1/tasks/mine")

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

    private suspend fun requestRaw(method: String, path: String, body: JsonElement?, auth: Boolean, retry401: Boolean, headers: Map<String, String> = emptyMap()): Pair<String, Int> {
        if (auth && accessToken == null && refreshToken != null) ensureAccessToken()
        val builder = Request.Builder().url(baseUrl.trimEnd('/') + path).header("Accept", "application/json")
        headers.forEach { (name, value) -> builder.header(name, value) }
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
        // 304: an If-None-Match that still matches (M46 canvases); only the caller that sent one sees it.
        if (status in 200..299 || status == 304) return text to status

        val envelope = runCatching { Codec.plain.decodeFromString(ErrorEnvelope.serializer(), text) }.getOrNull()
        val error = ApiException.Api(status, envelope?.error?.code ?: "http_$status", envelope?.error?.message ?: "Request failed", envelope?.error?.details)
        if (auth && status == 401 && error.code == "token_expired" && retry401) {
            refresh()
            return requestRaw(method, path, body, auth, retry401 = false, headers = headers)
        }
        if (auth && status == 401 && error.code != "token_expired") signOut()
        throw error
    }

    private companion object {
        /** Refresh retries stay this far inside the server's 30 s grace for the previous token. */
        const val REFRESH_GRACE_MS = 25_000L
        const val REFRESH_RETRY_FIRST_MS = 1_000L
    }
}
