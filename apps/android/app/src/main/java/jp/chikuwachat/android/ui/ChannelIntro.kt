package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.Store
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * The start of a conversation (M11h): what the channel is for, who made it and how many are in it. `version`: the
 * creator's name (and a DM partner's) comes from the Store's users, which arrive on their own (M28c).
 */
@Composable
fun ChannelIntro(channel: ChannelState, store: Store, version: Int) {
    val out = channel.channel
    val title = remember(version, channel) { channelTitle(channel, store) }
    val summary = remember(version, channel) { introSummary(channel, store) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (out.isDm) Icons.Default.AlternateEmail else if (out.type == "private") Icons.Default.Lock else Icons.Default.Tag,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(if (out.isDm) title else title.trimStart('#'), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        Text(summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        (out.purpose ?: out.topic)?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 2.dp)) }
        HorizontalDivider(Modifier.padding(top = 12.dp))
    }
}

/**
 * "Toru が2026年9月27日に作成した公開チャンネルの始まりです。 メンバー 3 人。" (pure, tested). My own DM (titled with my
 * name) says what it is for instead of 「… との会話の始まりです。」.
 */
fun introSummary(channel: ChannelState, store: Store, zone: ZoneId = ZoneId.systemDefault()): String {
    val out = channel.channel
    if (MainTabs.isSelfNotes(channel, store.me?.id)) return MainTabs.SELF_NOTES_INTRO
    val title = channelTitle(channel, store)
    if (out.isDm) return "$title との会話の始まりです。"
    val creator = out.createdBy?.let { store.users[it]?.displayName }
    val date = runCatching { OffsetDateTime.parse(out.createdAt).atZoneSameInstant(zone) }.getOrNull()
    return buildString {
        if (creator != null) append("$creator が")
        if (date != null) append("${date.year}年${date.monthValue}月${date.dayOfMonth}日に")
        append("作成した${if (out.type == "private") "非公開" else "公開"}チャンネルの始まりです。")
        out.memberCount?.takeIf { it > 0 }?.let { append(" メンバー $it 人。") }
    }
}
