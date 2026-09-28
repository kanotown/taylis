package jp.chikuwachat.android

import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.ui.unit.IntSize
import jp.chikuwachat.android.ui.KeyboardBehavior
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The thread list keeps its bottom edge when the keyboard or the input changes its height (KeyboardBehavior.kt). */
class KeyboardBehaviorTest {
    private class Item(override val index: Int, override val offset: Int, override val size: Int) : LazyListItemInfo {
        override val key: Any get() = index
        override val contentType: Any? get() = null
    }

    private class Layout(height: Int, override val visibleItemsInfo: List<LazyListItemInfo>, override val totalItemsCount: Int) : LazyListLayoutInfo {
        override val viewportStartOffset = 0
        override val viewportEndOffset = height
        override val viewportSize = IntSize(1080, height)
        override val orientation = Orientation.Vertical
        override val reverseLayout = false
        override val beforeContentPadding = 0
        override val afterContentPadding = 0
        override val mainAxisItemSpacing = 0
    }

    @Test
    fun atTheEndTheNewestReplyStaysAboveTheKeyboard() {
        // 2000 px tall, the last reply (index 9) ends 20 px above the bottom; the keyboard takes 800 px.
        val before = Layout(2000, listOf(Item(7, 900, 400), Item(8, 1300, 380), Item(9, 1680, 300)), 10)
        // The list keeps its top: the rows stay where they were, the last one now 780 px below the bottom edge.
        val after = Layout(1200, listOf(Item(7, 900, 400), Item(8, 1300, 380)), 10)
        assertEquals(800f, KeyboardBehavior.keepBottomScroll(before, after))
    }

    @Test
    fun higherUpTheRowJustAboveTheInputStaysThere() {
        // Row 5 is the last one shown in full (ends 50 px above the bottom); row 6 is cut by the bottom edge.
        val before = Layout(2000, listOf(Item(4, 1000, 500), Item(5, 1500, 450), Item(6, 1950, 400)), 30)
        val after = Layout(1200, listOf(Item(3, 700, 300), Item(4, 1000, 500)), 30)
        assertEquals(800f, KeyboardBehavior.keepBottomScroll(before, after))
        // The keyboard going away: the list already filled the taller space by itself, so only the rest is scrolled.
        val up = Layout(1200, listOf(Item(4, 200, 500), Item(5, 700, 450)), 30) // row 5 ends 50 px above the bottom
        val down = Layout(2000, listOf(Item(4, 1000, 500), Item(5, 1500, 450), Item(6, 1950, 400)), 30)
        assertEquals(0f, KeyboardBehavior.keepBottomScroll(up, down) ?: 0f)
    }

    @Test
    fun nothingToKeepWhenTheHeightIsTheSame() {
        val layout = Layout(2000, listOf(Item(0, 0, 400)), 1)
        assertNull(KeyboardBehavior.keepBottomScroll(layout, layout))
    }
}
