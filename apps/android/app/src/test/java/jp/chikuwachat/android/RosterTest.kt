package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.BootstrapOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.LabProfileOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.Roster
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The lab roster (M23, DATA_MODEL.md lab_profiles): order and labels shared with the server and desktop, wire and sync. */
class RosterTest {
    private fun person(id: String, name: String) = UserPublic(id, id, name, "member", createdAt = "", updatedAt = "")

    private fun line(user: UserPublic, affiliation: String = "student", rank: String? = null, grade: String? = null, supervisorId: String? = null, researchTopic: String? = null, reading: String? = null) =
        LabProfileOut(user.id, affiliation, rank, grade, supervisorId, researchTopic, reading, updatedAt = "2026-09-28T00:00:00Z")

    @Test fun ordersFacultyByRankStudentsFromD3DownOthersAlumniThenPeopleOffTheRoster() {
        // The same people and order as the server's test_the_roster_orders_people_and_keeps_the_grade_groups and the
        // desktop's roster.test.ts.
        val prof = person("prof", "Prof")
        val assoc = person("assoc", "Assoc")
        val doc = person("doc", "Doc")
        val m1a = person("m1a", "M1a")
        val m1b = person("m1b", "M1b")
        val four = person("four", "Four")
        val old = person("old", "Old")
        val guest = person("guest", "Guest")
        val roster = listOf(
            line(prof, "faculty", rank = "professor"),
            line(assoc, "faculty", rank = "associate_professor"),
            line(doc, grade = "D1", supervisorId = prof.id),
            line(m1a, grade = "M1", reading = "いとう"),
            line(m1b, grade = "M1", reading = "あおき"),
            line(four, grade = "B4"),
            line(old, "alumni"),
        ).associateBy { it.userId }
        val sorted = listOf(guest, old, four, m1a, m1b, doc, assoc, prof).sortedWith { a, b -> Roster.compare(a, b, roster) }
        assertEquals(listOf("prof", "assoc", "doc", "m1b", "m1a", "four", "old", "guest"), sorted.map { it.id })

        assertEquals("准教授", Roster.label(roster.getValue("assoc")))
        assertEquals("教員", Roster.section(roster["assoc"]))
        assertEquals("M1", Roster.section(roster["m1a"]))
        assertEquals("卒業生", Roster.section(roster["old"]))
        assertNull(Roster.section(null))
        assertEquals("D1 · 指導教員: Prof", Roster.summary(roster.getValue("doc"), mapOf(prof.id to prof)))
        assertEquals("D1", Roster.summary(roster.getValue("doc"), emptyMap())) // the supervisor not known here
    }

    @Test fun labelsSectionsAndValuesFromANewerServer() {
        val someone = person("x", "X")
        assertEquals("教授", Roster.label(line(someone, "faculty", rank = "professor")))
        assertEquals("助教", Roster.label(line(someone, "faculty", rank = "assistant_professor")))
        assertEquals("教員", Roster.label(line(someone, "faculty")))
        assertEquals("学生", Roster.label(line(someone)))
        assertEquals("B3", Roster.label(line(someone, grade = "B3")))
        assertEquals("その他", Roster.label(line(someone, "other")))
        assertEquals("卒業生", Roster.label(line(someone, "alumni")))
        assertEquals("学生", Roster.section(line(someone)))
        assertEquals("その他", Roster.section(line(someone, "other")))
        // An affiliation this app does not know: no label or heading, sorted after the alumni but before people off the roster.
        assertEquals("", Roster.label(line(someone, "visitor")))
        assertNull(Roster.section(line(someone, "visitor")))
        val alumnus = person("a", "A")
        val visitor = person("v", "V")
        val outsider = person("o", "O")
        val roster = mapOf(alumnus.id to line(alumnus, "alumni"), visitor.id to line(visitor, "visitor"))
        assertEquals(listOf("a", "v", "o"), listOf(outsider, visitor, alumnus).sortedWith { a, b -> Roster.compare(a, b, roster) }.map { it.id })
        // An unknown rank or grade comes after the known ones of its affiliation.
        val lecturer = person("l", "L")
        val newRank = person("n", "N")
        val b3 = person("b3", "B")
        val newGrade = person("g", "G")
        val more = mapOf(
            lecturer.id to line(lecturer, "faculty", rank = "lecturer"), newRank.id to line(newRank, "faculty", rank = "emeritus"),
            b3.id to line(b3, grade = "B3"), newGrade.id to line(newGrade, grade = "B2"),
        )
        assertEquals(listOf("l", "n", "b3", "g"), listOf(newGrade, b3, newRank, lecturer).sortedWith { a, b -> Roster.compare(a, b, more) }.map { it.id })
    }

    @Test fun namesCompareByCodePointLikeTheServer() {
        // U+FF71 (ｱ) before U+2000B (𠀋) as in Python; String.compareTo (UTF-16 units) would put the surrogate pair first.
        assertTrue(Roster.compareCodePoints("ｱ", "𠀋") < 0)
        assertTrue("ｱ" > "𠀋")
        assertTrue(Roster.compareCodePoints("あお", "あおき") < 0)
        assertEquals(0, Roster.compareCodePoints("加納", "加納"))
        // Same reading: the username decides; no reading: the display name stands in.
        val a = person("aa", "Z")
        val b = person("bb", "Y")
        val c = person("cc", "かとう")
        val roster = mapOf(a.id to line(a, grade = "M2", reading = "かとう"), b.id to line(b, grade = "M2", reading = "かとう"), c.id to line(c, grade = "M2"))
        assertEquals(listOf("aa", "bb", "cc"), listOf(c, b, a).sortedWith { x, y -> Roster.compare(x, y, roster) }.map { it.id })
    }

