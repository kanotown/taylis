package jp.chikuwachat.android.ui

import android.content.ActivityNotFoundException
import android.content.Context
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.app.GoogleButtonText
import jp.chikuwachat.android.app.Workspaces
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

@Composable
fun LoginScreen(controller: AppController) {
    // M16c: adding another workspace (キャンセル returns), or signing back in to a registered one (prefilled).
    val adding = controller.addingWorkspace
    val entry = if (adding) null else controller.activeWorkspace
    val others = controller.workspaces.any { it.serverUrl != controller.activeKey }
    // M12h: 「招待リンクで参加」 replaces the login form until the account exists or the user goes back.
    var invite by rememberSaveable { mutableStateOf(false) }
    if (invite && !adding) {
        InviteScreen(controller, onBack = { invite = false })
        return
    }
    var server by rememberSaveable { mutableStateOf(if (adding) "" else controller.savedServer) }
    var username by rememberSaveable { mutableStateOf(if (adding) "" else controller.loginUsername) }
    var password by rememberSaveable { mutableStateOf("") }
    var totpCode by rememberSaveable { mutableStateOf("") }
    val needsCode = controller.totpRequired
    val scope = rememberCoroutineScope()
    val canSubmit = !controller.busy && server.isNotBlank() && username.isNotBlank() && password.isNotEmpty() && (!needsCode || totpCode.isNotBlank())
    fun submit() { if (canSubmit) scope.launch { controller.login(server, username, password, if (needsCode) totpCode else null) } }
    // M48: 「Google でログイン」 when this server offers it (GET /auth/methods); a server before M48 answers 404 (hidden).
    val context = LocalContext.current
    // A server restricted to its Workspace domains gets 「<domain> のアカウントでログイン」 (guideline 4.8).
    var google by remember { mutableStateOf<GoogleButtonText?>(null) }
    LaunchedEffect(server) {
        google = null
        if (Workspaces.normalizeServerUrl(server) == null) return@LaunchedEffect
        delay(400) // typing: ask once the address stops changing
        google = controller.googleSignInButton(server)
    }
    fun signInWithGoogle() {
        scope.launch {
            val url = controller.beginGoogleSignIn(server) ?: return@launch
            if (!openSignInPage(context, url)) controller.googleSignInNotOpened()
        }
    }

    Column(
        // T1: a form of a phone's width in the middle of a tablet, not stretched across it.
        modifier = Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp)
            .wrapContentWidth().widthIn(max = 560.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (entry != null) {
            WorkspaceTile(entry, entry.name, 48.dp)
            Spacer(Modifier.height(12.dp))
        }
        Text(if (adding) stringResource(R.string.common_add_workspace) else entry?.name ?: "Taylis", style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
        when {
            adding -> Text(stringResource(R.string.login_screen_sign_in_to_another_taylis_server), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            entry?.signedOut == true -> Text(stringResource(R.string.login_screen_please_sign_in_again), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(server, { server = it }, label = { Text(stringResource(R.string.login_screen_server_url)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("https://chat.example.com") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next))
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(username, { username = it }, label = { Text(stringResource(R.string.login_screen_username)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next))
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.common_password)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done))
        if (needsCode) {
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.login_screen_two_factor_authentication_enter_the_code), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(totpCode, { totpCode = it }, label = { Text(stringResource(R.string.login_screen_6_digit_code_or_recovery_code)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done))
        }
        Spacer(Modifier.height(16.dp))
        controller.error?.let { Text(it, color = MaterialTheme.colorScheme.error); Spacer(Modifier.height(8.dp)) }
        if (controller.busy) CircularProgressIndicator() else Button(onClick = ::submit, enabled = canSubmit, modifier = Modifier.fillMaxWidth()) { Text(if (needsCode) stringResource(R.string.login_screen_verify_code_and_sign_in) else stringResource(R.string.login_screen_sign_in)) }
        google?.let { button ->
            Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                HorizontalDivider(Modifier.weight(1f))
                Text(stringResource(R.string.login_screen_or), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp))
                HorizontalDivider(Modifier.weight(1f))
            }
            OutlinedButton(onClick = ::signInWithGoogle, enabled = !controller.busy, modifier = Modifier.fillMaxWidth()) {
                val subtitle = button.subtitle
                if (subtitle == null) {
                    Text(button.title)
                } else {
                    // The organisation's own login: a neutral building mark, not Google's "G".
                    Icon(Icons.Outlined.Business, contentDescription = null, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(button.title, textAlign = TextAlign.Center)
                        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (adding) {
            TextButton(onClick = { controller.cancelAddWorkspace() }) { Text(stringResource(R.string.common_cancel)) }
        } else {
            // WORKSPACES.md §5.2: a workspace whose session ended does not lock the others away.
            if (others) TextButton(onClick = { controller.openSwitcher() }) { Text(stringResource(R.string.login_screen_switch_to_another_workspace)) }
            TextButton(onClick = { invite = true }) { Text(stringResource(R.string.login_screen_have_an_invite_link_tap_here)) }
        }
    }
}

/**
 * M48 (docs/SSO.md §1, §6): Google's page opens in a Custom Tab, never in a WebView (Google refuses embedded ones). Without
 * a Custom Tabs browser the intent goes to the default browser; false when nothing can open it.
 */
private fun openSignInPage(context: Context, url: String): Boolean = try {
    CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, url.toUri())
    true
} catch (_: ActivityNotFoundException) {
    false
}
