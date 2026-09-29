package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.InviteLabPreview
import jp.chikuwachat.android.api.InvitePreviewOut
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

    @Test fun decodesTheLabPresetAndItsAbsence() { // M32
        val base = """"invited_by":"Root","role":"member","channels":["general"],"expires_at":"2026-10-04T00:00:00Z","password_min_length":8"""
        assertNull(Codec.snake.decodeFromString(InvitePreviewOut.serializer(), "{$base}").lab) // an older server
        assertNull(Codec.snake.decodeFromString(InvitePreviewOut.serializer(), "{$base,\"lab\":null}").lab)
        val lab = Codec.snake.decodeFromString(
            InvitePreviewOut.serializer(),
            """{$base,"lab":{"affiliation":"student","rank":null,"grade":"B4","supervisor_name":"加納","times":true}}""",
        ).lab
        assertEquals(InviteLabPreview("student", null, "B4", "加納", true), lab)
    }

    @Test fun saysWhatTheLabPresetDoes() { // M32
        assertEquals(
            "研究室の名簿に 学生 (B4)・指導教員 加納 として載ります。times を作ります。",
            Invite.labText(InviteLabPreview("student", grade = "B4", supervisorName = "加納", times = true)),
        )
        assertEquals("研究室の名簿に 教員 (准教授) として載ります。", Invite.labText(InviteLabPreview("faculty", rank = "associate_professor")))
        assertEquals("研究室の名簿に 教員 として載ります。", Invite.labText(InviteLabPreview("faculty")))
        assertEquals("研究室の名簿に 学生 として載ります。times を作ります。", Invite.labText(InviteLabPreview("student", times = true)))
        assertEquals("研究室の名簿に 卒業生 として載ります。", Invite.labText(InviteLabPreview("alumni")))
        assertEquals("研究室の名簿に その他・指導教員 加納 として載ります。", Invite.labText(InviteLabPreview("other", supervisorName = "加納")))
        assertEquals("研究室の名簿に載ります。", Invite.labText(InviteLabPreview("visitor"))) // a newer server's value
    }
}
