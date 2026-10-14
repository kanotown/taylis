package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.app.Workspace
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.platform.ConversationStyle
import jp.chikuwachat.android.share.ShareApi
import jp.chikuwachat.android.share.ShareDestinations
import jp.chikuwachat.android.share.ShareFileMissing
import jp.chikuwachat.android.share.ShareIntentData
import jp.chikuwachat.android.share.ShareStream
import jp.chikuwachat.android.share.OwnProviders
import jp.chikuwachat.android.share.ShareJob
import jp.chikuwachat.android.share.ShareJobFile
import jp.chikuwachat.android.share.ShareJobs
import jp.chikuwachat.android.share.ShareOutcome
import jp.chikuwachat.android.share.SharePayload
import jp.chikuwachat.android.share.ShareRequest
import jp.chikuwachat.android.share.ShareSender
import jp.chikuwachat.android.share.SharedFile
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files

/** MOBILE_UI.md §20: sharing from other apps (intent → items, destinations, the background send). */
class ShareTest {
    private val ownNames = setOf("jp.chikuwachat.android.files", "jp.chikuwachat.android.androidx-startup")
    private val own = OwnProviders(ownNames)

    /**
     * What android.net.Uri gives for a URI (ShareActivity.read): the scheme, and the authority percent-decoded as
     * Uri.getAuthority() decodes it — what ContentResolver resolves.
     */
    private fun stream(uri: String): ShareStream {
        val scheme = uri.substringBefore(':', "").ifEmpty { null }
        val rest = uri.substringAfter(':', "")
        val raw = if (rest.startsWith("//")) rest.substring(2).takeWhile { it != '/' && it != '?' && it != '#' } else null
        return ShareStream(uri, scheme, raw?.let { java.net.URLDecoder.decode(it.replace("+", "%2B"), "UTF-8") })
    }

    private fun streams(vararg uris: String) = uris.map(::stream)

    private fun readable(uri: String, providers: OwnProviders = own) = stream(uri).let { SharePayload.isReadable(it.scheme, it.authority, providers) }
    private val send = SharePayload.ACTION_SEND
    private val multiple = SharePayload.ACTION_SEND_MULTIPLE

    // --- intent → items ---------------------------------------------------------------------------

    @Test fun aSharedFileIsItsContentUri() {
        val request = SharePayload.parse(ShareIntentData(send, streams = streams("content://com.android.providers.downloads.documents/document/12")), own)
        assertEquals(ShareRequest(listOf("content://com.android.providers.downloads.documents/document/12"), "", null), request)
    }

    @Test fun severalFilesKeepTheirOrderOnce() {
        val request = SharePayload.parse(ShareIntentData(multiple, streams = streams("content://media/external/images/1", "content://media/external/images/2", "content://media/external/images/1")), own)!!
        assertEquals(listOf("content://media/external/images/1", "content://media/external/images/2"), request.uris)
    }

    @Test fun filePathsAndThisAppsOwnProvidersAreRefused() {
        val request = SharePayload.parse(
            ShareIntentData(
                multiple,
                streams = streams(
                    "file:///data/data/jp.chikuwachat.android/databases/chikuwa.db",
                    "content://jp.chikuwachat.android.files/downloads/a.pdf",
                    "CONTENT://JP.CHIKUWACHAT.ANDROID.FILES/x",
                    "content://com.google.android.apps.photos.contentprovider/0/1",
                ),
            ),
            own,
        )!!
        assertEquals(listOf("content://com.google.android.apps.photos.contentprovider/0/1"), request.uris)
        assertEquals(3, request.refused)
        // Only refused files and no text: still a share, so the screen can say why nothing can be sent.
        assertEquals(1, SharePayload.parse(ShareIntentData(send, streams = streams("file:///sdcard/a.txt")), own)!!.refused)
        assertTrue(readable("content://user@com.other/1"))
        assertTrue(!readable("content://"))
    }

