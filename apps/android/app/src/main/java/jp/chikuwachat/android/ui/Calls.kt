package jp.chikuwachat.android.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.MessageCallOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.sync.ChannelState
import java.util.UUID

/**
 * M117 (docs/CALLS.md): calls by meeting link. The 📞 posts a new room's link as a message; the call itself happens
 * outside the app (the Jitsi Meet app for a meet.jit.si link if installed, else the browser).
 */
object Calls {
    /**
     * §7: the 📞 in a conversation's bar — the workspace has calls on (a server before M117 sends nothing: off), I am in
     * the conversation, it is not archived, and I may start top-level posts there (the announcement rule). The server
     * checks the same (403 / 409).
     */
    fun canStart(settings: WorkspaceSettingsOut, channel: ChannelState?, isAdmin: Boolean): Boolean =
        settings.callsEnabled && channel != null && channel.isMember && !channel.channel.archived && channel.canPostTopLevel(isAdmin)

    /** 「📞 〇〇 さんが通話を始めました」: the card's line and the local notification's text (§6, as the push says it). */
    fun startedLine(call: MessageCallOut, users: Map<String, UserPublic>): String =
        L10n.str(R.string.calls_started_by, users[call.startedBy]?.displayName ?: "?")

    /** A local notification's text for a message: the call's line for a call, else null (the body's line as before). */
    fun notificationLine(call: MessageCallOut?, deleted: Boolean, users: Map<String, UserPublic>): String? =
        call?.takeIf { !deleted }?.let { startedLine(it, users) }

    /**
     * The room outside the app: ACTION_VIEW, which the Jitsi Meet app takes for its links (app links) and the browser
     * otherwise. Not a Custom Tab or a WebView: a call needs the camera and microphone of a full browser or app. False
     * when nothing opens it.
     */
    fun open(context: Context, url: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(intent) }.isSuccess
    }
}

/**
 * §7: the idempotency key of each conversation's call being started. A retry after a failure whose outcome is unknown
 * (no answer, a 5xx, a 429) sends the same key, so a call is never started twice; a refusal (4xx) or a success forgets
 * it, and so does [ttlMillis] (a tap much later is a new call).
 */
class CallKeys(private val ttlMillis: Long = 10 * 60_000L, private val now: () -> Long = System::currentTimeMillis) {
    private val keys = HashMap<String, Pair<String, Long>>()

    /** The key to send for `channelId`: the kept one, or a new one. */
    fun take(channelId: String): String {
        val kept = keys[channelId]?.takeIf { now() - it.second < ttlMillis }
        if (kept != null) return kept.first
        val fresh = UUID.randomUUID().toString()
        keys[channelId] = fresh to now()
        return fresh
    }

    /** After the request: forgotten unless the call may have been made after all. */
    fun settle(channelId: String, failure: Throwable?) {
        val unknown = failure is ApiException.Network || (failure is ApiException.Api && failure.isRetryable)
        if (!unknown) keys.remove(channelId)
    }
}

/** 「通話を始めますか？」: what the 📞 asks first (§7). */
@Composable
fun StartCallDialog(onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.calls_confirm_title)) },
        text = { Text(stringResource(R.string.calls_confirm_text)) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(stringResource(R.string.calls_start)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/**
 * A call message (§7): 「📞 〇〇 さんが通話を始めました」 and 「参加する」 in place of the body (the link is not repeated
 * nor previewed). The server does not know when a call ends, so 「参加する」 stays.
 */
@Composable
fun CallCard(call: MessageCallOut, users: Map<String, UserPublic>, onJoin: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.padding(top = 2.dp, bottom = 4.dp).widthIn(max = 420.dp),
    ) {
        Row(
            Modifier.padding(start = 12.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(Calls.startedLine(call, users), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f, fill = false))
            FilledTonalButton(onClick = onJoin) { Text(stringResource(R.string.calls_join)) }
        }
    }
}
