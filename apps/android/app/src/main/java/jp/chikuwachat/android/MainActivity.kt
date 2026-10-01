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
        // A restore after process death may carry the browser's return; a rotation finds its data cleared.
        if (!fromHistory) takeSsoReturn(intent)
        // The notification permission is asked once the main screen is up (MainScreen, M28c), not at every start.
        setContent { ChikuwaTheme(controller.appearance) { AppRoot(controller) } }
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

    override fun onStart() {
        super.onStart()
        controller.setForeground(true)
    }

    override fun onStop() {
        controller.setForeground(false)
        super.onStop()
    }
}