    @Test fun ownProvidersAreRefusedHoweverTheAuthorityIsSpelled() {
        // REVIEW-v0.1.62 #2: Android decodes the authority before it resolves the provider; so does the check.
        assertTrue(!readable("content://jp%2Echikuwachat%2Eandroid%2Efiles/downloads/review-private.txt"))
        assertTrue(!readable("content://%6A%70.chikuwachat.android.files/downloads/a"))
        assertTrue(!readable("content://jp.chikuwachat.android%2efiles/camera/b.jpg"))
        // A user id in front (ContentProvider.getAuthorityWithoutUserId), and any case.
        assertTrue(!readable("content://10@jp.chikuwachat.android.files/downloads/a"))
        assertTrue(!readable("content://0@JP.CHIKUWACHAT.ANDROID.FILES/downloads/a"))
        assertTrue(!readable("content://Jp.ChikuwaChat.Android.Files/downloads/a"))
        assertTrue(!readable("content://10%40jp.chikuwachat.android.files/downloads/a"))
        // An alias the manifest list misses: the system says it resolves to this app's package.
        val resolving = OwnProviders(ownNames) { it.equals("jp.chikuwachat.android.alias", ignoreCase = true) }
        assertTrue(!readable("content://jp.chikuwachat.android.alias/x", resolving))
        assertTrue(!readable("content://5@jp%2Echikuwachat%2Eandroid%2Ealias/x", resolving))
        // When the system cannot be asked, nothing is read.
        assertTrue(!readable("content://com.other/1", OwnProviders(ownNames) { throw SecurityException("no") }))
        // The whole intent: refused and counted.
        val request = SharePayload.parse(
            ShareIntentData(multiple, streams = streams("content://jp%2Echikuwachat%2Eandroid%2Efiles/downloads/x", "content://10@jp.chikuwachat.android.files/y")),
            own,
        )!!
        assertEquals(emptyList<String>(), request.uris)
        assertEquals(2, request.refused)
    }

    @Test fun otherAppsContentIsStillAccepted() {
        val resolving = OwnProviders(ownNames) { it == "jp.chikuwachat.android.files" }
        for (uri in listOf(
            "content://com.android.providers.media.documents/document/image%3A12",
            "content://media/external/images/media/1",
            "content://com.google.android.apps.photos.contentprovider/0/1/mediakey%3A%2Flocal%253A1/ORIGINAL/NONE/1",
            "content://0@media/external/images/media/2",
            "CONTENT://com.example.files/a%20b.pdf",
        )) {
            assertTrue(uri, readable(uri, resolving))
        }
        // The share keeps the text exactly as Android gave it (the read parses the same text again).
        val uri = "content://com.android.providers.media.documents/document/image%3A12"
        assertEquals(listOf(uri), SharePayload.parse(ShareIntentData(send, streams = streams(uri)), resolving)!!.uris)
    }

    @Test fun aLinkFromABrowserIsTheTextWithItsTitleInFront() {
        val chrome = ShareIntentData(send, texts = listOf("https://example.com/a"), subject = "Example page")
        assertEquals("Example page\nhttps://example.com/a", SharePayload.parse(chrome, own)!!.text)
        // A subject already in the text, or no text at all.
        assertEquals("Example https://example.com", SharePayload.parse(ShareIntentData(send, texts = listOf("Example https://example.com"), subject = "Example"), own)!!.text)
        assertEquals("件名だけ", SharePayload.parse(ShareIntentData(send, subject = " 件名だけ "), own)!!.text)
        // With files the subject is left out (a mail app's subject is not the message).
        val withFile = ShareIntentData(send, streams = streams("content://a/1"), texts = listOf("見て"), subject = "Fwd: 資料")
        assertEquals("見て", SharePayload.parse(withFile, own)!!.text)
        // Several texts (SEND_MULTIPLE) one per line, blanks dropped.
        assertEquals("a\nb", SharePayload.parse(ShareIntentData(multiple, texts = listOf(" a ", "", "b")), own)!!.text)
    }

    @Test fun otherIntentsOrEmptySharesAreNothing() {
        assertNull(SharePayload.parse(ShareIntentData("android.intent.action.VIEW", streams = streams("content://a/1")), own))
        assertNull(SharePayload.parse(ShareIntentData(send), own))
        assertNull(SharePayload.parse(ShareIntentData(send, texts = listOf("  ")), own))
        assertNull(SharePayload.parse(ShareIntentData(null), own))
    }

