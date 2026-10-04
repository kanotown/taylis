package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.activeStatus
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch
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
                        // The roster label is the title too (LAB.md 「肩書と名簿」): 「M2 · 研究室長」.
                        Text("@" + (user?.username ?: "") + (Roster.displayTitle(user?.title, line)?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(presenceLabel(presence), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (Dnd.isActive(user)) {
                            Text("🔕 通知を一時停止中" + (user?.quietHours?.let { " · " + Dnd.label(it) } ?: ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                // The label is in the line above; the roster block keeps the supervisor and the topic.
                val supervisor = line?.let { Roster.supervisorLabel(it, store.users) }
                if (line != null && (supervisor != null || !line.researchTopic.isNullOrBlank())) {
                    Column(Modifier.padding(top = 12.dp)) {
                        supervisor?.let {
                            Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                        }
                        line.researchTopic?.takeIf { it.isNotBlank() }?.let {
                            Text("研究テーマ: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                if (status != null) {
                    Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (status.first.isNotEmpty()) SectionIcon(controller, status.first, version, size = 20.dp)
                        Text(status.second, modifier = Modifier.padding(start = if (status.first.isNotEmpty()) 6.dp else 0.dp))
                        Spacer(Modifier.weight(1f))
                        expiryLabel(user?.statusExpiresAt)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
                if (user?.deactivatedAt != null) Text("無効化されたアカウント", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = {
            if (isMe) {
                // M40: the 自分 tab's 「ステータスを更新」 screen (the main screen opens it there).
                TextButton(onClick = { onDismiss(); controller.pendingSettings = SettingsPage.STATUS }) { Text("ステータスを設定") }
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

/**
 * The status emoji next to a name when the person has an active custom status; a custom emoji (`:name:`) is its image
 * (SectionIcon), as on a reaction chip.
 */
@Composable
fun StatusEmoji(user: jp.chikuwachat.android.api.UserPublic?, controller: AppController, version: Int, modifier: Modifier = Modifier) {
    val emoji = activeStatus(user)?.first.orEmpty()
    val quiet = Dnd.isActive(user)
    if (emoji.isEmpty() && !quiet) return
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (emoji.isNotEmpty()) SectionIcon(controller, emoji, version, size = 14.dp)
        if (quiet) Text("🔕", style = MaterialTheme.typography.labelMedium)
    }
}

/**
 * A line with a status in it (the DM header, the directory): custom emoji (`:name:`) as their images, as in a message
 * (2026-10-02: a custom status emoji showed as its text).
 */
@Composable
fun EmojiLineText(
    text: String,
    controller: AppController,
    version: Int,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    maxLines: Int = 1,
) {
    val store = controller.store
    val inline = bodyInline(
        store.users, customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
        onNeedEmojiImage = { controller.loadEmojiImage(it) }, version = version,
    )
    Text(
        inline.build(listOf(BodyToken.Text(text))), inlineContent = inline.inlineContent, style = style, color = color,
        maxLines = maxLines, overflow = TextOverflow.Ellipsis, modifier = modifier,
    )
}
