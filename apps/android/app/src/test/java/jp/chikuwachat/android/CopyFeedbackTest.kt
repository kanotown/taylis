package jp.chikuwachat.android

import jp.chikuwachat.android.ui.CopyFeedback
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 2026-10-08: Android 13+ confirms a copy itself; the app's snackbar only on 12L and earlier (Android's guidance). */
class CopyFeedbackTest {
    @Test fun theAppConfirmsOnlyBeforeAndroid13() {
        assertTrue(CopyFeedback.appConfirms(26)) // minSdk
        assertTrue(CopyFeedback.appConfirms(31)) // 12
        assertTrue(CopyFeedback.appConfirms(32)) // 12L
        assertFalse(CopyFeedback.appConfirms(33)) // 13: the system's overlay
        assertFalse(CopyFeedback.appConfirms(36))
    }
}
