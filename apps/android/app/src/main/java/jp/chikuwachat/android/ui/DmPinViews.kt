package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.R

/** M118: the 📌 on a pinned DM's row (the DM tab and the home lists). */
@Composable
fun DmPinMark(modifier: Modifier = Modifier) {
    Icon(Icons.Filled.PushPin, contentDescription = stringResource(R.string.dm_pin_pinned), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier.size(14.dp))
}

/** M118: 「上に固定」/「固定を外す」 in a DM's long-press menu. */
@Composable
fun DmPinButton(pinned: Boolean, onClick: () -> Unit) {
    TextButton(onClick = onClick) {
        Icon(if (pinned) Icons.Outlined.PushPin else Icons.Filled.PushPin, contentDescription = null, modifier = Modifier.size(18.dp))
        Text(stringResource(if (pinned) R.string.dm_pin_unpin else R.string.dm_pin_pin), modifier = Modifier.padding(start = 8.dp))
    }
}