    @Test fun aDirectShareKeepsItsShortcut() {
        val request = SharePayload.parse(ShareIntentData(send, texts = listOf("x"), shortcutId = "conv:abc:c1"), own)!!
        assertEquals("conv:abc:c1", request.shortcutId)
        assertNull(SharePayload.parse(ShareIntentData(send, texts = listOf("x"), shortcutId = " "), own)!!.shortcutId)
    }

    @Test fun fileNamesComeFromTheProviderElseTheUri() {
        assertEquals("report.pdf", SharePayload.fileName("report.pdf", "content://a/1"))
        assertEquals("a.pdf", SharePayload.fileName("../../a.pdf", "content://a/1"))
        assertEquals("写真 1.jpg", SharePayload.fileName(null, "content://a/dir/%E5%86%99%E7%9C%9F%201.jpg?x=1"))
        assertEquals("ab", SharePayload.fileName("a\u0000b", "content://a/1"))
        assertEquals("file", SharePayload.fileName(" ", "content://a/"))
    }

    @Test fun theLimitsAreTheComposersWithClearWords() {
        val limits = Limits(maxMessageLength = 10, maxAttachmentBytes = 1000, maxAttachmentsPerMessage = 2)
        val ok = SharedFile("content://a/1", "a.pdf", 1000, "application/pdf")
        assertEquals(emptyList<String>(), SharePayload.problems(listOf(ok), "", limits))
        assertEquals(listOf("「b.mp4」は大きすぎます（上限 1000 B）"), SharePayload.problems(listOf(ok.copy(name = "b.mp4", size = 1001)), "", limits))
        assertEquals(listOf("添付は 2 件までです"), SharePayload.problems(listOf(ok, ok.copy(uri = "2"), ok.copy(uri = "3")), "", limits))
        assertEquals(listOf("「a.pdf」は空のファイルです"), SharePayload.problems(listOf(ok.copy(size = 0)), "", limits))
        assertEquals(listOf("「a.pdf」を読めませんでした"), SharePayload.problems(listOf(ok.copy(readable = false)), "", limits))
        assertEquals(listOf("メッセージは 10 文字までです"), SharePayload.problems(emptyList(), "12345678901", limits))
        assertEquals(listOf("送るものがありません"), SharePayload.problems(emptyList(), " ", limits))
        // An unknown size (the copy tells later) and no limits yet (before bootstrap): nothing to say.
        assertEquals(emptyList<String>(), SharePayload.problems(listOf(ok.copy(size = null)), "", null))
    }

    // --- destinations -----------------------------------------------------------------------------

    private fun channel(
        id: String, name: String? = id, type: String = "public", member: Boolean = true, archived: Boolean = false,
        lastAt: String? = null, owners: Boolean = false, role: String = "member", dm: List<String>? = null,
    ) = ChannelState(
        ChannelOut(
            id = id, type = type, name = name, archived = archived, lastSeq = 1, lastMessageAt = lastAt,
            createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z",
            membership = if (member) MembershipOut(role, "2026-01-01T00:00:00Z") else null,
            postingPolicy = if (owners) "owners" else null, dmUserIds = dm,
        ),
        isMember = member,
    )

    private val people = mapOf("me" to listOf("自分", "me"), "u1" to listOf("佐藤 花子", "sato"), "u2" to listOf("山田", "yamada"))
    private fun title(c: ChannelState) = if (c.channel.isDm) c.channel.dmUserIds.orEmpty().filter { it != "me" }.joinToString { people[it]!![0] } else "#" + c.channel.name

    private val channels = listOf(
        channel("general", lastAt = "2026-10-10T00:00:00Z"),
        channel("random", lastAt = "2026-10-12T00:00:00Z"),
        channel("old", archived = true),
        channel("other", member = false),
        channel("news", owners = true, lastAt = "2026-10-11T00:00:00Z"),
        channel("team", owners = true, role = "owner", type = "private"),
        channel("d1", name = null, type = "dm", dm = listOf("me", "u1"), lastAt = "2026-10-09T00:00:00Z"),
        channel("g1", name = null, type = "group_dm", dm = listOf("me", "u1", "u2")),
    )

