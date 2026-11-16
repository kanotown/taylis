package jp.chikuwachat.android

import jp.chikuwachat.android.api.ServerInfoOut
import jp.chikuwachat.android.app.Workspace
import jp.chikuwachat.android.app.Workspaces
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M16c: URL rules, the saved list and its migration, duplicates and push routing (WORKSPACES.md). */
class WorkspacesTest {
    @Test fun serverUrlsAreNormalized() {
        assertEquals("https://chat.example.com", Workspaces.normalizeServerUrl("chat.example.com"))
        assertEquals("https://chat.example.com", Workspaces.normalizeServerUrl("  HTTPS://Chat.Example.COM/  "))
        assertEquals("https://chat.example.com:8443/chikuwa", Workspaces.normalizeServerUrl("https://chat.example.com:8443/chikuwa///"))
        assertEquals("https://chat.example.com", Workspaces.normalizeServerUrl("https://chat.example.com:443/?x=1#top")) // default port, query, fragment
        assertEquals("http://10.0.2.2:8000", Workspaces.normalizeServerUrl("http://10.0.2.2:8000/"))
        assertEquals("http://chat.local", Workspaces.normalizeServerUrl("http://chat.local:80"))
        assertEquals("https://[::1]:8000", Workspaces.normalizeServerUrl("https://[::1]:8000"))
        assertEquals("https://chat.example.com/Team", Workspaces.normalizeServerUrl("chat.example.com/Team/")) // the path keeps its case
        assertNull(Workspaces.normalizeServerUrl("   "))
        assertNull(Workspaces.normalizeServerUrl("ftp://chat.example.com"))
        assertNull(Workspaces.normalizeServerUrl("https://user:pw@chat.example.com"))
        assertNull(Workspaces.normalizeServerUrl("https://"))
    }

    @Test fun spellingsOfOneServerAreTheSame() {
        assertTrue(Workspaces.sameServer("HTTPS://Chat.example.com/", "https://chat.example.com"))
        assertTrue(Workspaces.sameServer("http://10.0.2.2:8000", "http://10.0.2.2:8000/"))
        assertFalse(Workspaces.sameServer("http://10.0.2.2:8000", "http://10.0.2.2:8001"))
        assertFalse(Workspaces.sameServer("http://chat.example.com", "https://chat.example.com"))
        assertEquals("chat.example.com", Workspaces.hostLabel("https://chat.example.com"))
        assertEquals("10.0.2.2:8000", Workspaces.hostLabel("http://10.0.2.2:8000"))
    }

    @Test fun tilesHaveInitialsAndAStableColour() {
        assertEquals("テ", Workspaces.initials("テストチーム"))
        assertEquals("C", Workspaces.initials("ChikuwaChat"))
        assertEquals("DT", Workspaces.initials("dev team"))
        assertEquals("DT", Workspaces.initials("dev_team"))
        assertEquals("開", Workspaces.initials(" 開発 チーム "))
        assertEquals("?", Workspaces.initials("  "))
        val colour = Workspaces.color("921b4208-6ab5-4108-9ccf-9f40c3745d29")
        assertEquals(colour, Workspaces.color("921b4208-6ab5-4108-9ccf-9f40c3745d29"))
        assertTrue(colour in Workspaces.PALETTE)
        // The desktop's hash: (h * 31 + code) mod 2^32 over the key, then the palette index.
        assertEquals(Workspaces.PALETTE[("ab".fold(0L) { h, c -> (h * 31 + c.code) and 0xffffffffL } % 8).toInt()], Workspaces.color("ab"))
        val entry = Workspace(serverUrl = "https://a", workspaceId = "w1", name = "A", username = "u")
        assertEquals("w1", Workspaces.colorKey(entry))
        assertEquals("https://a", Workspaces.colorKey(entry.copy(workspaceId = null)))
    }

    private val first = Workspace(serverUrl = "http://10.0.2.2:8000", workspaceId = "w1", name = "ChikuwaChat", username = "android1", userId = "u1")
    private val second = Workspace(serverUrl = "http://10.0.2.2:8001", workspaceId = "w2", name = "テストチーム", username = "dtuser1", userId = "u2", badge = 3, hasUnread = true)