    @Test fun listsPutTheRosterFirstThenTheirOwnOrderUnderHeadings() {
        val prof = person("prof", "Prof")
        val m1 = person("m1", "M")
        val m1too = person("m1too", "N")
        val zed = person("zed", "Zed")
        val amy = person("amy", "Amy")
        val roster = mapOf(prof.id to line(prof, "faculty", rank = "professor"), m1.id to line(m1, grade = "M1"), m1too.id to line(m1too, grade = "M1"))
        val sorted = listOf(zed, m1too, amy, m1, prof).sortedWith(Roster.listOrder(roster, compareBy { it.displayName }))
        assertEquals(listOf("prof", "m1", "m1too", "amy", "zed"), sorted.map { it.id })
        assertEquals(
            listOf("教員" to listOf("prof"), "M1" to listOf("m1", "m1too"), Roster.OFF_ROSTER to listOf("amy", "zed")),
            Roster.sections(sorted, roster).map { (heading, people) -> heading to people.map { it.id } },
        )
        assertEquals(listOf(Roster.OFF_ROSTER to listOf("amy")), Roster.sections(listOf(amy), emptyMap()).map { (h, p) -> h to p.map { it.id } })
    }

    @Test fun bootstrapAndGroupsDecodeWithAndWithoutTheM23Fields() {
        val server = FakeServer()
        val alice = server.addUser("alice")
        server.roster[alice.id] = line(alice, "faculty", rank = "professor", researchTopic = "音声合成")
        val encoded = Codec.snake.encodeToJsonElement(BootstrapOut.serializer(), server.bootstrap(alice.id)).jsonObject
        assertEquals("音声合成", Codec.snake.decodeFromJsonElement(BootstrapOut.serializer(), encoded).roster.single().researchTopic)
        // A server before M23 sends no `roster`.
        val older = JsonObject(encoded.filterKeys { it != "roster" })
        assertTrue(Codec.snake.decodeFromJsonElement(BootstrapOut.serializer(), older).roster.isEmpty())

        // The server's shape: explicit nulls, and a value this app does not know yet.
        val wire = """{"user_id": "u1", "affiliation": "student", "rank": null, "grade": "M1", "supervisor_id": null,
            "research_topic": null, "reading": "かのう", "updated_at": "2026-09-28T00:00:00Z"}"""
        val row = Codec.snake.decodeFromString(LabProfileOut.serializer(), wire)
        assertEquals(listOf("M1", "かのう"), listOf(row.grade, row.reading))
        assertNull(row.rank)
        assertEquals("visitor", Codec.snake.decodeFromString(LabProfileOut.serializer(), wire.replace("\"student\"", "\"visitor\"")).affiliation)

        val group = """{"id": "g1", "name": "m1", "description": null, "member_ids": ["u1"], "created_by": "u0",
            "created_at": "2026-09-28T00:00:00Z", "updated_at": "2026-09-28T00:00:00Z" """
        assertTrue(Codec.snake.decodeFromString(GroupOut.serializer(), "$group, \"managed\": true}").managed)
        assertFalse(Codec.snake.decodeFromString(GroupOut.serializer(), "$group}").managed)
    }

    @Test fun theEngineLoadsTheRosterFromBootstrapAndFollowsRosterUpdated() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        server.createChannel("general", alice.id)
        server.roster[bob.id] = line(bob, grade = "M1")
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(alice.id), server.connector(alice.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        suspend fun settle() = repeat(20) { engine.idle(); yield() }
        engine.start(); settle()
        assertEquals("M1", store.roster[bob.id]?.grade)
        server.setRosterLine(bob.id, line(bob, grade = "M2", researchTopic = "音声合成")); settle()
        assertEquals(listOf("M2", "音声合成"), listOf(store.roster[bob.id]?.grade, store.roster[bob.id]?.researchTopic))
        server.setRosterLine(alice.id, line(alice, "faculty", rank = "professor")); settle()
        assertEquals(setOf(alice.id, bob.id), store.roster.keys)
        server.setRosterLine(bob.id, null); settle()
        assertFalse(bob.id in store.roster)
        engine.stop(); scope.cancel()
    }

    @Test fun myLineIsSavedWithExplicitNulls() = runBlocking {
        var sent = ""
        var path = ""
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            path = request.method + " " + request.url.encodedPath
            val buffer = okio.Buffer(); request.body?.writeTo(buffer); sent = buffer.readUtf8()
            val body = """{"user_id": "u1", "affiliation": "student", "rank": null, "grade": "M1", "supervisor_id": null,
                "research_topic": "音声合成", "reading": null, "updated_at": "2026-09-28T00:00:00Z"}"""
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("ok").body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()
        val client = ApiClient("http://server", http)
        client.accessToken = "a"
        val saved = client.updateMyRosterLine("音声合成", null)
        assertEquals("PATCH /api/v1/lab/roster/me", path)
        // A null must reach the server as null: an omitted field would keep the old reading.
        assertEquals("""{"research_topic":"音声合成","reading":null}""", sent)
        assertEquals("音声合成", saved.researchTopic)
    }
}