    private fun list(query: String, recent: List<String> = emptyList(), admin: Boolean = false) =
        ShareDestinations.list(query, channels, recent, "me", admin, ::title) { people[it] ?: emptyList() }

    @Test fun onlyConversationsICanPostInAreOffered() {
        val all = list("").others.map { it.id }
        // Archived, not joined and an announcement channel I do not own are left out; newest first, then by name.
        assertEquals(listOf("random", "general", "d1", "team", "g1"), all) // no message yet: by title ("#team" before 「佐藤…」)
        assertTrue("news" in list("", admin = true).others.map { it.id }) // an admin may post in announcements
    }

    @Test fun recentConversationsComeFirst() {
        val lists = list("", recent = listOf("d1", "gone", "old", "general", "d1"))
        assertEquals(listOf("d1", "general"), lists.recent.map { it.id }) // vanished / archived ones skipped, once each
        assertEquals(listOf("random", "team", "g1"), lists.others.map { it.id })
    }

    @Test fun searchFindsChannelsAndPeopleByTheJumpRule() {
        assertEquals(listOf("general"), list("gen").others.map { it.id })
        assertEquals(listOf("d1", "g1"), list("sato").others.map { it.id })
        assertEquals(listOf("g1"), list("yama").others.map { it.id })
        assertEquals(listOf("g1"), list("山田").others.map { it.id })
        assertEquals(emptyList<String>(), list("old").others.map { it.id })
        assertTrue(list("gen", recent = listOf("general")).recent.isEmpty()) // typing shows one ranked list
    }

    @Test fun aDirectShareShortcutNamesItsWorkspaceAndConversation() {
        val a = "https://a.example.com"
        val b = "http://10.0.2.2:8000"
        val id = ConversationStyle.shortcutId(b, "c-123")
        assertEquals(b to "c-123", ShareDestinations.shortcutTarget(id, listOf(a, b)))
        assertNull(ShareDestinations.shortcutTarget(id, listOf(a))) // that workspace is gone
        assertNull(ShareDestinations.shortcutTarget("other", listOf(a, b)))
        assertNull(ShareDestinations.shortcutTarget(null, listOf(a, b)))
    }

    // --- the background send ----------------------------------------------------------------------

    private fun job(files: Int = 2) = ShareJob(
        id = "j1", serverUrl = "http://s", channelId = "c1", channelTitle = "#general", body = "見て",
        clientMsgId = "key-1", files = (0 until files).map { ShareJobFile(it.toString(), "f$it.pdf", "application/pdf", 100L) },
    )

    /** A server that keeps messages by idempotency key (a replay answers with the first one) and can fail on cue. */
    private class FakeServer : ShareApi {
        val uploads = mutableListOf<String>()
        val posts = mutableListOf<Triple<String, String, List<String>>>()
        val messages = LinkedHashMap<String, MessageOut>()
        val failUploads = ArrayDeque<Exception?>()
        val failPosts = ArrayDeque<Exception?>()
        /** The post stores the message but its answer is lost (the network dropped after the commit). */
        var loseAnswerOnce = false
        var next = 0
        /** Runs after each upload's answer (an account change half-way). */
        var afterUpload: () -> Unit = {}
        /** Every call this server got (REVIEW-v0.1.62 #1: none may reach another person's session). */
        val calls: Int get() = uploads.size + posts.size + failedCalls
        var failedCalls = 0

        override suspend fun upload(job: ShareJob, file: ShareJobFile, sent: (Long) -> Unit): String {
            failUploads.removeFirstOrNull()?.let { failedCalls++; throw it }
            sent(file.size / 2)
            uploads += file.path
            afterUpload()
            return "att-" + (++next)
        }

        override suspend fun post(channelId: String, clientMsgId: String, body: String, attachmentIds: List<String>): MessageOut {
            failPosts.removeFirstOrNull()?.let { failedCalls++; throw it }
            posts += Triple(clientMsgId, body, attachmentIds)
            val message = messages.getOrPut(clientMsgId) {
                MessageOut(id = "m" + (messages.size + 1), channelId = channelId, senderId = "me", seq = messages.size + 1, updatedSeq = 1,
                    clientMsgId = clientMsgId, body = body, createdAt = "2026-10-12T00:00:00Z", deleted = false)
            }
            if (loseAnswerOnce) {
                loseAnswerOnce = false
                throw ApiException.Network(IOException("connection reset"))
            }
            return message
        }
    }

