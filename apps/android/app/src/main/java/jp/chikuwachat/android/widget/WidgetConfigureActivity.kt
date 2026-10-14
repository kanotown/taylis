package jp.chikuwachat.android.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.ChikuwaApp
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.Workspace
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.ui.ChikuwaTheme
import jp.chikuwachat.android.ui.WorkspaceTile
import kotlinx.coroutines.launch

/**
 * A widget's workspace (all three widgets; `android:configure` in their provider info, optional and reconfigurable from
 * Android 12, so placing a widget works without it and its long-press menu reopens it): 「アプリで開いているワークスペース」
 * (the default: the widget follows the app, as every widget did before) or one of the signed-in workspaces. The choice is
 * kept per appWidgetId ([WidgetWorkspaces]); choosing a workspace not on screen reads its data at once
 * ([WidgetRefreshWorker], and the 今日 widget's own read).
 */
class WidgetConfigureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appWidgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        // Backing out leaves the widget as it is (when placing: placed, following the app; configuration is optional).
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        enableEdgeToEdge()
        val controller = (application as ChikuwaApp).controller
        val current = WidgetWorkspaces.read(this).choices[appWidgetId]
        setContent {
            ChikuwaTheme(controller.appearance) {
                var options by remember { mutableStateOf<List<Workspace>?>(null) }
                LaunchedEffect(Unit) { options = controller.widgetWorkspaces() }
                val scope = rememberCoroutineScope()
                ConfigureScreen(options, current) { choice ->
                    scope.launch {
                        WidgetWorkspaces.choose(this@WidgetConfigureActivity, appWidgetId, choice)
                        afterChoice(choice)
                        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
                        finish()
                    }
                }
            }
        }
    }

    /** A workspace not on screen: read its widgets' data now; the periodic read starts or stops with the choices. */
    private suspend fun afterChoice(choice: String?) {
        val context = applicationContext
        if (choice != null && choice != WidgetWorkspaces.read(context).current) WidgetRefreshWorker.refreshNow(context, choice)
        WidgetRefreshWorker.ensure(context)
        if (TodayWidgetData.store.placed(context)) TodayWidgetWorker.requestRead(context, delayMs = 0L)
    }
}

@Composable
private fun ConfigureScreen(options: List<Workspace>?, current: String?, choose: (String?) -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Text(
                stringResource(R.string.widget_config_title), style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 8.dp),
            )
            Text(
                stringResource(R.string.widget_config_note), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
            Spacer(Modifier.height(16.dp))
            when {
                options == null -> CircularProgressIndicator(Modifier.padding(24.dp))
                else -> LazyColumn(Modifier.fillMaxWidth().selectableGroup(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    item {
                        Choice(
                            selected = current == null, title = stringResource(R.string.widget_config_follow),
                            subtitle = stringResource(R.string.widget_config_follow_hint), onClick = { choose(null) },
                        ) { Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.PhoneAndroid, contentDescription = null, modifier = Modifier.size(26.dp), tint = MaterialTheme.colorScheme.primary) } }
                        HorizontalDivider(Modifier.padding(horizontal = 24.dp, vertical = 4.dp))
                    }
                    if (options.isEmpty()) {
                        item {
                            Text(
                                stringResource(R.string.widget_config_none), style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp),
                            )
                        }
                    }
                    items(options, key = { it.serverUrl }) { entry ->
                        Choice(
                            selected = current == entry.serverUrl, title = entry.name,
                            subtitle = entry.signInName + " · " + Workspaces.hostLabel(entry.serverUrl), onClick = { choose(entry.serverUrl) },
                        ) { WorkspaceTile(entry, entry.name, 32.dp) }
                    }
                }
            }
        }
    }
}

@Composable
private fun Choice(selected: Boolean, title: String, subtitle: String, onClick: () -> Unit, leading: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.RadioButton, onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        RadioButton(selected = selected, onClick = null)
    }
}
