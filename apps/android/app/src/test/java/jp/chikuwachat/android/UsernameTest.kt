package jp.chikuwachat.android

import jp.chikuwachat.android.app.Workspace
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.ui.UsernameRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M96: usernames can change — the screen's checks (the server's rules) and the saved workspace's sign-in name. */
class UsernameTest {
    @Test fun aUsernameIsCheckedAsTheServerDoes() {
        assertNull(UsernameRules.problem("alice.k"))
        assertNull(UsernameRules.problem("a_b-c.9"))
        assertNull(UsernameRules.problem(" Alice ")) // sent as "alice"
        assertEquals("alice.k", UsernameRules.normalize("  Alice.K "))
        assertEquals("ユーザー名を入力してください", UsernameRules.problem(""))
        assertEquals("3〜32 文字にしてください", UsernameRules.problem("ab"))
        assertEquals("3〜32 文字にしてください", UsernameRules.problem("x".repeat(33)))
        assertEquals("使えるのは a-z、0-9、. _ - だけです", UsernameRules.problem("has space"))
        assertEquals("使えるのは a-z、0-9、. _ - だけです", UsernameRules.problem("かのうさん"))
        for (reserved in listOf("here", "channel", "everyone", "all", "group", "deleted-0123abcd")) {
            assertEquals(reserved, "このユーザー名は予約されているため使えません", UsernameRules.problem(reserved))
        }
        assertTrue(UsernameRules.hint(hasPassword = true).contains("パスワードでのログインには新しいユーザー名を使います"))
        assertFalse(UsernameRules.hint(hasPassword = false).contains("パスワード"))
    }

    @Test fun theSavedWorkspaceShowsTheNewNameAndKeepsTheOldKey() {
        val entry = Workspace(serverUrl = "https://chat.example.com", name = "Lab", username = "alice", userId = "u1")
        assertEquals("alice", entry.signInName)
        val renamed = entry.copy(loginName = "alice.k")
        assertEquals("alice.k", renamed.signInName)
        assertEquals("alice", renamed.username) // still names the refresh token and the local database
        val store = MemoryStore()
        Workspaces.save(store, listOf(renamed), renamed.serverUrl)
        assertEquals(listOf(renamed), Workspaces.load(store)!!.entries)
        // A list saved before M96 has no loginName.
        val old = """[{"serverUrl":"https://a.example.com","name":"A","username":"alice"}]"""
        assertNull(Workspaces.load(MemoryStore(mapOf(Workspaces.LIST_KEY to old)))!!.entries.single().loginName)
    }
}
