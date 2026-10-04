package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ServerInfoOut
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.app.Workspace
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.platform.WorkspaceIconCache
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M93 on Android (WORKSPACES.md §3.4.1): the workspace icon's version, where it is saved, and its picture. */
class WorkspaceIconTest {
    private val realDecode = WorkspaceIconCache.decode

    @After fun tearDown() {
        WorkspaceIconCache.reset()
        WorkspaceIconCache.fetcher = null
        WorkspaceIconCache.scope = null
        WorkspaceIconCache.decode = realDecode
    }

    @Test fun serverInfoTellsAMissingIconVersionFromNone() {
        val with = Codec.snake.decodeFromString(ServerInfoOut.serializer(), """{"product":"chikuwachat","workspace_id":"w1","name":"加納研究室","icon_version":"0192abc"}""")
        assertEquals("0192abc", with.iconVersion)
        assertTrue(with.knowsIcon)
        val none = Codec.snake.decodeFromString(ServerInfoOut.serializer(), """{"product":"chikuwachat","workspace_id":"w1","name":"A","icon_version":null}""")
        assertNull(none.iconVersion)
        assertTrue(none.knowsIcon)
        val old = Codec.snake.decodeFromString(ServerInfoOut.serializer(), """{"product":"chikuwachat","workspace_id":"w1","name":"A"}""")
        assertNull(old.iconVersion)
        assertFalse(old.knowsIcon) // a server before M93: the saved version stays
    }

    @Test fun workspaceSettingsCarryTheIconVersion() {
        val settings = Codec.snake.decodeFromString(WorkspaceSettingsOut.serializer(), """{"show_membership_messages":true,"preview_before_join":true,"icon_version":"v2"}""")
        assertEquals("v2", settings.iconVersion)
        assertTrue(Codec.snake.decodeFromString(WorkspaceSettingsOut.serializer(), """{"icon_version":null}""").knowsIcon)
        assertFalse(Codec.snake.decodeFromString(WorkspaceSettingsOut.serializer(), "{}").knowsIcon)
    }

    @Test fun storeReportsTheIconOnlyWhenTheServerSendsIt() {
        val store = Store()
        val seen = mutableListOf<String?>()
        store.onWorkspaceIcon = { seen += it }
        store.setWorkspaceSettings(WorkspaceSettingsOut(iconVersionJson = JsonPrimitive("v1"))) // bootstrap
        store.setWorkspaceSettings(WorkspaceSettingsOut(iconVersionJson = kotlinx.serialization.json.JsonNull)) // removed
        store.setWorkspaceSettings(WorkspaceSettingsOut()) // a server before M93
        assertEquals(listOf("v1", null), seen)
    }

    @Test fun theIconVersionIsSavedWithTheWorkspace() {
        val store = MemoryStore()
        val entry = Workspace(serverUrl = "https://a.example.com", workspaceId = "w1", name = "A", username = "alice", iconVersion = "v3")
        Workspaces.save(store, listOf(entry), entry.serverUrl)
        assertEquals("v3", Workspaces.load(store)!!.entries.first().iconVersion)
    }

    @Test fun theIconPathCarriesTheVersion() {
        assertEquals("/api/v1/server/icon?v=0192-abc", ApiClient.serverIconPath("0192-abc"))
        assertEquals("/api/v1/server/icon?v=a%26b%3Dc", ApiClient.serverIconPath("a&b=c"))
    }

    @Test fun eachVersionIsFetchedOnceWithoutSigningIn() = runBlocking {
        val asked = mutableListOf<String>()
        WorkspaceIconCache.fetcher = { server, version -> asked += "$server|$version"; ByteArray(1) }
        WorkspaceIconCache.decode = { null } // no Android graphics here: a picture that does not decode keeps the letter
        WorkspaceIconCache.scope = this
        assertNull(WorkspaceIconCache.image("https://a.example.com", null)) // no icon: nothing fetched
        assertNull(WorkspaceIconCache.image("https://a.example.com", "v1"))
        assertNull(WorkspaceIconCache.image("https://a.example.com", "v1")) // loading: not twice
        repeat(20) { delay(10) }
        assertNull(WorkspaceIconCache.image("https://a.example.com", "v1")) // failed: not again until a new version
        assertNull(WorkspaceIconCache.image("https://a.example.com", "v2")) // an admin changed it
        repeat(20) { delay(10) }
        assertEquals(listOf("https://a.example.com|v1", "https://a.example.com|v2"), asked)
    }
}
