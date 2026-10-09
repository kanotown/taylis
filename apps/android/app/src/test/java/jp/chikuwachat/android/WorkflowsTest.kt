package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.FieldDefault
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.WorkflowField
import jp.chikuwachat.android.api.WorkflowOut
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.toOut
import jp.chikuwachat.android.ui.FieldValue
import jp.chikuwachat.android.ui.SlashCommands
import jp.chikuwachat.android.ui.WorkflowSession
import jp.chikuwachat.android.ui.Workflows
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.time.LocalDate

/** M95 (WORKFLOWS.md §8 6.): the shared cases, the label's decoding, `/wf`, and a retried submit keeping its key. */
class WorkflowsTest {
    private val vectors: JsonObject by lazy {
        val file = File("../../shared/workflows.json")
        check(file.isFile) { "apps/shared/workflows.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun fields(element: JsonElement): List<WorkflowField> = Codec.snake.decodeFromJsonElement(ListSerializer(WorkflowField.serializer()), element)

    private fun json(values: Map<String, FieldValue>): JsonObject = JsonObject(Workflows.json(values))

    @Test fun rendersTheSharedCases() {
        val cases = vectors["render"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val fields = fields(c["fields"]!!)
            val cleaned = Workflows.cleanValues(fields, c["values"]!!.jsonObject)
            assertNull(name, cleaned.errors)
            assertEquals(name, c["expected"]!!.jsonPrimitive.content, Workflows.render(c["template"]!!.jsonPrimitive.content, fields, cleaned.values!!))
        }
    }

    @Test fun checksTheSharedValues() {
        val shared = fields(vectors["value_fields"]!!)
        for (case in vectors["values"]!!.jsonArray) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val result = Workflows.cleanValues(c["fields"]?.let { fields(it) } ?: shared, c["values"]!!.jsonObject)
            val errors = c["errors"]!!
            if (errors is JsonObject) {
                assertNull(name, result.values)
                assertEquals(name, errors.mapValues { it.value.jsonPrimitive.content }, result.errors)
            } else {
                assertNull(name, result.errors)
                assertEquals(name, c["cleaned"]!!.jsonObject, json(result.values!!))
            }
        }
    }

    @Test fun keysAndDefaults() {
        val keys = vectors["keys"]!!.jsonObject
        keys["valid"]!!.jsonArray.forEach { assertTrue(it.jsonPrimitive.content, Workflows.validKey(it.jsonPrimitive.content)) }
        keys["invalid"]!!.jsonArray.forEach { assertFalse(it.jsonPrimitive.content, Workflows.validKey(it.jsonPrimitive.content)) }
        for (case in vectors["defaults"]!!.jsonArray) {
            val c = case.jsonObject
            val default = c["default"]?.takeIf { it is JsonObject }?.let { Codec.snake.decodeFromJsonElement(FieldDefault.serializer(), it) }
            val field = WorkflowField(key = "k", label = "K", type = c["type"]!!.jsonPrimitive.content, default = default)
            val value = Workflows.defaultValue(field, LocalDate.parse(c["today"]!!.jsonPrimitive.content), c["me"]?.jsonPrimitive?.content)
            assertEquals(c["name"]!!.jsonPrimitive.content, c["expected"]!!, value.toJson())
        }
    }

    @Test fun previewTreatsAValueThatDoesNotCheckOutAsEmpty() {
        val fields = listOf(WorkflowField("日付", "日付", "date", required = true), WorkflowField("a", "A", "text"))
        val values = mapOf("日付" to FieldValue.Text("2026-13-01"), "a" to FieldValue.Text("x"))
        assertEquals("本文 x", Workflows.renderPreview("{{日付}}\n本文 {{a}}", fields, values))
    }

    // --- MessageOut.workflow ---------------------------------------------------------------------------------------

    private fun wire(extra: String) = """
        {"id": "m1", "channel_id": "c1", "sender_id": "u1", "seq": 3, "updated_seq": 3, "client_msg_id": null, "type": "user",
         "body": "*【報告者】* <@u1>", "mentioned_user_ids": ["u1"], "mention_all": false, "reactions": [], "attachments": [],
         "reply_count": 0, "last_reply_at": null, "created_at": "2026-10-04T04:00:00Z", "edited_at": null, "deleted": false$extra}
    """.trimIndent()

    @Test fun decodesTheWorkflowLabelMissingNullOrPresent() {
        assertNull(Codec.snake.decodeFromString(MessageOut.serializer(), wire("")).workflow)
        assertNull(Codec.snake.decodeFromString(MessageOut.serializer(), wire(""", "workflow": null""")).workflow)
        val message = Codec.snake.decodeFromString(MessageOut.serializer(), wire(""", "workflow": {"id": "w1", "name": "ゼミ欠席報告", "later": 1}"""))
        assertEquals("w1", message.workflow?.id)
        assertEquals("ゼミ欠席報告", message.workflow?.name)

        // Kept in the stored JSON (no Room version) and back out for thread rows; a row stored before M95 has none.
        val state = MessageState.from(message)
        val stored = Codec.plain.encodeToString(MessageState.serializer(), state)
        val restored = Codec.plain.decodeFromString(MessageState.serializer(), stored)
        assertEquals(message.workflow, restored.workflow)
        assertEquals(message.workflow, restored.toOut()?.workflow)
        val older = Codec.plain.decodeFromString(MessageState.serializer(), stored.replace(Regex(""","workflow":\{[^}]*\}"""), ""))
        assertNull(older.workflow)
    }

    // --- `/name` and `/wf name` ------------------------------------------------------------------------------------

    private fun workflow(name: String, id: String = name, extra: (WorkflowOut) -> WorkflowOut = { it }) =
        extra(WorkflowOut(id = id, name = name, channelId = "c1", template = "x", canRun = true))

    @Test fun slashLookupMatchesTheDesktop() {
        val list = listOf(workflow("ゼミ欠席報告"), workflow("Report"), workflow("学部 ゼミ案内"))
        fun find(text: String): WorkflowOut? = SlashCommands.parse(text)?.let { Workflows.findCommand(it.name, it.args, list) }
        assertEquals("ゼミ欠席報告", find("/ゼミ欠席報告")?.name)
        assertEquals("Report", find("/report")?.name)
        assertNull(find("/report extra"))
        assertEquals("学部 ゼミ案内", find("/wf 学部  ゼミ案内")?.name)
        assertEquals("Report", find("/WF REPORT")?.name)
        // Unicode whitespace folds as the desktop's `\s` (spelled out: Android's ICU refuses `(?U)`).
        assertEquals("学部 ゼミ案内", Workflows.findCommand("wf", "学部　ゼミ案内", list)?.name)
        assertNull(find("/wf"))
        assertNull(find("/ない"))
        // `wf` is no built-in command: the composer reaches the workflows after the templates.
        assertFalse(SlashCommands.parse("/wf 学部")!!.known)

        assertEquals(listOf("ゼミ欠席報告"), Workflows.candidates("/ゼミ", list).map { it.name })
        assertEquals(listOf("ゼミ欠席報告", "Report"), Workflows.candidates("/", list).map { it.name })
        assertEquals(listOf("学部 ゼミ案内"), Workflows.candidates("/wf 学部", list).map { it.name })
        assertEquals(emptyList<WorkflowOut>(), Workflows.candidates("/ゼミ 本文", list))
    }

    @Test fun blockedTextsAreTheDesktops() {
        assertEquals("#報告 に参加すると使えます", Workflows.runBlockedText("not_a_member", "#報告"))
        assertEquals("#報告 はオーナーと管理者だけが投稿できます", Workflows.runBlockedText("posting_restricted", "#報告"))
        assertEquals("#報告 はアーカイブ済みです", Workflows.runBlockedText("archived", "#報告"))
        assertEquals("停止中", Workflows.runBlockedText("disabled", "#報告"))
        assertNull(Workflows.runBlockedText(null, "#報告"))
    }

    @Test fun listCacheKeepsAMinute() {
        var now = 0L
        val cache = Workflows.ListCache { now }
        cache.put("c1", listOf(workflow("a")))
        now = 59_999
        assertNotNull(cache.get("c1"))
        now = 60_000
        assertNull(cache.get("c1"))
    }

    // --- submitting ------------------------------------------------------------------------------------------------

    private val absence = WorkflowOut(
        id = "w1", name = "ゼミ欠席報告", channelId = "c2", canRun = true,
        fields = listOf(
            WorkflowField("報告者", "報告者", "user", required = true, default = FieldDefault("me")),
            WorkflowField("日付", "日付", "date", required = true, default = FieldDefault("today")),
            WorkflowField("内容", "報告の内容", "select", required = true, options = listOf("欠席", "遅刻"), default = FieldDefault("literal", JsonPrimitive("欠席"))),
            WorkflowField("理由", "理由", "textarea"),
        ),
        template = "*【報告者】* {{報告者}}\n*【日付】* {{日付}}\n*【理由】* {{理由}}",
    )
    private val me = "0190a1b2-0000-7000-8000-000000000001"

    @Test fun theFormStartsFromTheDevicesDate() {
        val session = WorkflowSession(absence, "c1", LocalDate.of(2026, 10, 4), me)
        assertEquals(FieldValue.Users(listOf(me)), session.values["報告者"])
        assertEquals(FieldValue.Text("2026-10-04"), session.values["日付"])
        assertEquals(FieldValue.Text("欠席"), session.values["内容"])
        assertEquals("*【報告者】* <@$me>\n*【日付】* 2026年10月4日 (日)", Workflows.renderPreview(absence.template, absence.fields, session.values))
    }

    @Test fun aRetryReusesTheSameKeyThroughTheApi() = runBlocking {
        val seen = ArrayList<Pair<String, String>>()
        var calls = 0
        val posted = wire(""", "workflow": {"id": "w1", "name": "ゼミ欠席報告"}""").replace("\"c1\"", "\"c2\"")
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val buffer = Buffer()
            request.body?.writeTo(buffer)
            seen += request.url.encodedPath to buffer.readUtf8()
            calls += 1
            when (calls) {
                1 -> throw IOException("connection reset") // the first answer is lost (it may have gone through)
                2 -> Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(400).message("stub")
                    .body("""{"error":{"code":"workflow_values_invalid","message":"x","details":{"fields":{"理由":"too_long"}}}}""".toResponseBody("application/json".toMediaType())).build()
                else -> Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("stub")
                    .body(posted.toResponseBody("application/json".toMediaType())).build()
            }
        }).build()
        val api = ApiClient("http://server", http)
        api.accessToken = "a"
        val session = WorkflowSession(absence, "c1", LocalDate.of(2026, 10, 4), me)
        val describe: (Throwable) -> String = { if (it is ApiException.Network) "network" else "refused" }

