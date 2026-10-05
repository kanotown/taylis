package jp.chikuwachat.android.ui

import android.content.res.Configuration
import android.view.KeyEvent

/**
 * T1 (MOBILE_UI.md §12): a hardware keyboard (a tablet's keyboard cover, a Bluetooth one, a Chromebook), as the desktop
 * and web clients take it: Enter sends, Shift+Enter is a new line, Ctrl+K opens 「移動・検索」. Without one (the phone's
 * on-screen keyboard) Enter stays a new line and send is the button, as before. Pure functions, tested in HardwareKeysTest.
 */
object HardwareKeys {
    enum class EnterAction {
        /** Send the draft (Enter, Ctrl+Enter). */
        SEND,
        /** A new line at the cursor (Shift+Enter). */
        NEWLINE,
        /** The key is the text field's (or the input method's) own. */
        NONE,
    }

    /** Whether a hardware keyboard is attached and usable (the configuration's, updated when one comes or goes). */
    fun attached(configuration: Configuration): Boolean =
        configuration.keyboard == Configuration.KEYBOARD_QWERTY && configuration.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO

    /**
     * What Enter does in the composer. `composing`: the input method has unconverted text (Japanese kana): Enter is its
     * (it confirms the conversion), never a send.
     */
    fun enter(hardwareKeyboard: Boolean, shift: Boolean, alt: Boolean, composing: Boolean): EnterAction = when {
        !hardwareKeyboard || composing || alt -> EnterAction.NONE
        shift -> EnterAction.NEWLINE
        else -> EnterAction.SEND
    }

    fun isEnter(keyCode: Int): Boolean = keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER

    /** Ctrl+K (⌘K on a keyboard with a Meta key, as on the desktop app): 「移動・検索」. */
    fun isJump(keyCode: Int, ctrl: Boolean, meta: Boolean, alt: Boolean, shift: Boolean): Boolean =
        keyCode == KeyEvent.KEYCODE_K && (ctrl || meta) && !alt && !shift
}
