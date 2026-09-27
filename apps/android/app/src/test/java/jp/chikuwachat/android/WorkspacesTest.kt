package jp.chikuwachat.android

import jp.chikuwachat.android.app.Workspace
import jp.chikuwachat.android.app.Workspaces
import kotlinx.coroutines.runBlocking
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

    @Test fun aRegisteredWorkspaceIsFoundByIdOrAddress() {
        val list = listOf(first, second)
        // Another URL for the same deployment (same workspace_id): one account per server.
        assertEquals(second, Workspaces.findRegistered(list, "w2", "https://chat.example.com"))
        // An entry that predates GET /server (no id yet) is matched by its address.
        val legacy = first.copy(workspaceId = null)
        assertEquals(legacy, Workspaces.findRegistered(listOf(legacy, second), "w-new", "HTTP://10.0.2.2:8000/"))
        assertNull(Workspaces.findRegistered(list, "w3", "https://other.example.com"))
        assertNull(Workspaces.findRegistered(list, null, "https://other.example.com"))
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
}