    @Test fun uploadsThenPostsOneMessageWithEveryFile() = runBlocking {
        val server = FakeServer()
        val saved = mutableListOf<ShareJob>()
        val progress = mutableListOf<Pair<Long, Long>>()
        val outcome = ShareSender(server, { saved += it }, progress = { sent, total -> progress += sent to total }).run(job())
        assertTrue(outcome is ShareOutcome.Posted)
        assertEquals(listOf("0", "1"), server.uploads)
        assertEquals(listOf(Triple("key-1", "見て", listOf("att-1", "att-2"))), server.posts)
        assertEquals(listOf("att-1", "att-2"), saved.last().files.map { it.attachmentId }) // each id saved as it came
        assertEquals(200L to 200L, progress.last())
        assertEquals(50L to 200L, progress.first())
    }

    @Test fun aRetryUploadsOnlyWhatIsMissingAndPostsUnderTheSameKey() = runBlocking {
        val server = FakeServer()
        var stored = job(3)
        server.failUploads += listOf(null, ApiException.Network(IOException("offline")))
        val first = ShareSender(server, { stored = it }).run(stored)
        assertTrue(first is ShareOutcome.Retry)
        assertEquals(listOf("att-1", null, null), stored.files.map { it.attachmentId })
        // The answer to the post is lost once: the retry finds the message the first post made (no duplicate).
        server.loseAnswerOnce = true
        val second = ShareSender(server, { stored = it }).run(stored)
        assertTrue(second is ShareOutcome.Retry)
        val third = ShareSender(server, { stored = it }).run(stored)
        assertTrue(third is ShareOutcome.Posted)
        assertEquals(listOf("0", "1", "2"), server.uploads) // nothing uploaded twice
        assertEquals(1, server.messages.size)
        assertEquals(setOf("key-1"), server.posts.map { it.first }.toSet())
        assertEquals("m1", (third as ShareOutcome.Posted).message.id)
    }

    @Test fun temporaryFailuresRetryAndRefusalsEndTheShare() = runBlocking {
        fun outcomeOf(e: Exception): ShareOutcome = runBlocking {
            val server = FakeServer().apply { failPosts += e }
            ShareSender(server, {}).run(job(0))
        }
        assertTrue(outcomeOf(ApiException.Api(503, "unavailable", "x")) is ShareOutcome.Retry)
        assertTrue(outcomeOf(ApiException.Api(429, "rate_limited", "x")) is ShareOutcome.Retry)
        assertTrue(outcomeOf(ApiException.Network(IOException())) is ShareOutcome.Retry)
        assertTrue(outcomeOf(ApiException.Api(403, "not_a_member", "x")) is ShareOutcome.Failed)
        assertTrue(outcomeOf(ApiException.Api(413, "attachment_too_large", "x")) is ShareOutcome.Failed)
        assertTrue(outcomeOf(ApiException.Api(401, "invalid_token", "x")) is ShareOutcome.Failed) // the refresh was refused
        assertTrue(outcomeOf(ShareFileMissing("a.pdf")) is ShareOutcome.Failed)
    }

    @Test fun uploadsTheServerNoLongerTakesAreMadeAgainOnce() = runBlocking {
        val server = FakeServer()
        var stored = job(1).copy(files = listOf(ShareJobFile("0", "a.pdf", null, 10, attachmentId = "expired")))
        server.failPosts += ApiException.Api(400, "attachment_invalid", "x")
        val outcome = ShareSender(server, { stored = it }).run(stored)
        assertTrue(outcome is ShareOutcome.Posted)
        assertEquals(listOf("0"), server.uploads)
        assertEquals(listOf("att-1"), server.posts.single().third)
        assertTrue(stored.reuploaded)
        // A second refusal ends it.
        server.failPosts += ApiException.Api(400, "attachment_invalid", "x")
        assertTrue(ShareSender(server, { stored = it }).run(stored.copy(clientMsgId = "key-2")) is ShareOutcome.Failed)
    }

