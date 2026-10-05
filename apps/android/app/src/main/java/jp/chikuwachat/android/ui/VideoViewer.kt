package jp.chikuwachat.android.ui

import android.media.MediaPlayer
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.io.File
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.CancellationException
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource
import jp.chikuwachat.android.L10n

/**
 * M82: a video played in the app (the platform's VideoView and MediaController, no player library). The clip is
 * fetched to the download cache only now, when it is opened (the tile showed the server's poster); while it downloads
 * and until the first frame is drawn the poster stands in the clip's shape with a spinner over it. Another app stays
 * available from the toolbar, as in the image viewer. `poster`: the one the tile already has, else fetched here.
 */
@Composable
fun VideoViewer(attachment: AttachmentOut, controller: AppController, poster: ImageBitmap?, onDismiss: () -> Unit) {
    var file by remember(attachment.id) { mutableStateOf<File?>(null) }
    var error by remember(attachment.id) { mutableStateOf<String?>(null) }
    var attempt by remember(attachment.id) { mutableIntStateOf(0) }
    var playing by remember(attachment.id) { mutableStateOf(false) }
    var ratio by remember(attachment.id) { mutableFloatStateOf(VideoTiles.aspectRatio(attachment)) }
    var picture by remember(attachment.id) { mutableStateOf(poster) }
    if (picture == null && attachment.hasPoster) LaunchedEffect(attachment.id) { picture = fetchThumbnail(controller, attachment.id) }
    LaunchedEffect(attachment.id, attempt) {
        error = null
        try {
            file = controller.videoFile(attachment)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = controller.describe(e)
        }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, stringResource(R.string.video_viewer_close_video), tint = Color.White) }
                    Text(attachment.filename, Modifier.weight(1f), color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    IconButton(onClick = { controller.openAttachment(attachment) }) { Icon(Icons.Outlined.OpenInNew, stringResource(R.string.common_open_in_another_app), tint = Color.White) }
                }
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    val clip = file
                    val frame = Modifier.aspectRatio(ratio)
                    if (clip != null && error == null) {
                        AndroidView(
                            factory = { context ->
                                VideoView(context).apply {
                                    val controls = MediaController(context)
                                    controls.setAnchorView(this)
                                    setMediaController(controls)
                                    setOnPreparedListener { player ->
                                        if (player.videoWidth > 0 && player.videoHeight > 0) ratio = player.videoWidth.toFloat() / player.videoHeight
                                        start()
                                    }
                                    setOnInfoListener { _, what, _ ->
                                        if (what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) playing = true
                                        false
                                    }
                                    setOnErrorListener { _, _, _ -> error = L10n.str(R.string.video_viewer_couldnt_play_this_video); true }
                                    setVideoPath(clip.path)
                                }
                            },
                            onRelease = { it.stopPlayback() },
                            modifier = frame,
                        )
                    }
                    if (error != null) {
                        Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.video_viewer_couldnt_load_the_video), color = Color.White, style = MaterialTheme.typography.titleMedium)
                            Text(error!!, Modifier.padding(vertical = 12.dp), color = Color.White)
                            Button(onClick = { file = null; playing = false; attempt += 1 }) { Text(stringResource(R.string.common_retry)) }
                        }
                    } else if (!playing) {
                        // The poster over the player until its first frame (M79 spec item 5).
                        Box(frame, contentAlignment = Alignment.Center) {
                            picture?.let { Image(it, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()) }
                            CircularProgressIndicator(color = Color.White)
                        }
                    }
                }
            }
        }
    }
}
