package jp.chikuwachat.android.ui

import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonNull
import androidx.compose.material3.Switch
import jp.chikuwachat.android.api.QuietHours
import jp.chikuwachat.android.api.Codec
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

/**
 * The profile card (M11d): display name, @username, title, custom status, presence, and 「メッセージを送る」; for people on
 * the lab roster (M23) also 「M1 · 指導教員: …」 and the research topic.
 */
@Composable
fun ProfileDialog(controller: AppController, userId: String, version: Int, onDismiss: () -> Unit, onOpenDm: (String) -> Unit) {
    val store = controller.store
    // `version` (M28c): the person, the roster line and the presence live in the Store; a change while the card is up shows.
    val user = remember(version, userId) { store.users[userId] }
    val line = remember(version, userId) { store.roster[userId] }
    val isMe = store.me?.id == userId
    val presence = remember(version, userId) { store.presenceOf(userId) }
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
                        if (user?.role == "guest") Text("ゲスト (参加したチャンネルだけ見えます)", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (user?.role == "bot") Text("受信 Webhook の bot", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("@" + (user?.username ?: "") + (user?.title?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(presenceLabel(presence), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (Dnd.isActive(user)) {
                            Text("🔕 通知を一時停止中" + (user?.quietHours?.let { " · " + Dnd.label(it) } ?: ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                if (line != null) {
                    Column(Modifier.padding(top = 12.dp)) {
                        Roster.summary(line, store.users).takeIf { it.isNotEmpty() }?.let {
                            Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                        }
                        line.researchTopic?.takeIf { it.isNotBlank() }?.let {
                            Text("研究テーマ: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
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
    // M12c: a pause applies at once; quiet hours are saved with the form.
    val meNow = me?.let { store.users[it.id] ?: it.asPublic }
    val pausedUntil = meNow?.dndUntil?.takeIf { raw -> runCatching { Instant.parse(raw).isAfter(Instant.now()) }.getOrDefault(false) }
    val existingQuiet = meNow?.quietHours
    var quietOn by remember { mutableStateOf(existingQuiet != null) }
    var quietStart by remember { mutableStateOf(existingQuiet?.start ?: "22:00") }
    var quietEnd by remember { mutableStateOf(existingQuiet?.end ?: "07:00") }
    var quietDays by remember { mutableStateOf((existingQuiet?.days?.ifEmpty { null } ?: (0..6).toList()).toSet()) }
    val timePattern = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
    val quietValid = !quietOn || (timePattern.matches(quietStart) && timePattern.matches(quietEnd) && quietDays.isNotEmpty())
    val quietDraft = if (quietOn) QuietHours(quietStart, quietEnd, quietDays.sorted(), ZoneId.systemDefault().id) else null
    val quietChanged = quietOn != (existingQuiet != null) ||
        (quietDraft != null && existingQuiet != null && (quietDraft.start != existingQuiet.start || quietDraft.end != existingQuiet.end || quietDraft.days.toSet() != existingQuiet.days.toSet() || quietDraft.tz != existingQuiet.tz))
    fun pause(until: String?) { scope.launch { busy = true; controller.updateProfile(mapOf("dnd_until" to until)); busy = false } }
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
                Text("通知を一時停止", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)) {
                    Dnd.PAUSE_OPTIONS.forEach { (choice, label) -> FilterChip(selected = false, enabled = !busy, onClick = { pause(Dnd.pauseUntil(choice)) }, label = { Text(label) }) }
                    if (pausedUntil != null) FilterChip(selected = true, enabled = !busy, onClick = { pause(null) }, label = { Text("🔕 " + (expiryLabel(pausedUntil) ?: "") + " · 解除") })
                }
                Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = quietOn, onCheckedChange = { quietOn = it })
                    Text("おやすみ時間 (毎日この時間帯は通知を止める)", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 8.dp))
                }
                if (quietOn) {
                    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(quietStart, { quietStart = it.take(5) }, modifier = Modifier.width(96.dp), singleLine = true, label = { Text("開始") }, isError = !timePattern.matches(quietStart))
                        Text("〜", modifier = Modifier.padding(horizontal = 8.dp))
                        OutlinedTextField(quietEnd, { quietEnd = it.take(5) }, modifier = Modifier.width(96.dp), singleLine = true, label = { Text("終了") }, isError = !timePattern.matches(quietEnd))
                    }
                    androidx.compose.foundation.layout.FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(4.dp)) {
                        Dnd.DAY_LABELS.forEachIndexed { day, label ->
                            FilterChip(selected = day in quietDays, onClick = { quietDays = if (day in quietDays) quietDays - day else quietDays + day }, label = { Text(label) })
                        }
                    }
                    Text("タイムゾーン: " + ZoneId.systemDefault().id, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && quietValid && (emoji.isNotBlank() || text.isNotBlank() || quietChanged),
                onClick = {
                    scope.launch {
                        busy = true
                        val body = buildJsonObject {
                            if (emoji.isNotBlank() || text.isNotBlank()) {
                                emoji.trim().ifEmpty { null }.let { if (it == null) put("status_emoji", JsonNull) else put("status_emoji", it) }
                                text.trim().ifEmpty { null }.let { if (it == null) put("status_text", JsonNull) else put("status_text", it) }
                                expiryAt(expiry).let { if (it == null) put("status_expires_at", JsonNull) else put("status_expires_at", it) }
                            }
                            if (quietChanged) {
                                val draft = quietDraft
                                if (draft == null) put("quiet_hours", JsonNull)
                                else put("quiet_hours", Codec.snake.encodeToJsonElement(QuietHours.serializer(), draft))
                            }
                        }
                        val ok = controller.updateProfileJson(body)
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
    val status = activeStatus(user)
    val quiet = Dnd.isActive(user)
    if ((status == null || status.first.isEmpty()) && !quiet) return
    Text((status?.first ?: "") + (if (quiet) "🔕" else ""), style = MaterialTheme.typography.labelMedium, modifier = modifier)
}
