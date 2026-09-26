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

const val PASSWORD_MIN_LENGTH = 8

/** Forced on first login with a temporary password (SECURITY.md §3). */
@Composable
fun ChangePasswordScreen(controller: AppController) {
    var current by rememberSaveable { mutableStateOf("") }
    var new by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val hint = when {
        new.isNotEmpty() && new.length < PASSWORD_MIN_LENGTH -> "パスワードは $PASSWORD_MIN_LENGTH 文字以上にしてください"
        confirm.isNotEmpty() && confirm != new -> "確認用パスワードが一致しません"
        else -> null
    }
    val canSubmit = !controller.busy && current.isNotEmpty() && new.length >= PASSWORD_MIN_LENGTH && confirm == new

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("パスワードの変更", style = MaterialTheme.typography.headlineSmall)
        Text("初回ログインのため、新しいパスワードを設定してください。", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(current, { current = it }, label = { Text("現在のパスワード") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(new, { new = it }, label = { Text("新しいパスワード") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(confirm, { confirm = it }, label = { Text("新しいパスワード（確認）") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(16.dp))
        (hint ?: controller.error)?.let { Text(it, color = MaterialTheme.colorScheme.error); Spacer(Modifier.height(8.dp)) }
        if (controller.busy) CircularProgressIndicator() else {
            Button(onClick = { scope.launch { controller.changePassword(current, new) } }, enabled = canSubmit, modifier = Modifier.fillMaxWidth()) { Text("変更する") }
            TextButton(onClick = { scope.launch { controller.logout() } }) { Text("ログアウト") }
        }
    }
}
