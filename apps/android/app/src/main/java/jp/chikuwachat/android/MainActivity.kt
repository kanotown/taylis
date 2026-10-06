package jp.chikuwachat.android

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.KeyboardShortcutInfo
import android.view.Menu
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.ui.AppRoot
import jp.chikuwachat.android.ui.ChikuwaTheme
import jp.chikuwachat.android.ui.HardwareKeys

class MainActivity : ComponentActivity() {
    private val controller get() = (application as ChikuwaApp).controller

    /** Before Android 13 the chosen UI language is applied here (AppLanguage); from 13 the system does it. */
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLanguage.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controller.languageMayHaveChanged()
        val recreate = { if (Build.VERSION.SDK_INT < 33) recreate() }
        languageRecreate = recreate
        controller.languageRecreate = recreate
        enableEdgeToEdge()
        // A tapped notification opens its conversation once: a rotation or a restore after process death
        // re-delivers the same intent, and a launch from Recents replays the old one.
        val fromHistory = (intent?.flags ?: 0) and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) takeConversation(intent)
        // A restore after process death may carry the browser's return; a rotation finds its data cleared.
        if (!fromHistory) takeSsoReturn(intent)
        // The notification permission is asked once the main screen is up (MainScreen, M28c), not at every start.
        setContent {
            // M100: text emoji pills are drawn for the look in effect (the setting or the system's).
            val dark = controller.appearance.isDark(isSystemInDarkTheme())
            LaunchedEffect(dark) { controller.textEmojiDark = dark }
            ChikuwaTheme(controller.appearance) { AppRoot(controller) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeConversation(intent)
        takeSsoReturn(intent)
    }

    /**
     * M48: the browser's return from Google sign-in (`chikuwachat://sso?…`). singleTask brings this activity back and
     * closes the Custom Tab above it; after process death the link arrives here too. The controller ignores a return
     * when no sign-in is pending (a replay).
     */
    private fun takeSsoReturn(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.dataString ?: return
        intent.data = null
        controller.handleSsoCallback(data)
    }

    private fun takeConversation(intent: Intent?) {
        // M56: a task's notification opens the task (a personal one has no conversation).
        val taskId = intent?.getStringExtra(Notifier.EXTRA_TASK_ID)
        if (taskId != null) {
            val channel = intent.getStringExtra(Notifier.EXTRA_CHANNEL_ID)
            val workspace = intent.getStringExtra(Notifier.EXTRA_WORKSPACE)
            intent.removeExtra(Notifier.EXTRA_TASK_ID)
            intent.removeExtra(Notifier.EXTRA_CHANNEL_ID)
            intent.removeExtra(Notifier.EXTRA_WORKSPACE)
            controller.openTaskFromNotification(workspace, channel, taskId)
            return
        }
        // M112: a reservation notice opens 「予約」.
        if (intent?.getBooleanExtra(Notifier.EXTRA_RESERVATIONS, false) == true) {
            val workspace = intent.getStringExtra(Notifier.EXTRA_WORKSPACE)
            intent.removeExtra(Notifier.EXTRA_RESERVATIONS)
            intent.removeExtra(Notifier.EXTRA_WORKSPACE)
            controller.openReservationsFromNotification(workspace)
            return
        }
        // M122: a page's notification (a mention, a page shared with me) opens the page on the home tab.
        val pageId = intent?.getStringExtra(Notifier.EXTRA_PAGE_ID)
        if (pageId != null) {
            val workspace = intent.getStringExtra(Notifier.EXTRA_WORKSPACE)
            intent.removeExtra(Notifier.EXTRA_PAGE_ID)
            intent.removeExtra(Notifier.EXTRA_WORKSPACE)
            controller.openPageFromNotification(workspace, pageId)
            return
        }
        // M73: a canvas mention's notification opens the canvas in its conversation's 「キャンバス」 tab.
        val canvasId = intent?.getStringExtra(Notifier.EXTRA_CANVAS_ID)
        val canvasChannel = intent?.getStringExtra(Notifier.EXTRA_CHANNEL_ID)
        if (canvasId != null && canvasChannel != null) {
            val workspace = intent.getStringExtra(Notifier.EXTRA_WORKSPACE)
            intent.removeExtra(Notifier.EXTRA_CANVAS_ID)
            intent.removeExtra(Notifier.EXTRA_CHANNEL_ID)
            intent.removeExtra(Notifier.EXTRA_WORKSPACE)
            controller.openCanvasFromNotification(workspace, canvasChannel, canvasId)
            return
        }
        // M52: a calendar alarm's notification opens its event (my own calendar's has no conversation).
        val eventId = intent?.getStringExtra(Notifier.EXTRA_EVENT_ID)
        if (eventId != null) {
            val channel = intent.getStringExtra(Notifier.EXTRA_CHANNEL_ID)
            val workspace = intent.getStringExtra(Notifier.EXTRA_WORKSPACE)
            intent.removeExtra(Notifier.EXTRA_EVENT_ID)
            intent.removeExtra(Notifier.EXTRA_CHANNEL_ID)
            intent.removeExtra(Notifier.EXTRA_WORKSPACE)
            controller.openEventFromNotification(workspace, channel, eventId)
            return
        }
        val channelId = intent?.getStringExtra(Notifier.EXTRA_CHANNEL_ID) ?: return
        val workspace = intent.getStringExtra(Notifier.EXTRA_WORKSPACE)
        val messageId = intent.getStringExtra(Notifier.EXTRA_MESSAGE_ID)
        val parentId = intent.getStringExtra(Notifier.EXTRA_PARENT_ID)
        val reveal = intent.getBooleanExtra(Notifier.EXTRA_REVEAL, false)
        intent.removeExtra(Notifier.EXTRA_CHANNEL_ID)
        intent.removeExtra(Notifier.EXTRA_WORKSPACE)
        intent.removeExtra(Notifier.EXTRA_MESSAGE_ID)
        intent.removeExtra(Notifier.EXTRA_PARENT_ID)
        intent.removeExtra(Notifier.EXTRA_REVEAL)
        // M16c: the notification's workspace comes on screen first (WORKSPACES.md §7); M28c: a reply's thread opens at the
        // reply; M39: a reaction's notification opens the message reacted to.
        controller.openFromNotification(workspace, channelId, messageId, parentId, reveal)
    }

    /**
     * T1 (MOBILE_UI.md §12): Ctrl+K from a hardware keyboard, wherever the focus is (or with none): 「移動・検索」. The
     * window offers a Ctrl / Meta combination no view took here (a text field takes none of these).
     */
    override fun onKeyShortcut(keyCode: Int, event: KeyEvent): Boolean {
        if (controller.screen == jp.chikuwachat.android.app.AppController.Screen.MAIN && HardwareKeys.isJump(keyCode, event.isCtrlPressed, event.isMetaPressed, event.isAltPressed, event.isShiftPressed)) {
            if (event.repeatCount == 0) controller.pendingJump = true
            return true
        }
        return super.onKeyShortcut(keyCode, event)
    }

    /** The system's keyboard shortcuts list (Meta+/) names the app's own. */
    override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>, menu: Menu?, deviceId: Int) {
        super.onProvideKeyboardShortcuts(data, menu, deviceId)
        data += KeyboardShortcutGroup(
            getString(R.string.app_name),
            listOf(
                KeyboardShortcutInfo(L10n.str(R.string.common_jump_or_search), KeyEvent.KEYCODE_K, KeyEvent.META_CTRL_ON),
                KeyboardShortcutInfo(L10n.str(R.string.common_send), KeyEvent.KEYCODE_ENTER, 0),
                KeyboardShortcutInfo(L10n.str(R.string.main_activity_new_line), KeyEvent.KEYCODE_ENTER, KeyEvent.META_SHIFT_ON),
            ),
        )
    }

    private var languageRecreate: (() -> Unit)? = null

    override fun onDestroy() {
        if (controller.languageRecreate === languageRecreate) controller.languageRecreate = null
        super.onDestroy()
    }

    override fun onStart() {
        super.onStart()
        controller.setForeground(true)
    }

    override fun onStop() {
        controller.setForeground(false)
        super.onStop()
    }
}