    @Test fun jobsAreKeptOnDiskUntilDone() {
        val root = Files.createTempDirectory("share").toFile()
        try {
            val jobs = ShareJobs(root)
            val saved = job().copy(files = job().files.mapIndexed { i, f -> if (i == 0) f.copy(attachmentId = "a") else f })
            jobs.save(saved)
            assertEquals(saved, jobs.read("j1"))
            assertEquals(saved, ShareJob.decode(ShareJob.encode(saved)))
            assertNull(ShareJob.decode("{broken"))
            // A screen closed without sending leaves copies but no job: removed once old; a job is never.
            val abandoned = File(root, "x").apply { mkdirs(); File(this, "0").writeText("data") }
            abandoned.setLastModified(0)
            File(root, "j1").setLastModified(0)
            jobs.purgeAbandoned(now = 48 * 3600_000L)
            assertTrue(!abandoned.exists())
            assertEquals(saved, jobs.read("j1"))
            jobs.delete("j1")
            assertNull(jobs.read("j1"))
        } finally {
            root.deleteRecursively()
        }
    }

    // --- the share's account (REVIEW-v0.1.62 #1) ------------------------------------------------------

    private val alice = Workspace(serverUrl = "http://s", name = "s", username = "alice", userId = "user-a", session = "sign-in-a")
    private val bob = Workspace(serverUrl = "http://s", name = "s", username = "bob", userId = "user-b", session = "sign-in-b")
    private fun aliceJob(files: Int = 2) = job(files).copy(userId = "user-a", session = "sign-in-a")

    /**
     * What ShareWorker does with the controller: the client of the job's own account ([ShareJob.accountIn], else no
     * request at all), and the account checked again around every call (AppController.shareStillOurs).
     */
    private suspend fun resume(job: ShareJob, workspaces: () -> List<Workspace>, servers: Map<String, FakeServer>, save: (ShareJob) -> Unit = {}): ShareOutcome {
        val entry = job.accountIn(workspaces()) ?: return ShareOutcome.Dropped
        val api = servers.getValue(entry.username)
        return ShareSender(api, save, stillOurs = { job.accountIn(workspaces())?.username == entry.username }).run(job)
    }

    @Test fun aShareResumedAfterAnotherPersonSignedInIsDroppedWithoutARequest() = runBlocking {
        val tokenA = FakeServer()
        val tokenB = FakeServer()
        val servers = mapOf("alice" to tokenA, "bob" to tokenB)
        // Waiting for a network (nothing sent yet), with text only, and with files: A signs out, B signs in on the same server.
        for (pending in listOf(aliceJob(0), aliceJob(2), aliceJob(1).copy(files = listOf(ShareJobFile("0", "a.pdf", null, 10, attachmentId = "att-a"))))) {
            assertTrue(resume(pending, { listOf(bob) }, servers) is ShareOutcome.Dropped)
        }
        assertEquals(0, tokenB.calls)
        assertEquals(0, tokenA.calls)
        // The same with A's entry signed out, removed, signed in again (a new sign-in), or a job of an older version.
        assertNull(aliceJob().accountIn(listOf(alice.copy(signedOut = true))))
        assertNull(aliceJob().accountIn(emptyList()))
        assertNull(aliceJob().accountIn(listOf(alice.copy(session = "sign-in-a2"))))
        assertNull(job().accountIn(listOf(alice)))
        assertNull(aliceJob().accountIn(listOf(alice.copy(serverUrl = "http://other"))))
        // Still A's: it runs, through A's client only.
        assertEquals(alice, aliceJob().accountIn(listOf(bob.copy(serverUrl = "http://other"), alice)))
        assertTrue(resume(aliceJob(), { listOf(alice) }, servers) is ShareOutcome.Posted)
        assertEquals(1, tokenA.posts.size)
        assertEquals(0, tokenB.calls)
        // An entry signed in before sign-in ids existed binds a job by the user id alone.
        assertEquals(alice.copy(session = null), aliceJob().copy(session = null).accountIn(listOf(alice.copy(session = null))))
    }

