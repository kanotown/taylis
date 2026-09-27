package jp.chikuwachat.android

import jp.chikuwachat.android.ui.Invite
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InviteTest {
    private val token = "Zy9_-abcdefghijklmnopqrstuvwxyz0123456789ABC"

    @Test fun buildsWithoutDoublingSlashes() {
        assertEquals("https://chat.example.com/invite/$token", Invite.url("https://chat.example.com/", token))
        assertEquals("http://10.0.2.2:8000/invite/$token", Invite.url("http://10.0.2.2:8000", token))
    }

    @Test fun parsesAPastedLinkIntoServerAndToken() {
        assertEquals(Invite.Target("https://chat.example.com", token), Invite.parse("  https://chat.example.com/invite/$token?utm=1 "))
        assertEquals(Invite.Target("http://10.0.2.2:8000", token), Invite.parse("http://10.0.2.2:8000/invite/$token/"))
        assertNull(Invite.parse("https://chat.example.com/invite/short"))
        assertNull(Invite.parse("https://chat.example.com/m/$token"))
        assertNull(Invite.parse(token))
    }

    @Test fun explainsInviteFailuresInWords() {
        assertEquals("この招待リンクは期限切れです", Invite.errorText("invite_expired"))
        assertEquals("このユーザー名はすでに使われています", Invite.errorText("username_taken"))
        assertNull(Invite.errorText("server_error"))
    }
}