    @Test fun theListIsSavedAndLoaded() {
        val store = MemoryStore()
        assertNull(Workspaces.load(store)) // never saved: an install older than workspaces
        Workspaces.save(store, listOf(first, second.copy(signedOut = true)), second.serverUrl)
        val saved = Workspaces.load(store)!!
        assertEquals(listOf(first, second.copy(signedOut = true)), saved.entries)
        assertEquals(second.serverUrl, saved.active)
        assertEquals(second.serverUrl, store.getString(Workspaces.ACTIVE_KEY))
        // Plain JSON under chikuwa.workspaces: no secrets, defaults left out.
        val json = store.getString(Workspaces.LIST_KEY)!!
        assertTrue(json, json.contains("\"serverUrl\":\"http://10.0.2.2:8000\"") && json.contains("\"signedOut\":true") && !json.contains("token"))
        assertFalse(json, json.contains("\"badge\":0"))

        // An active key that is not in the list falls back to the first entry; nothing saved yet means "not migrated".
        Workspaces.save(store, listOf(first), "https://gone.example.com")
        assertNull(store.getString(Workspaces.ACTIVE_KEY))
        assertEquals(first.serverUrl, Workspaces.load(store)!!.active)
        Workspaces.save(store, emptyList(), null)
        assertEquals(Workspaces.Saved(emptyList(), null), Workspaces.load(store))
        // A damaged value reads as an empty list (it was saved, so no second migration).
        assertEquals(Workspaces.Saved(emptyList(), null), Workspaces.load(MemoryStore(mapOf(Workspaces.LIST_KEY to "{broken"))))
        // Unknown fields from a newer version are ignored; entries without a server or user are dropped.
        val newer = """[{"serverUrl":"https://a.example.com","name":"A","username":"alice","colour":"red"},{"serverUrl":"","name":"B","username":"b"}]"""
        assertEquals(listOf(Workspace(serverUrl = "https://a.example.com", name = "A", username = "alice")), Workspaces.load(MemoryStore(mapOf(Workspaces.LIST_KEY to newer)))!!.entries)
    }

    @Test fun anOlderInstallBecomesOneWorkspaceSpelledAsSaved() {
        // The exact string stays: it names the stored refresh token (server|username) and the local database.
        val migrated = Workspaces.migrate("http://10.0.2.2:8000", "android1", hasSession = true)
        assertEquals(listOf(Workspace(serverUrl = "http://10.0.2.2:8000", name = "10.0.2.2:8000", username = "android1")), migrated.entries)
        assertEquals("http://10.0.2.2:8000", migrated.active)
        val odd = Workspaces.migrate("HTTPS://Chat.Example.com", "alice", hasSession = true)
        assertEquals("HTTPS://Chat.Example.com", odd.entries.single().serverUrl)
        assertEquals("chat.example.com", odd.entries.single().name)
        // Signed out before the update (no token), or nothing saved: nothing to move over.
        assertEquals(Workspaces.Saved(emptyList(), null), Workspaces.migrate("http://10.0.2.2:8000", "android1", hasSession = false))
        assertEquals(Workspaces.Saved(emptyList(), null), Workspaces.migrate("http://10.0.2.2:8000", "", hasSession = true))
        assertEquals(Workspaces.Saved(emptyList(), null), Workspaces.migrate(null, null, hasSession = false))
    }

    @Test fun aRegisteredWorkspaceIsFoundByItsAddressOnly() {
        val list = listOf(first, second)
        assertEquals(first, Workspaces.findRegistered(list, "HTTP://10.0.2.2:8000/"))
        assertEquals(first.copy(workspaceId = null), Workspaces.findRegistered(listOf(first.copy(workspaceId = null), second), "http://10.0.2.2:8000"))
        // 2026-11-16: another URL is another workspace, whatever workspace_id its server claims.
        assertNull(Workspaces.findRegistered(list, "https://chat.example.com"))
        assertNull(Workspaces.findRegistered(list, "https://10.0.2.2:8000")) // the scheme too
    }

    private fun info(id: String, name: String, icon: String? = null) =
        ServerInfoOut(product = Workspaces.PRODUCT, workspaceId = id, name = name, iconVersionJson = icon?.let { JsonPrimitive(it) } ?: JsonNull)

    /**
     * The exploit of the 2026-11-16 review: a hostile server A claims B's workspace_id; A signs out; the user adds B. The
     * password, the code and Google's start used to go to A's URL (the entry with B's id). They go to B's URL, B becomes
     * an entry of its own, and A's entry is untouched.
     */
    @Test fun aServerClaimingAnotherOnesIdNeverGetsItsCredentials() {
        val b = "https://b.example.com"
        val a = Workspace(serverUrl = "https://a.example.com", workspaceId = "id-of-b", name = "B (fake)", username = "alice", userId = "ua", session = "s0")
        // A signs out (its entry stays so that signing back in is one step).
        var list = listOf(a.copy(signedOut = true))
        val signedOutA = list.single()
        // Adding B (its GET /server answers id-of-b): the sign-in goes to B's own URL.
        assertEquals(Workspaces.SignIn.At(b), Workspaces.signInTarget(list, b, adding = true, activeKey = a.serverUrl))
        assertEquals(Workspaces.SignIn.At(b), Workspaces.signInTarget(list, b, adding = false, activeKey = a.serverUrl))
        list = Workspaces.signedIn(list, b, "bob", "ub", info("id-of-b", "B"), "s1")
        assertEquals(listOf(signedOutA, Workspace(serverUrl = b, workspaceId = "id-of-b", name = "B", username = "bob", userId = "ub", session = "s1")), list)
        // Signing back in to A goes to A (its own address), never to B, and does not touch B's entry.
        assertEquals(Workspaces.SignIn.At(a.serverUrl), Workspaces.signInTarget(list, "https://A.example.com/", adding = false, activeKey = a.serverUrl))
        val again = Workspaces.signedIn(list, a.serverUrl, "alice", "ua", info("id-of-c", "C (fake)"), "s2")
        assertEquals(list[1], again[1])
        assertEquals("id-of-b", again[0].workspaceId) // the first id recorded stays
        assertEquals("C (fake)", again[0].name) // A's own name, in A's own entry
        // Typing B's address again while B is signed in opens B (one account per server).
        assertEquals(Workspaces.SignIn.Open(list[1]), Workspaces.signInTarget(list, b, adding = true, activeKey = a.serverUrl))
    }