    @Test fun anAccountChangeHalfWayStopsTheShare() = runBlocking {
        val tokenA = FakeServer()
        val servers = mapOf("alice" to tokenA, "bob" to FakeServer())
        var workspaces = listOf(alice)
        // Mid-upload: A signs out and B signs in while the first file goes up; nothing more is sent.
        tokenA.afterUpload = { workspaces = listOf(bob) }
        var stored = aliceJob(3)
        val outcome = resume(stored, { workspaces }, servers) { stored = it }
        assertTrue(outcome is ShareOutcome.Dropped)
        assertEquals(listOf("0"), tokenA.uploads)
        assertTrue(tokenA.posts.isEmpty())
        assertEquals(0, servers.getValue("bob").calls)
        // Waiting for a retry: the account changes before the next attempt, which sends nothing.
        val tokenA2 = FakeServer().apply { failPosts += ApiException.Network(IOException("offline")) }
        var signedIn = listOf(alice)
        val sender = ShareSender(tokenA2, {}, stillOurs = { aliceJob(0).accountIn(signedIn) != null })
        assertTrue(sender.run(aliceJob(0)) is ShareOutcome.Retry)
        signedIn = listOf(bob)
        assertTrue(sender.run(aliceJob(0)) is ShareOutcome.Dropped)
        assertTrue(tokenA2.posts.isEmpty())
        assertEquals(1, tokenA2.calls)
        // The post on its way when A signed out: the refusal of the revoked token is the sign-out's doing, not reported.
        val revoked = FakeServer()
        var during = listOf(alice)
        val flipping = object : ShareApi by revoked {
            override suspend fun post(channelId: String, clientMsgId: String, body: String, attachmentIds: List<String>): MessageOut {
                during = listOf(bob) // signed out while the post was on its way: the server refuses the revoked token
                throw ApiException.Api(401, "invalid_token", "x")
            }
        }
        assertTrue(ShareSender(flipping, {}, stillOurs = { aliceJob(0).accountIn(during) != null }).run(aliceJob(0)) is ShareOutcome.Dropped)
    }

    @Test fun aSignOutRemovesTheAccountsJobsAndTheirCopies() {
        val root = Files.createTempDirectory("share").toFile()
        try {
            val jobs = ShareJobs(root)
            val a1 = aliceJob().copy(id = "a1")
            val a2 = aliceJob(0).copy(id = "a2")
            val b1 = aliceJob().copy(id = "b1", userId = "user-b", session = "sign-in-b")
            val other = aliceJob().copy(id = "o1", serverUrl = "http://other")
            for (j in listOf(a1, a2, b1, other)) {
                jobs.save(j)
                File(jobs.dir(j.id), "0").writeText("copy of " + j.id)
            }
            // Another account signs in on the same server: the jobs of everyone else there go, its own stay.
            assertEquals(setOf("a1", "a2"), jobs.dropAccount("http://s", keepUserId = "user-b").map { it.id }.toSet())
            assertTrue(!jobs.dir("a1").exists() && !jobs.dir("a2").exists())
            assertEquals(b1, jobs.read("b1"))
            // A sign-out: every job of that server, with its copies; another server's stay.
            assertEquals(listOf("b1"), jobs.dropAccount("http://s").map { it.id })
            assertTrue(!jobs.dir("b1").exists())
            assertEquals(other, jobs.read("o1"))
            assertTrue(File(jobs.dir("o1"), "0").isFile)
            // Work that runs on after its job was removed never writes it back.
            jobs.update(a1.copy(files = a1.files.map { it.copy(attachmentId = "x") }))
            assertNull(jobs.read("a1"))
            assertTrue(!jobs.dir("a1").exists())
            jobs.update(other.copy(reuploaded = true))
            assertTrue(jobs.read("o1")!!.reuploaded)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun aWidgetPressIsSentOnlyAsThePersonWhoPressed() {
        // AppController.widgetSetAttendance: the press carries the snapshot's meId (A); B signed in on the same server.
        assertTrue(alice.isAccount("user-a", null))
        assertTrue(!bob.isAccount("user-a", null))
        assertTrue(!alice.copy(signedOut = true).isAccount("user-a", null))
        assertTrue(!alice.isAccount(null, null))
        assertTrue(!alice.copy(userId = null).isAccount("user-a", null))
    }
}
