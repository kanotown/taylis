package jp.chikuwachat.android.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity

/**
 * How a conversation lives with the keyboard, as on iOS (KeyboardBehavior.swift):
 * - when the list's height changes (the keyboard coming or going, the input growing to several lines) its bottom edge
 *   stays: at the end the newest message stays just above the input, higher up the row that was just above it stays
 *   there ([KeepBottomOnResize]; the channel's list is laid out from the bottom and does this by itself);
 * - a tap on the list closes the keyboard ([closesKeyboardOnTap]), besides the system back, and does nothing else:
 *   not on a message (which a tap otherwise opens the thread of), nor on what is in its row (the avatar or name that
 *   open the profile, reactions, links, attachments). The next tap acts as usual (2026-10-26).
 */
object KeyboardBehavior {
    /**
     * Whether the keyboard was up when the list's latest touch came down ([closesKeyboardOnTap]): that tap only closes
     * it. Asked when the row gets the tap, the window already says the keyboard is gone.
     */
    var upAtTouch = false
        internal set

    /** What a finished touch on the list does ([closesKeyboardOnTap]). */
    enum class TapOutcome {
        /** A drag, a long press or a pinch: left alone (the list scrolls, the message's menu opens). */
        NONE,

        /** A tap with no keyboard (or a hardware one, which has no inset): clears the focus, the row gets the tap. */
        CLEAR_FOCUS,

        /** A tap while the on-screen keyboard was up: only closes it; the row (or the avatar, a link...) gets nothing. */
        CLOSE_ONLY,
    }

    fun tapOutcome(keyboardUpAtDown: Boolean, moved: Boolean, heldMillis: Long, longPressMillis: Long, multiTouch: Boolean): TapOutcome = when {
        moved || multiTouch || heldMillis > longPressMillis -> TapOutcome.NONE
        keyboardUpAtDown -> TapOutcome.CLOSE_ONLY
        else -> TapOutcome.CLEAR_FOCUS
    }

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
 * Whether the keyboard is up now, for a touch handler: the keyboard's inset, read when called. (The window's insets did
 * not report the keyboard on this app's window.)
 */
@Composable
fun rememberKeyboardUp(): () -> Boolean {
    val ime = WindowInsets.ime
    val density = LocalDensity.current
    return remember(ime, density) { { ime.getBottom(density) > 0 } }
}

/**
 * Closes the keyboard on a tap (`LocalFocusManager.current`), watching the touches before the rows do. A drag or a long
 * press (a message's menu) is not a tap, and is never consumed, so scrolling and the menu work with the keyboard up. A
 * tap that came down while the on-screen keyboard was up ([rememberKeyboardUp]; a hardware keyboard has no inset) only
 * closes it: its lifting is consumed in the Initial pass, so no click inside the list (the row, the avatar, the name,
 * a reaction, a link, an attachment) fires; their press is cancelled ([KeyboardBehavior.tapOutcome]). Notes whether
 * the keyboard was up as the touch came down ([KeyboardBehavior.upAtTouch]).
 */
fun Modifier.closesKeyboardOnTap(focusManager: FocusManager, keyboardUp: () -> Boolean): Modifier =
    pointerInput(focusManager, keyboardUp) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val upAtDown = keyboardUp()
            KeyboardBehavior.upAtTouch = upAtDown
            var moved = false
            var multiTouch = false
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                if (event.changes.count { it.pressed } > 1) multiTouch = true
                val change = event.changes.firstOrNull { it.id == down.id } ?: return@awaitEachGesture
                // Once past the slop it stays a drag, even if the finger comes back to where it started.
                if ((change.position - down.position).getDistance() > viewConfiguration.touchSlop) moved = true
                if (change.pressed) continue
                val outcome = KeyboardBehavior.tapOutcome(
                    keyboardUpAtDown = upAtDown,
                    moved = moved,
                    heldMillis = change.uptimeMillis - down.uptimeMillis,
                    longPressMillis = viewConfiguration.longPressTimeoutMillis,
                    multiTouch = multiTouch,
                )
                if (outcome == KeyboardBehavior.TapOutcome.CLOSE_ONLY) change.consume()
                if (outcome != KeyboardBehavior.TapOutcome.NONE) focusManager.clearFocus()
                return@awaitEachGesture
            }
        }
    }
