package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Initials on a colour derived from the user id. */
@Composable
fun Avatar(id: String, name: String, size: Dp = 36.dp, modifier: Modifier = Modifier) {
    val color = Color.hsl(Timeline.hue(id).toFloat(), 0.55f, 0.45f)
    Box(modifier.size(size).background(color, RoundedCornerShape(size / 4)), contentAlignment = Alignment.Center) {
        Text(Timeline.initials(name), color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.42f).sp, maxLines = 1)
    }
}
