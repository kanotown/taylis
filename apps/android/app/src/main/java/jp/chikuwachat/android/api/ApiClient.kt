package jp.chikuwachat.android.api

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
    class Api(val status: Int, val code: String, val detail: String) : ApiException("$detail ($code)") {
        val isAuth: Boolean get() = status == 401
        /** Temporary failures worth retrying; the idempotency key prevents duplicates. */
        val isRetryable: Boolean get() = status == 429 || status >= 500
    }

    class Network(cause: Throwable) : ApiException(cause.message ?: "network error")
}

fun Throwable.isRetryable(): Boolean = this is ApiException.Network || (this is ApiException.Api && isRetryable)

/** Refused for good (4xx other than 429): sending the same request again cannot succeed. */
fun Throwable.isRefusal(): Boolean = this is ApiException.Api && status in 400..499 && status != 429

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
) : SyncApi, DraftApi, ChannelLinksApi {
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
            put("device", buildJsonObject {
                put("platform", platform)
                put("device_name", deviceName?.let { JsonPrimitive(it) } ?: JsonNull)
                put("app_version", appVersion?.let { JsonPrimitive(it) } ?: JsonNull)
            })
            if (!totpCode.isNullOrEmpty()) put("totp_code", totpCode)
        }
        val tokens: TokenResponse = request("POST", "/api/v1/auth/login", body, auth = false)
        apply(tokens)
        return tokens
    }

    /** SYNC_PROTOCOL.md §7.2: an access token that is still good for `marginMs` needs no refresh (and no rotation). */
    fun hasFreshAccessToken(marginMs: Long = 60_000): Boolean = accessToken != null && accessExpiresAt - clock() > marginMs

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

    suspend fun users(): List<UserPublic> = request("GET", "/api/v1/users")

    override suspend fun bootstrap(): BootstrapOut = request("GET", "/api/v1/sync/bootstrap")

    suspend fun channels(includePublic: Boolean): List<ChannelOut> =
        request("GET", "/api/v1/channels" + if (includePublic) "?include=public" else "")

    override suspend fun publicChannels(): List<ChannelOut> = channels(includePublic = true).filter { it.membership == null }

    suspend fun createChannel(name: String, type: String): ChannelOut =
        request("POST", "/api/v1/channels", buildJsonObject { put("name", name); put("type", type) })

    suspend fun joinChannel(id: String): ChannelOut = request("POST", "/api/v1/channels/$id/join", buildJsonObject {})

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

    suspend fun setNotificationPreference(channelId: String, level: String, mutedUntil: String?): NotificationPreferenceOut =
        request("PUT", "/api/v1/channels/$channelId/notification-preference", buildJsonObject {
            put("level", level)
            put("muted_until", mutedUntil)
        })

    suspend fun updateMe(displayName: String? = null, email: String? = null): UserMe =
        request("PATCH", "/api/v1/users/me", buildJsonObject {
            displayName?.let { put("display_name", it) }
            email?.let { put("email", it) }
        })

    /** M11d: profile card fields; JsonNull clears a field, omitted fields keep their value. */
    suspend fun updateProfile(fields: JsonObject): UserMe = request("PATCH", "/api/v1/users/me", fields)

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

    /** GET /search/messages: full-text search across my channels (SECURITY.md: server-side permission filter). */
    suspend fun searchMessages(query: String, channelId: String? = null, limit: Int = 20, offset: Int = 0): SearchOut {
        // before: / after: / on: dates are interpreted in the caller's zone (DATA_MODEL.md 検索).
        val tzOffset = java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
        val params = "q=" + Enc.encode(query, "UTF-8") + "&limit=$limit&offset=$offset&tz_offset_minutes=$tzOffset" + (channelId?.let { "&channel_id=$it" } ?: "")
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
        if (accessToken == null && refreshToken != null) refresh()
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
        if (accessToken == null && refreshToken != null) refresh()
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
        return ApiException.Api(status, envelope?.error?.code ?: "http_$status", envelope?.error?.message ?: "Request failed")
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

    suspend fun createSidebarSection(name: String): List<SidebarSectionOut> =
        request("POST", "/api/v1/sidebar/sections", buildJsonObject { put("name", name) })

    suspend fun updateSidebarSection(id: String, name: String? = null, position: Int? = null): List<SidebarSectionOut> =
        request("PATCH", "/api/v1/sidebar/sections/$id", buildJsonObject { name?.let { put("name", it) }; position?.let { put("position", it) } })

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

    // --- acknowledgements (M15e) ----------------------------------------------------------------

    suspend fun acknowledge(messageId: String, present: Boolean): MessageOut =
        if (present) request("PUT", "/api/v1/messages/$messageId/ack", buildJsonObject {})
        else request("DELETE", "/api/v1/messages/$messageId/ack")

    // --- polls (M14b) ------------------------------------------------------------------------

    suspend fun vote(messageId: String, option: Int, present: Boolean): MessageOut =
        if (present) request("PUT", "/api/v1/messages/$messageId/poll/votes/$option", buildJsonObject {})
        else request("DELETE", "/api/v1/messages/$messageId/poll/votes/$option")

    suspend fun closePoll(messageId: String): MessageOut = request("POST", "/api/v1/messages/$messageId/poll/close", buildJsonObject {})

    /** A message that carries a poll; posted directly (not through the offline queue). */
    suspend fun postPoll(channelId: String, parentId: String?, question: String, options: List<String>, multiple: Boolean): MessageOut =
        request("POST", "/api/v1/channels/$channelId/messages", buildJsonObject {
            put("client_msg_id", java.util.UUID.randomUUID().toString())
            put("body", "")
            put("parent_id", parentId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("poll", buildJsonObject {
                put("question", question)
                put("options", buildJsonArray { options.forEach { add(JsonPrimitive(it)) } })
                put("multiple", multiple)
            })
        })

    // --- invite links (M12h) ------------------------------------------------------------------

    /** No login: what the link offers. 404 = unknown, 410 = expired / used up / revoked. */
    suspend fun invitePreview(token: String): InvitePreviewOut = request("GET", "/api/v1/invites/$token", auth = false)

    /** Creates the account and logs it in (the response is the same as a login). */
    suspend fun acceptInvite(token: String, username: String, displayName: String, password: String, platform: String, deviceName: String?, appVersion: String?): TokenResponse {
        val body = buildJsonObject {
            put("username", username)
            put("display_name", displayName)
            put("password", password)
            put("device", buildJsonObject {
                put("platform", platform)
                put("device_name", deviceName?.let { JsonPrimitive(it) } ?: JsonNull)
                put("app_version", appVersion?.let { JsonPrimitive(it) } ?: JsonNull)
            })
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

    private suspend fun requestRaw(method: String, path: String, body: JsonElement?, auth: Boolean, retry401: Boolean): Pair<String, Int> {
        if (auth && accessToken == null && refreshToken != null) refresh()
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

    private companion object {
        /** Refresh retries stay this far inside the server's 30 s grace for the previous token. */
        const val REFRESH_GRACE_MS = 25_000L
        const val REFRESH_RETRY_FIRST_MS = 1_000L
    }
}
