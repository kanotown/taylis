package jp.chikuwachat.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import jp.chikuwachat.android.platform.AvatarCache
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/**
 * The profile picture when the user has one (M14a), else initials on a colour derived from the user id; `presence` adds
 * the online / away dot (SYNC_PROTOCOL.md §5.2). `onClick` (M28c) opens the person's profile: TalkBack then names the
 * person and the action, and the touch target is at least 48 dp around a small avatar; a plain avatar stays decorative.
 */
@Composable
fun Avatar(id: String, name: String, modifier: Modifier = Modifier, size: Dp = 36.dp, presence: String? = null, onClick: (() -> Unit)? = null, showOffline: Boolean = false) {
    val color = Color.hsl(Timeline.hue(id).toFloat(), 0.55f, 0.45f)
    val tappable = if (onClick == null) modifier else modifier.touchTarget { source ->
        Modifier.semantics { contentDescription = name }.clickable(interactionSource = source, indication = null, onClickLabel = L10n.str(R.string.common_open_profile), onClick = onClick)
    }
    Box(tappable.size(size)) {
        val picture = AvatarCache.image(id)  // M14a
        if (picture != null) {
            Image(picture, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size).clip(RoundedCornerShape(size / 4)))
        } else {
            Box(Modifier.size(size).background(color, RoundedCornerShape(size / 4)), contentAlignment = Alignment.Center) {
                Text(Timeline.initials(name), color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.42f).sp, maxLines = 1)
            }
        }
        if (presence != null && (presence != PresenceRules.OFFLINE || showOffline)) {
            PresenceBadge(presence, size * 0.32f, Modifier.align(Alignment.BottomEnd))
        }
    }
}

/**
 * The dot at an avatar's corner (with the surface's ring around it): green online, amber away, and 取り込み中 a red
 * disc with a white bar (docs/PRESENCE.md §11.5); offline a hollow grey ring (my own avatar only, `showOffline`, so
 * オフライン表示 shows).
 */
@Composable
fun PresenceBadge(look: String, size: Dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).background(MaterialTheme.colorScheme.surface, CircleShape).padding(2.dp)) {
        PresenceDot(look, Modifier.matchParentSize())
    }
}

/** The dot alone (the status menu's choices): [PresenceBadge]'s inside. */
@Composable
fun PresenceDot(look: String, modifier: Modifier = Modifier) {
    when (look) {
        PresenceRules.ONLINE -> Box(modifier.background(PRESENCE_GREEN, CircleShape))
        PresenceRules.AWAY -> Box(modifier.background(PRESENCE_AMBER, CircleShape))
        PresenceRules.DND -> Box(modifier.background(PRESENCE_RED, CircleShape), contentAlignment = Alignment.Center) {
            Canvas(Modifier.matchParentSize()) {
                val bar = maxOf(1.5.dp.toPx(), size.height * 0.18f)
                drawRoundRect(
                    Color.White, topLeft = Offset(size.width * 0.19f, (size.height - bar) / 2), size = Size(size.width * 0.62f, bar),
                    cornerRadius = CornerRadius(bar / 2, bar / 2),
                )
            }
        }
        else -> Box(modifier.border(1.5.dp, MaterialTheme.colorScheme.outline, CircleShape))
    }
}

private val PRESENCE_GREEN = Color(0xFF34C759)
private val PRESENCE_AMBER = Color(0xFFFF9500)
private val PRESENCE_RED = Color(0xFFFF3B30)

fun presenceLabel(status: String): String = when (status) {
    "online" -> L10n.str(R.string.common_online)
    "away" -> L10n.str(R.string.common_away)
    PresenceRules.DND -> L10n.str(R.string.presence_choice_dnd)
    else -> L10n.str(R.string.common_offline)
}
