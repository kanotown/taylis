package jp.chikuwachat.android.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.ServerUrlSecurity
import jp.chikuwachat.android.app.Workspaces

/**
 * M190 (SECURITY.md §6.1): 「暗号化されていない接続です」 before a sign-in form (login, adding a workspace, Google sign-in)
 * or an invite link first contacts a server over plain HTTP across the internet. [check] goes on at once for https and
 * for a LAN / this device; otherwise it holds the request for [InsecureServerDialog], whose 「https で接続」 goes on with
 * the same URL with https and 「このまま接続」 as typed. Nothing is remembered.
 */
class InsecureServerPrompt {
    /** [url]: the normalized http URL; [typed]: what the form had, handed back for 「このまま接続」. */
    class Pending(val url: String, val typed: String, val proceed: (String) -> Unit)

    var pending by mutableStateOf<Pending?>(null)
        private set

    /** [server] as the form has it (normalized here as the sign-in will be); [proceed] gets the address to use. */
    fun check(server: String, proceed: (String) -> Unit) {
        val url = Workspaces.normalizeServerUrl(server)
        if (url == null || ServerUrlSecurity.classify(url) != ServerUrlSecurity.INSECURE) {
            proceed(server) // https, a LAN, or not a URL (the sign-in says so)
            return
        }
        pending = Pending(url, server, proceed)
    }

    fun useHttps(request: Pending) {
        pending = null
        request.proceed(ServerUrlSecurity.https(request.url))
    }

    fun continueAnyway(request: Pending) {
        pending = null
        request.proceed(request.typed)
    }

    fun cancel() {
        pending = null
    }
}

/** The dialog of an [InsecureServerPrompt]: キャンセル, このまま接続 (in the error colour), https で接続 (the confirm action). */
@Composable
fun InsecureServerDialog(prompt: InsecureServerPrompt) {
    val request = prompt.pending ?: return
    AlertDialog(
        onDismissRequest = prompt::cancel,
        title = { Text(stringResource(R.string.insecure_server_title)) },
        text = { Text(stringResource(R.string.insecure_server_message)) },
        confirmButton = { TextButton(onClick = { prompt.useHttps(request) }) { Text(stringResource(R.string.insecure_server_use_https)) } },
        dismissButton = {
            TextButton(onClick = prompt::cancel) { Text(stringResource(R.string.common_cancel)) }
            TextButton(onClick = { prompt.continueAnyway(request) }) {
                Text(stringResource(R.string.insecure_server_continue), color = MaterialTheme.colorScheme.error)
            }
        },
    )
}
