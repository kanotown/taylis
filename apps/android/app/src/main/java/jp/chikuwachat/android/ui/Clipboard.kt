package jp.chikuwachat.android.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle

/**
 * 2026-10-08: what every copy button does. Android 13 (API 33) and later confirm a copy themselves (the clipboard's
 * overlay with a preview), so, as Android's guidance asks, the app says nothing more there; on Android 12L and earlier
 * nothing would show, so the app's snackbar says 「コピーしました」 (or what was copied).
 */
object CopyFeedback {
    /** Whether the app should confirm a copy itself on this Android version. */
    fun appConfirms(sdkInt: Int): Boolean = sdkInt <= Build.VERSION_CODES.S_V2

    /**
     * [text] onto the clipboard. A secret (a URL that works by itself, recovery codes) is marked sensitive, so Android
     * 13+ hides it in the overlay's preview. Whether the app should say so itself ([appConfirms]); false when the
     * clipboard is not there.
     */
    fun copy(context: Context, text: String, label: String = "Taylis", sensitive: Boolean = false): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return false
        val clip = ClipData.newPlainText(label, text)
        if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        clipboard.setPrimaryClip(clip)
        return appConfirms(Build.VERSION.SDK_INT)
    }
}