    @Test fun serverInfoCannotChangeAStoredWorkspaceId() {
        val entry = first.copy(iconVersion = "1")
        // Another id later (a hostile server, or a restore): the first one stays; the name and icon follow the server.
        assertEquals(entry.copy(name = "改名", iconVersion = "2"), Workspaces.withServerInfo(entry, info("w-other", "改名", "2")))
        // An entry that predates GET /server learns its id once.
        assertEquals("w-new", Workspaces.withServerInfo(entry.copy(workspaceId = null), info("w-new", "A")).workspaceId)
        assertNull(Workspaces.withServerInfo(entry.copy(workspaceId = null), info("", "A")).workspaceId)
        // A blank name keeps the saved one; a server before M93 (no icon_version) keeps the saved icon.
        val older = ServerInfoOut(product = Workspaces.PRODUCT, workspaceId = "w1", name = " ")
        assertEquals(entry, Workspaces.withServerInfo(entry, older.copy(name = "")))
        assertEquals("1", Workspaces.withServerInfo(entry, older).iconVersion)
    }

    @Test fun pushesGoToTheirWorkspace() = runBlocking {
        val list = listOf(first, second)
        val lookups = ArrayList<String>()
        val stores = mapOf(first.serverUrl to setOf("c1"), second.serverUrl to setOf("c2"))
        val has: suspend (Workspace, String) -> Boolean = { entry, channel -> lookups.add(entry.serverUrl); channel in stores[entry.serverUrl].orEmpty() }
        // workspace_id decides.
        assertEquals(second, Workspaces.route(list, first.serverUrl, "w2", "c1", has))
        assertTrue(lookups.isEmpty())
        // Unknown id (older server, restored backup): the workspace whose store has the channel, the active one asked first.
        assertEquals(second, Workspaces.route(list, first.serverUrl, "w9", "c2", has))
        assertEquals(listOf(first.serverUrl, second.serverUrl), lookups)
        assertEquals(second, Workspaces.route(list, first.serverUrl, null, "c2", has))
        // Nobody has it: the active one.
        assertEquals(first, Workspaces.route(list, first.serverUrl, null, "c404", has))
        assertEquals(second, Workspaces.route(list, second.serverUrl, null, null, has))
        // Signed out on this device: nothing is shown, even for a matching id.
        val out = listOf(first, second.copy(signedOut = true))
        assertNull(Workspaces.route(out, first.serverUrl, "w2", "c2", has))
        assertNull(Workspaces.route(out, second.serverUrl, null, "c404", has))
        assertNull(Workspaces.route(emptyList(), null, "w1", "c1", has))
    }

    /**
     * 2026-11-16 (WORKSPACES.md §7): an id that two entries have (a server claims another one's) decides nothing: the push
     * stays with the active workspace, so its tap does not switch, even when another one's store has the channel.
     */
    @Test fun aDuplicatedIdDoesNotSwitch() = runBlocking {
        val impostor = second.copy(serverUrl = "https://evil.example.com", workspaceId = "w1", name = "Fake")
        val third = Workspace(serverUrl = "https://c.example.com", workspaceId = "w3", name = "C", username = "c", userId = "u3")
        val list = listOf(first, impostor, third)
        val stores = mapOf(first.serverUrl to setOf("c1"), impostor.serverUrl to setOf("c1"), third.serverUrl to setOf("c3"))
        val has: suspend (Workspace, String) -> Boolean = { entry, channel -> channel in stores[entry.serverUrl].orEmpty() }
        assertEquals(third, Workspaces.route(list, third.serverUrl, "w1", "c1", has))
        assertEquals(impostor, Workspaces.route(list, impostor.serverUrl, "w1", "c1", has))
        assertEquals(first, Workspaces.route(list, first.serverUrl, "w1", null, has))
        // The active one signed out: nothing is shown.
        assertNull(Workspaces.route(list.map { if (it == third) it.copy(signedOut = true) else it }, third.serverUrl, "w1", "c1", has))
        // A unique id still decides.
        assertEquals(third, Workspaces.route(list, first.serverUrl, "w3", "c1", has))
    }
}
