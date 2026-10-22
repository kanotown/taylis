package jp.chikuwachat.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import jp.chikuwachat.android.platform.AvatarCache
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import jp.chikuwachat.android.sync.Store
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.floor
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/**
 * The profile picture when the user has one (M14a), else initials on a colour derived from the user id; `presence` adds
 * the presence dot (SYNC_PROTOCOL.md §5.2; offline is a hollow ring, null draws none). `onClick` (M28c) opens the person's profile: TalkBack then names the
 * person and the action, and the touch target is at least 48 dp around a small avatar; a plain avatar stays decorative.
 */
@Composable
fun Avatar(
    id: String, name: String, modifier: Modifier = Modifier, size: Dp = 36.dp, presence: String? = null, onClick: (() -> Unit)? = null,
    /** The colour behind the avatar, for the dot's ring (null: the surface). */
    presenceRing: Color? = null,
) {
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
        if (presence != null) {
            // PresenceDotRule (docs/PRESENCE.md §11.9): its outer edge past the picture's corner, as on iOS and the web.
            val past = PresenceDotRule.overhang(size.value).dp
            PresenceBadge(presence, size, Modifier.align(Alignment.BottomEnd).offset(x = past, y = past), ring = presenceRing ?: MaterialTheme.colorScheme.surface)
        }
    }
}

/**
 * A message's sender avatar (conversations, threads, the thread list, saved / pinned messages, search hits) with the
 * sender's dot (docs/PRESENCE.md §11.5, [PresenceRules.senderDot]): online, away, 取り込み中 and offline (a hollow
 * ring) show, bots have none. The dot is read here, from the Store's version through derivedStateOf, so a presence change redraws this
 * avatar alone and not the list around it. `ring` is the row's background (a highlighted row's too), so the dot looks
 * cut out of the avatar. Like the other lists' dots it is not read out (a tappable avatar keeps its name).
 */
@Composable
fun SenderAvatar(store: Store, userId: String, name: String, size: Dp, ring: Color, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val version = store.version.collectAsState()
    val dot by remember(store, userId) {
        derivedStateOf {
            version.value  // re-read on each Store change; only a different dot recomposes
            PresenceRules.senderDot(store.presenceOf(userId), isBot = store.users[userId]?.role == "bot", avatarShown = true)
        }
    }
    Avatar(userId, name, modifier, size = size, presence = dot, onClick = onClick, presenceRing = ring)
}

/**
 * The presence dot's sizes on a picture `avatar` dp wide (docs/PRESENCE.md §11.9, the same rule as Desktop / Web and iOS):
 * the dot with its ring is about two fifths of the picture, 10 to 20 dp (18–26 dp pictures 10, 28–30 dp 11, 32 dp 12,
 * 36 dp 14, 40 dp 15, 52 dp and up 20); the ring is three twentieths of it to the nearest half dp (1.5 / 2 / 2.5 / 3);
 * the dot reaches a fifth of itself (at least 2 dp) past the corner, three tenths on pictures of 20 dp or less so it keeps
 * clear of the initials. Until 2026-10-23 the dot was 0.32 × the picture inside the corner with a 2 dp ring (3.7 dp of
 * colour on the home's 24 dp DM pictures). Rounding is half up, as on the other clients (not Kotlin's half-even round).
 */
object PresenceDotRule {
    private fun roundHalfUp(x: Float): Float = floor(x + 0.5f)

    /** The dot's diameter with its ring. */
    fun diameter(avatar: Float): Float = roundHalfUp(avatar * 0.38f).coerceIn(10f, 20f)

    /** The ring: the gap in the row's colour around the colour, and the offline ring's grey stroke. */
    fun ring(dot: Float): Float = roundHalfUp(dot * 3f / 10f) / 2f

    /** How far the dot's outer edge reaches past the picture's corner. */
    fun overhang(avatar: Float): Float {
        val dot = diameter(avatar)
        return if (avatar <= 20f) roundHalfUp(dot * 0.3f) else maxOf(2f, roundHalfUp(dot * 0.2f))
    }
}

/**
 * The dot at the corner of a picture `avatar` wide (with the surface's ring around it, [PresenceDotRule]): green online,
 * amber away, and 取り込み中 a plain red disc (docs/PRESENCE.md §11.5; its white bar went on 2026-10-13); offline a hollow
 * grey ring (everyone's since 2026-10-13, not only mine), its inside the `ring` colour too, so it reads as one white
 * circle with a grey edge.
 */
@Composable
fun PresenceBadge(look: String, avatar: Dp, modifier: Modifier = Modifier, ring: Color = MaterialTheme.colorScheme.surface) {
    val dot = PresenceDotRule.diameter(avatar.value)
    val width = PresenceDotRule.ring(dot)
    Box(modifier.size(dot.dp).background(ring, CircleShape).padding(width.dp)) {
        PresenceDot(look, Modifier.matchParentSize(), stroke = width.dp)
    }
}

/** The dot alone (the status menu's choices): [PresenceBadge]'s inside. `stroke`: the offline ring's (null: a fifth). */
@Composable
fun PresenceDot(look: String, modifier: Modifier = Modifier, stroke: Dp? = null) {
    when (look) {
        PresenceRules.ONLINE -> Box(modifier.background(PRESENCE_GREEN, CircleShape))
        PresenceRules.AWAY -> Box(modifier.background(PRESENCE_AMBER, CircleShape))
        PresenceRules.DND -> Box(modifier.background(PRESENCE_RED, CircleShape))
        else -> {
            // A hollow ring the badge's ring thick (as on Desktop / Web and iOS); the inside shows what is behind it.
            val outline = MaterialTheme.colorScheme.outline
            Box(modifier.drawBehind {
                val width = stroke?.toPx() ?: (size.minDimension * 0.2f)
                drawCircle(outline, radius = (size.minDimension - width) / 2, style = Stroke(width = width))
            })
        }
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
