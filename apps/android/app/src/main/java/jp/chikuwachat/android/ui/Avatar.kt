package jp.chikuwachat.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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

/** The profile picture when the user has one (M14a), else initials on a colour derived from the user id; `presence` adds the online / away dot (SYNC_PROTOCOL.md §5.2). */
@Composable
fun Avatar(id: String, name: String, size: Dp = 36.dp, modifier: Modifier = Modifier, presence: String? = null) {
    val color = Color.hsl(Timeline.hue(id).toFloat(), 0.55f, 0.45f)
    Box(modifier.size(size)) {
        val picture = AvatarCache.image(id)  // M14a
        if (picture != null) {
            Image(picture, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size).clip(RoundedCornerShape(size / 4)))
        } else {
            Box(Modifier.size(size).background(color, RoundedCornerShape(size / 4)), contentAlignment = Alignment.Center) {
                Text(Timeline.initials(name), color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.42f).sp, maxLines = 1)
            }
        }
        if (presence != null && presence != "offline") {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(size * 0.32f)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp)
                    .background(if (presence == "online") Color(0xFF34C759) else Color(0xFFFF9500), CircleShape),
            )
        }
    }
}

fun presenceLabel(status: String): String = when (status) {
    "online" -> "オンライン"
    "away" -> "離席中"
    else -> "オフライン"
}
