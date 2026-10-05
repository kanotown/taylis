package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.InvitePreviewOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** Joining with an invite link (M12h): paste the link, see who invites, choose a name and a password. */
@Composable
fun InviteScreen(controller: AppController, onBack: () -> Unit) {
    var link by rememberSaveable { mutableStateOf("") }
    var target by remember { mutableStateOf<Invite.Target?>(null) }
    var preview by remember { mutableStateOf<InvitePreviewOut?>(null) }
    var username by rememberSaveable { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val minLength = preview?.passwordMinLength ?: PASSWORD_MIN_LENGTH
    val hint = when {
        password.isNotEmpty() && password.length < minLength -> stringResource(R.string.common_passwords_must_be_at_least_characters, minLength)
        confirm.isNotEmpty() && confirm != password -> stringResource(R.string.common_the_passwords_dont_match)
        else -> null
    }
    val canJoin = !busy && !controller.busy && username.length >= 3 && displayName.isNotBlank() && password.length >= minLength && confirm == password

    fun check() {
        val parsed = Invite.parse(link)
        if (parsed == null) { error = L10n.str(R.string.invite_screen_the_invite_link_is_not_in); return }
        scope.launch {
            busy = true; error = null
            try {
                preview = controller.previewInvite(parsed.server, parsed.token)
                target = parsed
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = (e as? ApiException.Api)?.let { Invite.errorText(it.code) } ?: controller.describe(e)
            } finally { busy = false }
        }
    }

    fun join() {
        val current = target ?: return
        scope.launch {
            busy = true; error = null
            error = controller.acceptInvite(current.server, current.token, username.trim(), displayName.trim(), password)
            busy = false
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(stringResource(R.string.invite_screen_join_with_an_invite_link), style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(16.dp))
        val shown = preview
        val chosen = target
        if (chosen == null || shown == null) {
            Text(stringResource(R.string.invite_screen_paste_the_link_you_got_from), style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(link, { link = it }, label = { Text(stringResource(R.string.invite_screen_invite_link)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("https://chat.example.com/invite/…") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done))
            Spacer(Modifier.height(16.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error); Spacer(Modifier.height(8.dp)) }
            if (busy) CircularProgressIndicator() else Button(onClick = ::check, enabled = link.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.invite_screen_check_link)) }
            TextButton(onClick = onBack) { Text(stringResource(R.string.invite_screen_back_to_sign_in)) }
        } else {
            Text(stringResource(R.string.invite_screen_invited_you, shown.invitedBy), style = MaterialTheme.typography.titleMedium)
            if (shown.role == "admin") Text(stringResource(R.string.invite_screen_you_will_join_as_an_administrator), style = MaterialTheme.typography.bodySmall)
            shown.lab?.let { Text(Invite.labText(it), style = MaterialTheme.typography.bodySmall) }
            if (shown.channels.isNotEmpty()) Text(stringResource(R.string.invite_screen_channels_youll_join) + shown.channels.joinToString(" ") { "#$it" }, style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.invite_screen_server, chosen.server), style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(username, { username = it.lowercase() }, label = { Text(stringResource(R.string.common_username_3_32_characters_a_z)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next))
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(displayName, { displayName = it }, label = { Text(stringResource(R.string.common_display_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next))
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.invite_screen_password_at_least_characters, minLength)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next))
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(confirm, { confirm = it }, label = { Text(stringResource(R.string.invite_screen_password_confirm)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done))
            Spacer(Modifier.height(16.dp))
            (hint ?: error)?.let { Text(it, color = MaterialTheme.colorScheme.error); Spacer(Modifier.height(8.dp)) }
            if (busy || controller.busy) CircularProgressIndicator() else {
                Button(onClick = ::join, enabled = canJoin, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.invite_screen_join)) }
                TextButton(onClick = { target = null; preview = null; error = null }) { Text(stringResource(R.string.invite_screen_use_another_link)) }
            }
        }
    }
}
