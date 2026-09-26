package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import jp.chikuwachat.android.app.AppController

@Composable
fun AppRoot(controller: AppController) {
    LaunchedEffect(Unit) { controller.boot() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when (controller.screen) {
            AppController.Screen.BOOT -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            AppController.Screen.LOGIN -> LoginScreen(controller)
            AppController.Screen.CHANGE_PASSWORD -> ChangePasswordScreen(controller)
            AppController.Screen.MAIN -> MainScreen(controller)
        }
    }
}
