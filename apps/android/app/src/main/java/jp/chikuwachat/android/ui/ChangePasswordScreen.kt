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
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

const val PASSWORD_MIN_LENGTH = 8

/** Forced on first login with a temporary password (SECURITY.md §3). */
@Composable
fun ChangePasswordScreen(controller: AppController) {
    var current by rememberSaveable { mutableStateOf("") }
    var new by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val hint = when {
        new.isNotEmpty() && new.length < PASSWORD_MIN_LENGTH -> stringResource(R.string.common_passwords_must_be_at_least_characters, PASSWORD_MIN_LENGTH)
        confirm.isNotEmpty() && confirm != new -> stringResource(R.string.common_the_passwords_dont_match)
        else -> null
    }
    val canSubmit = !controller.busy && current.isNotEmpty() && new.length >= PASSWORD_MIN_LENGTH && confirm == new

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(stringResource(R.string.common_change_password), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.change_password_screen_this_is_your_first_sign_in), style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(current, { current = it }, label = { Text(stringResource(R.string.common_current_password)) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(new, { new = it }, label = { Text(stringResource(R.string.change_password_screen_new_password)) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(confirm, { confirm = it }, label = { Text(stringResource(R.string.change_password_screen_new_password_confirm)) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(16.dp))
        (hint ?: controller.error)?.let { Text(it, color = MaterialTheme.colorScheme.error); Spacer(Modifier.height(8.dp)) }
        if (controller.busy) CircularProgressIndicator() else {
            Button(onClick = { scope.launch { controller.changePassword(current, new) } }, enabled = canSubmit, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.common_change_2)) }
            TextButton(onClick = { scope.launch { controller.logout() } }) { Text(stringResource(R.string.common_sign_out)) }
        }
    }
}