        assertNull(session.submit({ id, body -> api.submitWorkflow(id, body) }, describe))
        assertEquals("network", session.problem)
        assertNull(session.submit({ id, body -> api.submitWorkflow(id, body) }, describe))
        assertEquals(mapOf("理由" to "too_long"), session.errors) // details.fields under the field
        session.set("理由", FieldValue.Text("体調不良"))
        assertTrue(session.errors.isEmpty())
        val message = session.submit({ id, body -> api.submitWorkflow(id, body) }, describe)
        assertEquals("c2", message?.channelId)
        assertFalse(session.busy)

        assertEquals(List(3) { "/api/v1/workflows/w1/submit" }, seen.map { it.first })
        val keys = seen.map { Json.parseToJsonElement(it.second).jsonObject["client_msg_id"]!!.jsonPrimitive.content }
        assertEquals(listOf(session.clientMsgId, session.clientMsgId, session.clientMsgId), keys)
        val values = Json.parseToJsonElement(seen.last().second).jsonObject["values"]!!.jsonObject
        assertEquals(Json.parseToJsonElement("""["$me"]"""), values["報告者"])
        assertEquals(JsonPrimitive("体調不良"), values["理由"])
        // A new form is a new key.
        assertTrue(WorkflowSession(absence, "c1", LocalDate.of(2026, 10, 4), me).clientMsgId != session.clientMsgId)
    }

    @Test fun confirmDecidesWhetherChoosingItAsksFirst() = runBlocking {
        fun decode(extra: String) = Codec.snake.decodeFromString(
            WorkflowOut.serializer(),
            """{"id":"w9","name":"出勤","channel_id":"c1","template":"出勤しました","can_run":true$extra}""",
        )
        // An older server leaves it out: those always asked (the form opens).
        assertTrue(decode("").confirm)
        assertFalse(decode("").postsWithoutAsking)
        val quick = decode(""","confirm":false""")
        assertTrue(quick.postsWithoutAsking)
        val field = WorkflowField(key = "a", label = "A", type = "text")
        assertFalse(quick.copy(fields = listOf(field)).postsWithoutAsking) // something to fill: the form
        assertFalse(quick.copy(canRun = false, runBlocked = "disabled").postsWithoutAsking)

        // Posting it at once sends no values; a failure leaves the reason and the key for the form that then opens.
        val session = WorkflowSession(quick, "c1", LocalDate.of(2026, 10, 9), me)
        val keys = ArrayList<String>()
        val bodies = ArrayList<String>()
        val failed = session.submit({ _, body ->
            keys += body["client_msg_id"]!!.jsonPrimitive.content
            bodies += body["values"].toString()
            throw IOException("lost")
        }, { "network" })
        assertNull(failed)
        assertEquals("network", session.problem)
        assertEquals(listOf("{}"), bodies)
        assertEquals(listOf(session.clientMsgId), keys)
    }

    @Test fun valuesThatDoNotCheckOutAreNotSent() = runBlocking {
        val session = WorkflowSession(absence, "c1", LocalDate.of(2026, 10, 4), null) // no `me`: 報告者 is empty
        var sent = 0
        val result = session.submit({ _, _ -> sent += 1; error("not sent") }, { "x" })
        assertNull(result)
        assertEquals(0, sent)
        assertEquals(mapOf("報告者" to "required"), session.errors)
        assertEquals("入力を確認してください", session.problem)
    }

    @Test fun listAndOneWorkflowCallTheServer() = runBlocking {
        val row = """{"id":"w1","name":"ゼミ欠席報告","emoji":null,"description":"","channel_id":"c2","offered_channel_ids":["c2","c1"],
            "fields":[{"key":"日付","label":"日付","type":"date","required":true,"help":"","multiple":false,"options":[],"default":{"kind":"today"}}],
            "template":"{{日付}}","enabled":true,"created_by":"u","created_at":"","updated_at":"","can_manage":false,"can_run":false,"run_blocked":"not_a_member"}"""
        val paths = ArrayList<String>()
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            paths += request.method + " " + request.url.encodedPath
            val text = if (request.url.encodedPath.endsWith("/workflows")) "[$row]" else row
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("stub")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }).build()
        val api = ApiClient("http://server", http)
        api.accessToken = "a"
        val listed = api.channelWorkflows("c1").single()
        assertEquals("not_a_member", listed.runBlocked)
        assertEquals("today", listed.fields.single().default?.kind)
        assertFalse(api.workflow("w1").canRun)
        assertEquals(listOf("GET /api/v1/channels/c1/workflows", "GET /api/v1/workflows/w1"), paths)
    }
}
