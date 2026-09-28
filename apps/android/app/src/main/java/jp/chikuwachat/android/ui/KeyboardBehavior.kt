package jp.chikuwachat.android.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput

/**
 * How a conversation lives with the keyboard, as on iOS (KeyboardBehavior.swift):
 * - when the list's height changes (the keyboard coming or going, the input growing to several lines) its bottom edge
 *   stays: at the end the newest message stays just above the input, higher up the row that was just above it stays
 *   there ([KeepBottomOnResize]; the channel's list is laid out from the bottom and does this by itself);
 * - a tap on the list closes the keyboard ([closesKeyboardOnTap]), besides the system back.
 */
object KeyboardBehavior {
    /**
     * How far to scroll (positive: towards the end) so that the row last shown in full above the old bottom edge ends
     * as far above the new bottom edge as it did before. Null when there is nothing to keep (no row, same height).
     */
    fun keepBottomScroll(before: LazyListLayoutInfo, after: LazyListLayoutInfo): Float? {
        if (before.viewportSize.height == after.viewportSize.height) return null
        val row = before.visibleItemsInfo.lastOrNull { it.offset + it.size <= before.viewportEndOffset }
            ?: before.visibleItemsInfo.lastOrNull() ?: return null
        val gapBefore = before.viewportEndOffset - (row.offset + row.size)
        // Where the row is now: laid out again, or (pushed out of the shorter list) where it was, the list's top staying.
        val offsetNow = after.visibleItemsInfo.firstOrNull { it.index == row.index }?.offset ?: row.offset
        val gapNow = after.viewportEndOffset - (offsetNow + row.size)
        return (gapBefore - gapNow).toFloat().takeIf { it != 0f }
    }
}

/** Keeps the list's bottom edge when its height changes ([KeyboardBehavior.keepBottomScroll]). */
@Composable
fun KeepBottomOnResize(listState: LazyListState, enabled: Boolean) {
    LaunchedEffect(listState, enabled) {
        if (!enabled) return@LaunchedEffect
        var previous: LazyListLayoutInfo? = null
        snapshotFlow { listState.layoutInfo }.collect { info ->
            val before = previous
            previous = info
            if (before == null || listState.isScrollInProgress) return@collect
            KeyboardBehavior.keepBottomScroll(before, info)?.let { listState.scrollBy(it) }
        }
    }
}

/**
 * Closes the keyboard on a tap (`LocalFocusManager.current`), watching the touches before the rows do, so their clicks
 * still work. A drag or a long press (a message's menu) is not a tap.
 */
fun Modifier.closesKeyboardOnTap(focusManager: FocusManager): Modifier =
    pointerInput(focusManager) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val up = waitForUpOrCancellation(pass = PointerEventPass.Initial) ?: return@awaitEachGesture
            val moved = (up.position - down.position).getDistance() > viewConfiguration.touchSlop
            val held = up.uptimeMillis - down.uptimeMillis > viewConfiguration.longPressTimeoutMillis
            if (!moved && !held) focusManager.clearFocus()
        }
    }
