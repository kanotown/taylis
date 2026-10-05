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
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

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
        title = { Text(stringResource(R.string.totp_dialog_turn_on_two_factor_authentication)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                when {
                    codes != null -> {
                        Text(stringResource(R.string.totp_dialog_its_on_from_your_next_sign), color = MaterialTheme.colorScheme.primary)
                        Text(stringResource(R.string.totp_dialog_keep_the_recovery_codes_somewhere_safe),
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                        SelectionContainer { Column(Modifier.padding(top = 8.dp)) { codes.forEach { Text(it, fontFamily = FontFamily.Monospace) } } }
                        TextButton(onClick = {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("recovery codes", Totp.recoveryCodesText(codes)))
                            copied = true
                        }) { Text(if (copied) stringResource(R.string.totp_dialog_copied) else stringResource(R.string.totp_dialog_copy_recovery_codes)) }
                    }
                    started != null -> {
                        Text(stringResource(R.string.totp_dialog_scan_the_qr_code_with_an), style = MaterialTheme.typography.bodySmall)
                        Totp.qrBitmap(started.qrPngBase64)?.let { bitmap ->
                            Image(bitmap, contentDescription = stringResource(R.string.totp_dialog_qr_code_for_the_authenticator_app), contentScale = ContentScale.Fit,
                                modifier = Modifier.padding(vertical = 8.dp).size(200.dp).align(Alignment.CenterHorizontally))
                        }
                        Text(stringResource(R.string.totp_dialog_key_for_manual_entry), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        SelectionContainer { Text(started.secret, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                        Text(stringResource(R.string.totp_dialog_type_time_based_totp_6_digits), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedTextField(code, { code = it }, label = { Text(stringResource(R.string.totp_dialog_6_digit_code_shown_in_the)) }, singleLine = true,
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    }
                    else -> {
                        Text(stringResource(R.string.totp_dialog_signing_in_will_ask_for_the), style = MaterialTheme.typography.bodySmall)
                        OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.common_current_password)) }, singleLine = true,
                            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
                if (busy) CircularProgressIndicator(Modifier.padding(top = 8.dp).align(Alignment.CenterHorizontally))
            }
        },
        confirmButton = {
            when {
                codes != null -> TextButton(onClick = onEnabled) { Text(stringResource(R.string.totp_dialog_saved_them_close)) }
                started != null -> TextButton(enabled = !busy && Totp.isCode(code), onClick = {
                    scope.launch {
                        busy = true; error = null
                        controller.enableTotp(code).fold({ recovery = it.recoveryCodes }, { error = controller.totpFailure(it) })
                        busy = false
                    }
                }) { Text(stringResource(R.string.totp_dialog_verify_and_turn_on)) }
                else -> TextButton(enabled = !busy && password.isNotEmpty(), onClick = {
                    scope.launch {
                        busy = true; error = null
                        controller.beginTotpSetup(password).fold({ setup = it }, { error = controller.totpFailure(it) })
                        busy = false
                    }
                }) { Text(stringResource(R.string.common_next)) }
            }
        },
        dismissButton = { if (codes == null) TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
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
        title = { Text(stringResource(R.string.totp_dialog_turn_off_two_factor_authentication)) },
        text = {
            Column {
                Text(stringResource(R.string.totp_dialog_from_now_on_you_can_sign), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.common_current_password)) }, singleLine = true,
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
            }) { Text(stringResource(R.string.common_turn_off), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}
