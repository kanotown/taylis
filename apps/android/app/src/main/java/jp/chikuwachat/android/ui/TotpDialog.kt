package jp.chikuwachat.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.TotpSetupOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/** Turning 2FA on (M12i): password → scan the QR and confirm a code → keep the recovery codes. */
@Composable
fun TotpSetupDialog(controller: AppController, onDismiss: () -> Unit, onEnabled: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var password by remember { mutableStateOf("") }
    var setup by remember { mutableStateOf<TotpSetupOut?>(null) }
    var code by remember { mutableStateOf("") }
    var recovery by remember { mutableStateOf<List<String>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    val codes = recovery
    val started = setup

    AlertDialog(
        onDismissRequest = { if (codes == null) onDismiss() },
        title = { Text("2 要素認証を有効にする") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                when {
                    codes != null -> {
                        Text("有効になりました。次回のログインから認証アプリのコードが必要です。", color = MaterialTheme.colorScheme.primary)
                        Text("回復コードを安全な場所に保存してください。認証アプリが使えないとき、各コードは 1 回だけログインに使えます。この画面を閉じると再表示できません。",
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                        SelectionContainer { Column(Modifier.padding(top = 8.dp)) { codes.forEach { Text(it, fontFamily = FontFamily.Monospace) } } }
                        TextButton(onClick = {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("recovery codes", Totp.recoveryCodesText(codes)))
                            copied = true
                        }) { Text(if (copied) "コピーしました" else "回復コードをコピー") }
                    }
                    started != null -> {
                        Text("認証アプリ (Google Authenticator など) で QR コードを読み取るか、キーを手で入力してください。", style = MaterialTheme.typography.bodySmall)
                        Totp.qrBitmap(started.qrPngBase64)?.let { bitmap ->
                            Image(bitmap, contentDescription = "認証アプリ用の QR コード", contentScale = ContentScale.Fit,
                                modifier = Modifier.padding(vertical = 8.dp).size(200.dp).align(Alignment.CenterHorizontally))
                        }
                        Text("手入力用のキー", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        SelectionContainer { Text(started.secret, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                        Text("種類: 時間ベース (TOTP)、6 桁、30 秒", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedTextField(code, { code = it }, label = { Text("アプリに表示された 6 桁のコード") }, singleLine = true,
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    }
                    else -> {
                        Text("ログイン時にパスワードに加えて認証アプリの 6 桁のコードを求めます。始めるにはパスワードを入力してください。", style = MaterialTheme.typography.bodySmall)
                        OutlinedTextField(password, { password = it }, label = { Text("現在のパスワード") }, singleLine = true,
                            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
                if (busy) CircularProgressIndicator(Modifier.padding(top = 8.dp).align(Alignment.CenterHorizontally))
            }
        },
        confirmButton = {
            when {
                codes != null -> TextButton(onClick = onEnabled) { Text("保存しました、閉じる") }
                started != null -> TextButton(enabled = !busy && Totp.isCode(code), onClick = {
                    scope.launch {
                        busy = true; error = null
                        controller.enableTotp(code).fold({ recovery = it.recoveryCodes }, { error = controller.totpFailure(it) })
                        busy = false
                    }
                }) { Text("確認して有効にする") }
                else -> TextButton(enabled = !busy && password.isNotEmpty(), onClick = {
                    scope.launch {
                        busy = true; error = null
                        controller.beginTotpSetup(password).fold({ setup = it }, { error = controller.totpFailure(it) })
                        busy = false
                    }
                }) { Text("次へ") }
            }
        },
        dismissButton = { if (codes == null) TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}

/** Turning 2FA off needs the password again. */
@Composable
fun TotpDisableDialog(controller: AppController, onDismiss: () -> Unit, onDisabled: () -> Unit) {
    val scope = rememberCoroutineScope()
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("2 要素認証を無効にする") },
        text = {
            Column {
                Text("以後はパスワードだけでログインできるようになります。回復コードも無効になります。", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(password, { password = it }, label = { Text("現在のパスワード") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && password.isNotEmpty(), onClick = {
                scope.launch {
                    busy = true
                    val failure = controller.disableTotp(password)
                    busy = false
                    if (failure == null) onDisabled() else error = failure
                }
            }) { Text("無効にする", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
