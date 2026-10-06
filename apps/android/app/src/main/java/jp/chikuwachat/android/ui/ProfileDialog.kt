package jp.chikuwachat.android.ui

import jp.chikuwachat.android.L10n
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

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
    var reporting by rememberSaveable { mutableStateOf(false) }
    if (reporting) {
        ReportProblemDialog(controller, userId = userId, onDismiss = { reporting = false })
        return
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.profile_dialog_profile)) },
        text = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(userId, user?.displayName ?: "?", size = 56.dp, presence = presence)
                    Column(Modifier.padding(start = 14.dp)) {
                        Text(user?.displayName ?: "?", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        if (user?.role == "guest") Text(stringResource(R.string.profile_dialog_guest_sees_only_channels_theyve_joined), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (user?.role == "bot") Text(stringResource(R.string.profile_dialog_incoming_webhook_bot), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        // The roster label is the title too (LAB.md 「肩書と名簿」): 「M2 · 研究室長」.
                        Text("@" + (user?.username ?: "") + (Roster.displayTitle(user?.title, line)?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(presenceLabel(presence), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (Dnd.isActive(user)) {
                            Text(stringResource(R.string.profile_dialog_notifications_paused) + (user?.quietHours?.let { " · " + Dnd.label(it) } ?: ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                            Text(stringResource(R.string.profile_dialog_research_topic, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                if (user?.deactivatedAt != null) Text(stringResource(R.string.profile_dialog_deactivated_account), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                // M104 (MODERATION.md §4): private; the person is not told.
                if (!isMe && user != null) {
                    val blocked = remember(version, userId) { store.isBlocked(userId) }
                    if (blocked) Text(stringResource(R.string.profile_dialog_blocked_their_messages_are_collapsed_and), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                    TextButton(
                        onClick = { scope.launch { controller.setUserBlocked(userId, !blocked) } },
                        modifier = Modifier.padding(top = 4.dp),
                    ) { Text(if (blocked) stringResource(R.string.profile_dialog_unblock) else stringResource(R.string.profile_dialog_block), color = if (blocked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error) }
                    // M119 (MODERATION.md §3.1): a report about this person (the same form as Settings' 「問題を報告・ご意見」).
                    TextButton(onClick = { reporting = true }) { Text(stringResource(R.string.common_report), color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = {
            if (isMe) {
                // M40: the 自分 tab's 「ステータスを更新」 screen (the main screen opens it there).
                TextButton(onClick = { onDismiss(); controller.pendingSettings = SettingsPage.STATUS }) { Text(stringResource(R.string.profile_dialog_set_status)) }
            } else if (user?.deactivatedAt == null) {
                Button(onClick = { scope.launch { controller.openDmWith(userId)?.let { onDismiss(); onOpenDm(it) } } }) { Text(stringResource(R.string.profile_dialog_send_a_message)) }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) } },
    )
}

/** "15:30 まで" / "9月30日まで". */
fun expiryLabel(iso: String?): String? {
    val instant = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return null
    val zoned = instant.atZone(ZoneId.systemDefault())
    return if (zoned.toLocalDate() == LocalDate.now()) L10n.str(R.string.common_until, zoned.format(DateTimeFormatter.ofPattern("HH:mm")))
    else L10n.str(R.string.profile_dialog_until_date, zoned.format(DateTimeFormatter.ofPattern(L10n.str(R.string.you_month_day_pattern), L10n.locale)))
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
    fontWeight: FontWeight? = null,
) = EmojiLineText(text, controller.store, { controller.loadEmojiImage(it) }, version, style, color, modifier, maxLines, fontWeight)

/**
 * The same for a row that has the Store rather than the controller: also a message's excerpt in a compact row (the
 * activity, pins, saved, mentions, threads, the DM list, a reply's 「スレッドに返信」 line; 2026-10-05: the activity
 * showed `:ckw-yay:`). Each custom emoji holds its box (its aspect, 1.25 em high) blank until its image comes.
 */
@Composable
fun EmojiLineText(
    text: String,
    store: jp.chikuwachat.android.sync.Store,
    onNeedEmojiImage: (jp.chikuwachat.android.api.CustomEmojiOut) -> Unit,
    version: Int,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    maxLines: Int = 1,
    fontWeight: FontWeight? = null,
    /** Search results: these words marked as in `highlighted`. */
    keywords: List<String> = emptyList(),
) {
    val inline = bodyInline(
        store.users, customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
        onNeedEmojiImage = onNeedEmojiImage, version = version,
    )
    val built = inline.build(listOf(BodyToken.Text(text)))
    val line = if (keywords.isEmpty()) built else androidx.compose.ui.text.buildAnnotatedString {
        append(built)
        for ((start, end) in keywordRanges(built.text, keywords)) addStyle(SEARCH_HIT, start, end)
    }
    Text(
        line, inlineContent = inline.inlineContent, style = style, color = color,
        fontWeight = fontWeight, maxLines = maxLines, overflow = TextOverflow.Ellipsis, modifier = modifier,
    )
}
