package jp.chikuwachat.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.ui.AppRoot
import jp.chikuwachat.android.ui.ChikuwaTheme

class MainActivity : ComponentActivity() {
    private val controller get() = (application as ChikuwaApp).controller

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A tapped notification opens its conversation once: a rotation or a restore after process death
        // re-delivers the same intent, and a launch from Recents replays the old one.
        val fromHistory = (intent?.flags ?: 0) and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) takeConversation(intent)
        // The notification permission is asked once the main screen is up (MainScreen, M28c), not at every start.
        setContent { ChikuwaTheme(controller.appearance) { AppRoot(controller) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeConversation(intent)
    }

    private fun takeConversation(intent: Intent?) {
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

    override fun onStart() {
        super.onStart()
        controller.setForeground(true)
    }

    override fun onStop() {
        controller.setForeground(false)
        super.onStop()
    }
}
