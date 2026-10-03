package jp.chikuwachat.android

import jp.chikuwachat.android.ui.Totp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TotpTest {
    @Test fun normalisesAndRecognisesAppCodes() {
        assertEquals("123456", Totp.normalize(" 123 456 "))
        assertTrue(Totp.isCode("123 456"))
        assertFalse(Totp.isCode("abcde-fghjk"))
        assertFalse(Totp.isCode("12345"))
    }

    @Test fun explainsFailuresInWords() {
        assertEquals("認証コードが違います", Totp.errorText("invalid_totp"))
        assertEquals("パスワードが違います", Totp.errorText("invalid_password"))
        assertNull(Totp.errorText("server_error"))
    }

    @Test fun formatsRecoveryCodesForTheClipboard() {
        assertEquals("taylis の回復コード (各 1 回だけ使えます)\n\nabcde-fghjk\nmnpqr-stuvw", Totp.recoveryCodesText(listOf("abcde-fghjk", "mnpqr-stuvw")))
    }
}
