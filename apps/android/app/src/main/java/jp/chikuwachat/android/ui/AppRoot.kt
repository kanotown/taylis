package jp.chikuwachat.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import jp.chikuwachat.android.app.AppController

@Composable
fun AppRoot(controller: AppController) {
    LaunchedEffect(Unit) { controller.boot() }
    // M16c: each workspace keeps its own screen state (open conversation, panes, search) while another is shown.
    val screens = rememberSaveableStateHolder()
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (controller.addingWorkspace) {
            // 「ワークスペースを追加」 (WORKSPACES.md §5.1): back / キャンセル returns to the workspace underneath.
            BackHandler { controller.cancelAddWorkspace() }
            key("add") { LoginScreen(controller) }
        } else {
            when (controller.screen) {
                AppController.Screen.BOOT -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                // Keyed by workspace: the form starts from that workspace's server and user.
                AppController.Screen.LOGIN -> key(controller.activeKey) { LoginScreen(controller) }
                AppController.Screen.CHANGE_PASSWORD -> ChangePasswordScreen(controller)
                AppController.Screen.MAIN -> screens.SaveableStateProvider(controller.workspaceKey ?: "") { MainScreen(controller) }
            }
        }
        if (controller.switcherOpen) WorkspaceSheet(controller, onDismiss = { controller.switcherOpen = false })
    }
}
