package jp.chikuwachat.android.ui

import android.os.Build
import android.view.WindowManager
import android.widget.VideoView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SkipNext
import androidx.compose.material.icons.outlined.SkipPrevious
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.AlbumRules
import jp.chikuwachat.android.sync.SlideshowSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * AL4 (docs/ALBUMS.md §8, §12): the album's slideshow on Android — full screen on black, the screen kept on
 * (FLAG_KEEP_SCREEN_ON) and the system's bars hidden while it runs; 3 / 5 / 10 s, in order or shuffled; a video plays
 * muted to its end, at most 60 s, unless 「動画を飛ばす」. Display-size images, the next two read ahead. A tap shows the
 * controls (close, back, pause, next, the settings).
 */

private const val SLIDESHOW_PREFS = "album.slideshow"

@Composable
internal fun AlbumSlideshow(
    controller: AppController, items: List<DriveItemOut>, start: Int, hasMore: Boolean, loadMore: suspend () -> Unit, onDismiss: () -> Unit,
) {
    var settings by remember { mutableStateOf(SlideshowSettings.decode(controller.prefs.getString(SLIDESHOW_PREFS))) }
    fun change(next: SlideshowSettings) { settings = next; controller.prefs.putString(SLIDESHOW_PREFS, next.encode()) }
    val seed = remember { System.nanoTime() }
    val startIndex = start.coerceIn(0, (items.size - 1).coerceAtLeast(0))
    var currentId by remember { mutableStateOf(items.getOrNull(startIndex)?.id) }
    // The order over what is read; more pages extend it (the same seed keeps the shuffle of what was there).
    val order = remember(items, settings.random, settings.skipVideos) { AlbumRules.slideshowOrder(items, startIndex, settings.random, settings.skipVideos, seed) }
    val index = items.indexOfFirst { it.id == currentId }
    var position = order.indexOf(index)
    if (position < 0 && order.isNotEmpty()) { position = 0; currentId = items[order[0]].id }
    var paused by remember { mutableStateOf(false) }
    var controls by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val latestOrder by rememberUpdatedState(order)
    val latestItems by rememberUpdatedState(items)
    val latestHasMore by rememberUpdatedState(hasMore)
    fun go(step: Int) {
        val now = latestOrder
        if (now.isEmpty()) return
        val at = now.indexOf(latestItems.indexOfFirst { it.id == currentId }).coerceAtLeast(0)
        val next = at + step
        when {
            next in now.indices -> currentId = latestItems[now[next]].id
            next < 0 -> currentId = latestItems[now.last()].id
            latestHasMore && !loading -> scope.launch {
                // The end of what is read: the next page, then on (the order grows by it).
                loading = true
                try { loadMore() } finally { loading = false }
                val grown = latestOrder
                val from = grown.indexOf(latestItems.indexOfFirst { it.id == currentId })
                currentId = latestItems[grown.getOrNull(from + 1) ?: grown[0]].id
            }
            else -> currentId = latestItems[now[0]].id // round again
        }
    }
    val item = items.getOrNull(items.indexOfFirst { it.id == currentId })
    // §6.1: the next two display images read ahead.
    LaunchedEffect(currentId, order) {
        val at = order.indexOf(items.indexOfFirst { it.id == currentId })
        listOf(at + 1, at + 2).mapNotNull { order.getOrNull(it)?.let(items::getOrNull) }.filter { !AlbumRules.isVideo(it) }
            .forEach { next -> next.file?.attachmentId?.let { DisplayBytes.prefetch(controller, AlbumRules.displayPath(it)) } }
    }
    var shown by remember { mutableStateOf<String?>(null) } // the slide whose picture is on screen (its time starts then)
    LaunchedEffect(currentId, shown, paused, settings.interval) {
        val now = item ?: return@LaunchedEffect
        if (paused || shown != now.id) return@LaunchedEffect
        delay(AlbumRules.slideMillis(now, settings.interval))
        go(1) // a video ends earlier by itself (its completion), at most 60 s
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = LocalView.current
        val window = (view.parent as? DialogWindowProvider)?.window
        DisposableEffect(window, view) {
            if (Build.VERSION.SDK_INT >= 28) window?.attributes = window?.attributes?.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            // §12: the screen stays on while the slideshow is shown (only then).
            window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            val bars = window?.let { WindowCompat.getInsetsController(it, view) }
            bars?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            bars?.isAppearanceLightStatusBars = false
            bars?.isAppearanceLightNavigationBars = false
            bars?.hide(WindowInsetsCompat.Type.systemBars())
            onDispose {
                window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                bars?.show(WindowInsetsCompat.Type.systemBars())
            }
        }
        val closeLabel = stringResource(R.string.album_slideshow_close)
        Box(
            Modifier.fillMaxSize().background(Color.Black)
                .pointerInput(Unit) { detectTapGestures(onTap = { controls = !controls }) }
                .semantics { dismiss(closeLabel) { onDismiss(); true } },
        ) {
            if (order.isEmpty() || item == null) {
                Text(stringResource(R.string.album_slideshow_nothing), color = Color.White, modifier = Modifier.align(Alignment.Center).padding(24.dp))
            } else {
                Crossfade(targetState = item, animationSpec = tween(400), label = "slide") { slide ->
                    if (AlbumRules.isVideo(slide)) VideoSlide(controller, slide, paused, onShown = { shown = slide.id }, onEnd = { if (currentId == slide.id) go(1) })
                    else PhotoSlide(controller, slide, onShown = { shown = slide.id }, onFailed = { if (currentId == slide.id) go(1) })
                }
            }
            AnimatedVisibility(controls, Modifier.fillMaxSize(), enter = fadeIn(), exit = fadeOut()) {
                Box(Modifier.fillMaxSize()) {
                    Row(
                        Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.5f)).windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, closeLabel, tint = Color.White) }
                        Column(Modifier.weight(1f)) {
                            item?.let { Text(it.name, color = Color.White, style = MaterialTheme.typography.bodyMedium, maxLines = 1) }
                            if (order.isNotEmpty()) Text("${position + 1} / ${order.size}" + if (hasMore) "+" else "", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelSmall)
                        }
                        SlideshowSettingsMenu(settings, ::change)
                    }
                    Row(
                        Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing).padding(bottom = 24.dp)
                            .background(Color.Black.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(28.dp)).padding(horizontal = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = { go(-1) }) { Icon(Icons.Outlined.SkipPrevious, stringResource(R.string.album_slideshow_previous), tint = Color.White) }
                        IconButton(onClick = { paused = !paused }, modifier = Modifier.size(56.dp)) {
                            Icon(if (paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause,
                                stringResource(if (paused) R.string.album_slideshow_play else R.string.album_slideshow_pause), tint = Color.White, modifier = Modifier.size(32.dp))
                        }
                        IconButton(onClick = { go(1) }) { Icon(Icons.Outlined.SkipNext, stringResource(R.string.album_slideshow_next), tint = Color.White) }
                    }
                }
            }
            if (loading) CircularProgressIndicator(Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp).size(20.dp), color = Color.White, strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun SlideshowSettingsMenu(settings: SlideshowSettings, onChange: (SlideshowSettings) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Outlined.Settings, stringResource(R.string.album_slideshow_settings), tint = Color.White) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            @Composable
            fun Choice(label: String, on: Boolean, onClick: () -> Unit) = DropdownMenuItem(
                text = { Text(label) }, onClick = onClick,
                leadingIcon = { if (on) Icon(Icons.Outlined.Check, null) else Spacer(Modifier.width(24.dp)) },
            )
            AlbumRules.INTERVALS.forEach { seconds ->
                Choice(stringResource(R.string.album_slideshow_seconds, seconds), settings.interval == seconds) { onChange(settings.copy(interval = seconds)) }
            }
            HorizontalDivider()
            Choice(stringResource(R.string.album_slideshow_random), settings.random) { onChange(settings.copy(random = !settings.random)) }
            Choice(stringResource(R.string.album_slideshow_skip_videos), settings.skipVideos) { onChange(settings.copy(skipVideos = !settings.skipVideos)) }
        }
    }
}

