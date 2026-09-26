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
        intent?.getStringExtra(Notifier.EXTRA_CHANNEL_ID)?.let { controller.pendingChannelId = it }
        setContent { ChikuwaTheme { AppRoot(controller) } }
        if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(Notifier.EXTRA_CHANNEL_ID)?.let { controller.pendingChannelId = it }
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
