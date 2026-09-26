package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.FilterChip
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.activeStatus
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The profile card (M11d): display name, @username, title, custom status, presence, and 「メッセージを送る」. */
@Composable
fun ProfileDialog(controller: AppController, userId: String, onDismiss: () -> Unit, onOpenDm: (String) -> Unit) {
    val store = controller.store
    val user = store.users[userId]
    val isMe = store.me?.id == userId
    val presence = store.presenceOf(userId)
    val status = activeStatus(user)
    val scope = rememberCoroutineScope()
    var editingStatus by remember { mutableStateOf(false) }
    if (editingStatus) {
        StatusDialog(controller, onDismiss = { editingStatus = false })
        return
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("プロフィール") },
        text = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(userId, user?.displayName ?: "?", size = 56.dp, presence = presence)
                    Column(Modifier.padding(start = 14.dp)) {
                        Text(user?.displayName ?: "?", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text("@" + (user?.username ?: "") + (user?.title?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(presenceLabel(presence), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (status != null) {
                    Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text((status.first + " " + status.second).trim())
                        Spacer(Modifier.weight(1f))
                        expiryLabel(user?.statusExpiresAt)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
                if (user?.deactivatedAt != null) Text("無効化されたアカウント", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = {
            if (isMe) {
                TextButton(onClick = { editingStatus = true }) { Text("ステータスを設定") }
            } else if (user?.deactivatedAt == null) {
                Button(onClick = { scope.launch { controller.openDmWith(userId)?.let { onDismiss(); onOpenDm(it) } } }) { Text("メッセージを送る") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

/** "15:30 まで" / "9月30日まで". */
fun expiryLabel(iso: String?): String? {
    val instant = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return null
    val zoned = instant.atZone(ZoneId.systemDefault())
    return if (zoned.toLocalDate() == LocalDate.now()) zoned.format(DateTimeFormatter.ofPattern("HH:mm")) + " まで"
    else zoned.format(DateTimeFormatter.ofPattern("M月d日")) + "まで"
}

private val STATUS_PRESETS = listOf("📅" to "会議中", "🚌" to "移動中", "🤒" to "体調不良", "🌴" to "休暇中", "🏠" to "在宅勤務", "🍱" to "昼休み")
private val EXPIRY_OPTIONS = listOf("never" to "消さない", "30m" to "30 分後", "1h" to "1 時間後", "4h" to "4 時間後", "today" to "今日の終わり", "week" to "今週の終わり")

/** ISO time when a status with this expiry should disappear; null = never. */
fun expiryAt(choice: String, now: Instant = Instant.now()): String? {
    val zone = ZoneId.systemDefault()
    val local = now.atZone(zone)
    val at = when (choice) {
        "30m" -> local.plusMinutes(30)
        "1h" -> local.plusHours(1)
        "4h" -> local.plusHours(4)
        "today" -> local.with(LocalTime.of(23, 59, 59))
        "week" -> {
            val toSunday = (7 - local.dayOfWeek.value) % 7 // Monday=1 … Sunday=7
            local.plusDays(toSunday.toLong()).with(LocalTime.of(23, 59, 59))
        }
        else -> return null
    }
    return at.toInstant().toString()
}

/** Custom status editor (M11d): emoji + text + expiry, quick presets, clear. */
@Composable
fun StatusDialog(controller: AppController, onDismiss: () -> Unit) {
    val store = controller.store
    val me = store.me
    val current = activeStatus(me?.let { store.users[it.id] ?: it.asPublic })
    var emoji by remember { mutableStateOf(current?.first ?: "") }
    var text by remember { mutableStateOf(current?.second ?: "") }
    var expiry by remember { mutableStateOf("never") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("ステータスを設定") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Row {
                    OutlinedTextField(emoji, { emoji = it.take(8) }, modifier = Modifier.width(72.dp), placeholder = { Text("絵文字") }, singleLine = true)
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(text, { text = it.take(100) }, modifier = Modifier.weight(1f), placeholder = { Text("今なにしてる？") }, singleLine = true)
                }
                androidx.compose.foundation.layout.FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)) {
                    STATUS_PRESETS.forEach { (e, t) -> FilterChip(selected = text == t, onClick = { emoji = e; text = t }, label = { Text("$e $t") }) }
                }
                Text("消えるタイミング", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)) {
                    EXPIRY_OPTIONS.forEach { (value, label) -> FilterChip(selected = expiry == value, onClick = { expiry = value }, label = { Text(label) }) }
                }
                expiryLabel(expiryAt(expiry))?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp)) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && (emoji.isNotBlank() || text.isNotBlank()),
                onClick = {
                    scope.launch {
                        busy = true
                        val ok = controller.updateProfile(mapOf("status_emoji" to emoji.trim().ifEmpty { null }, "status_text" to text.trim().ifEmpty { null }, "status_expires_at" to expiryAt(expiry)))
                        busy = false
                        if (ok) onDismiss()
                    }
                },
            ) { Text("保存") }
        },
        dismissButton = {
            Row {
                if (current != null) {
                    TextButton(enabled = !busy, onClick = { scope.launch { busy = true; if (controller.updateProfile(mapOf("status_emoji" to null, "status_text" to null, "status_expires_at" to null))) onDismiss(); busy = false } }) { Text("クリア") }
                }
                TextButton(onClick = onDismiss) { Text("キャンセル") }
            }
        },
    )
}

/** The status emoji next to a name when the person has an active custom status. */
@Composable
fun StatusEmoji(user: jp.chikuwachat.android.api.UserPublic?, modifier: Modifier = Modifier) {
    val status = activeStatus(user) ?: return
    if (status.first.isEmpty()) return
    Text(status.first, style = MaterialTheme.typography.labelMedium, modifier = modifier)
}
