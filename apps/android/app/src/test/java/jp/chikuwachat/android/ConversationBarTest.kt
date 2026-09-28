package jp.chikuwachat.android

import jp.chikuwachat.android.ui.ConversationBar
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M25 (MUI-1): the thread's follow chip keeps its label only where 「スレッド」 still fits beside it. The widths (dp) are
 * the ones the Pixel 9 emulator laid out: 「スレッド」 65 and 「フォロー中」 71 at font scale 1, 82 and 92 at 1.3.
 */
class ConversationBarTest {
    @Test
    fun at360dpOnlyTheBellShows() {
        // The labelled chip cut the title to 「スレ…」 here.
        assertFalse(ConversationBar.followLabelFits(barWidth = 360f, title = 65f, label = 71f))
    }

    @Test
    fun aPixel9KeepsTheLabel() {
        assertTrue(ConversationBar.followLabelFits(barWidth = 411f, title = 65f, label = 71f))
    }

    @Test
    fun aLargerFontDropsTheLabelFirst() {
        assertFalse(ConversationBar.followLabelFits(barWidth = 411f, title = 82f, label = 92f))
    }

    @Test
    fun aTabletKeepsTheLabelEvenAtTwiceTheFont() {
        assertTrue(ConversationBar.followLabelFits(barWidth = 800f, title = 130f, label = 142f))
    }
}