/** A photo slide: its display image (the original raster image when it has none), fit to the screen. */
@Composable
private fun PhotoSlide(controller: AppController, item: DriveItemOut, onShown: () -> Unit, onFailed: () -> Unit) {
    var image by remember(item.id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(item.id) {
        val id = item.file?.attachmentId ?: run { onFailed(); return@LaunchedEffect }
        try {
            val bytes = try {
                DisplayBytes.load(controller, AlbumRules.displayPath(id))
            } catch (e: ApiException) {
                if (!AlbumRules.displayMissing(e)) throw e
                controller.fetchBytes(AlbumRules.originalPath(id))
            }
            image = withContext(Dispatchers.Default) { decodePhoto(bytes) }
            if (image == null) onFailed() else onShown()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            delay(1500) // a failure moves on rather than stopping the show
            onFailed()
        }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        image?.let { Image(it, contentDescription = item.name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()) }
            ?: CircularProgressIndicator(color = Color.White)
    }
}

/** A video slide: streamed (its download ticket, Range), muted, to its end (the 60 s limit is the slideshow's timer). */
@Composable
private fun VideoSlide(controller: AppController, item: DriveItemOut, paused: Boolean, onShown: () -> Unit, onEnd: () -> Unit) {
    var url by remember(item.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(item.id) {
        url = try {
            controller.driveStreamUrl(item.id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null.also { delay(1500); onEnd() }
        }
    }
    val latestEnd by rememberUpdatedState(onEnd)
    val latestShown by rememberUpdatedState(onShown)
    val remote = url
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (remote == null) CircularProgressIndicator(color = Color.White)
        else AndroidView(
            factory = { context ->
                VideoView(context).apply {
                    setOnPreparedListener { player ->
                        player.setVolume(0f, 0f) // §8: muted
                        start()
                        latestShown()
                    }
                    setOnCompletionListener { latestEnd() }
                    setOnErrorListener { _, _, _ -> latestEnd(); true }
                    setVideoPath(remote)
                }
            },
            update = { video -> if (paused && video.isPlaying) video.pause() else if (!paused && !video.isPlaying && video.currentPosition > 0) video.start() },
            onRelease = { it.stopPlayback() },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
