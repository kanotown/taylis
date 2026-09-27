package jp.chikuwachat.android

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.ui.AppRoot
import jp.chikuwachat.android.ui.ChikuwaTheme

class MainActivity : ComponentActivity() {
    private val controller get() = (application as ChikuwaApp).controller
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A tapped notification opens its conversation once: a rotation or a restore after process death
        // re-delivers the same intent, and a launch from Recents replays the old one.
        val fromHistory = (intent?.flags ?: 0) and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) takeConversation(intent)
        setContent { ChikuwaTheme { AppRoot(controller) } }
        if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeConversation(intent)
    }

    private fun takeConversation(intent: Intent?) {
        val channelId = intent?.getStringExtra(Notifier.EXTRA_CHANNEL_ID) ?: return
        intent.removeExtra(Notifier.EXTRA_CHANNEL_ID)
        controller.pendingChannelId = channelId
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
