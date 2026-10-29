package jp.chikuwachat.android

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import jp.chikuwachat.android.ui.Checkerboard
import jp.chikuwachat.android.ui.ImageChrome
import jp.chikuwachat.android.ui.ImageDismiss
import jp.chikuwachat.android.ui.ImageDismiss.Gesture.PULL
import jp.chikuwachat.android.ui.ImageDismiss.Gesture.TRANSFORM
import jp.chikuwachat.android.ui.imagePanLimit
import jp.chikuwachat.android.ui.imageSampleSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageViewerTest {
    @Test fun decodeIsBoundedForLargeImagesAndPanoramas() {
        assertEquals(1, imageSampleSize(1200, 800))
        assertEquals(2, imageSampleSize(4000, 3000))
        assertEquals(4, imageSampleSize(16000, 1000))
        assertEquals(1, imageSampleSize(-1, -1))
    }

    @Test fun panningKeepsTheFittedImageInsideItsViewport() {
        val fit = imagePanLimit(900, 600, 400, 800, 1f)
        assertEquals(0f, fit.x, 0.01f)
        assertEquals(0f, fit.y, 0.01f)
        val zoom = imagePanLimit(900, 600, 400, 800, 4f)
        assertEquals(600f, zoom.x, 0.01f)
        assertEquals(133.33f, zoom.y, 0.02f)
    }

    @Test fun aOneFingerDownwardDragOnAPhotoThatIsNotZoomedPullsIt() {
        assertEquals(PULL, ImageDismiss.decide(dx = 2f, dy = 20f, scale = 1f, pointers = 1))
        assertEquals(PULL, ImageDismiss.decide(dx = -15f, dy = 16f, scale = 1f, pointers = 1)) // a slant, more down than across
    }

    @Test fun sidewaysUpwardsPinchedOrZoomedDragsStayWithZoomAndPan() {
        assertEquals(TRANSFORM, ImageDismiss.decide(dx = 20f, dy = 10f, scale = 1f, pointers = 1))  // sideways (the next photo)
        assertEquals(TRANSFORM, ImageDismiss.decide(dx = -20f, dy = 20f, scale = 1f, pointers = 1)) // a 45° tie goes sideways
        assertEquals(TRANSFORM, ImageDismiss.decide(dx = 0f, dy = -20f, scale = 1f, pointers = 1))  // upwards
        assertEquals(TRANSFORM, ImageDismiss.decide(dx = 0f, dy = 20f, scale = 2.5f, pointers = 1)) // zoomed: pans
        assertEquals(TRANSFORM, ImageDismiss.decide(dx = 0f, dy = 20f, scale = 1f, pointers = 2))   // a pinch
    }

    @Test fun aTapTogglesTheBarsButNotWhileTalkBackExploresNorBeforeThePhotoIsThere() {
        assertFalse(ImageChrome.toggled(wanted = true, touchExploration = false))
        assertTrue(ImageChrome.toggled(wanted = false, touchExploration = false))
        assertTrue(ImageChrome.toggled(wanted = true, touchExploration = true))
        assertFalse(ImageChrome.shown(wanted = false, touchExploration = false, loaded = true))
        assertTrue(ImageChrome.shown(wanted = true, touchExploration = false, loaded = true))
        // TalkBack turned on while hidden: the controls come back; loading or an error: they stay.
        assertTrue(ImageChrome.shown(wanted = false, touchExploration = true, loaded = true))
        assertTrue(ImageChrome.shown(wanted = false, touchExploration = false, loaded = false))
    }

    @Test fun theCheckerboardIsThePhotosFittedRectangle() {
        // A wide photo on a tall screen: the full width, centred vertically (PREVIEWS.md §15).
        assertRect(Rect(Offset(0f, 324.5f), Size(390f, 195f)), Checkerboard.fitted(200, 100, 390f, 844f))
        assertRect(Rect(Offset(89.5f, 0f), Size(211f, 844f)), Checkerboard.fitted(100, 400, 390f, 844f))
        assertEquals(Rect.Zero, Checkerboard.fitted(0, 0, 390f, 844f))
    }

    @Test fun theDarkSquaresAlternateAndStayInsideThePhoto() {
        val rect = Rect(10f, 20f, 30f, 36f)  // 20 × 16: 3 columns (the last cut) and 2 rows of 8
        val cells = darkCells(rect, 8f)
        assertEquals(listOf(Rect(18f, 20f, 26f, 28f), Rect(10f, 28f, 18f, 36f), Rect(26f, 28f, 30f, 36f)), cells)
        assertTrue(cells.all { it.left >= rect.left && it.right <= rect.right && it.top >= rect.top && it.bottom <= rect.bottom })
        assertTrue(darkCells(Rect.Zero, 8f).isEmpty())
        assertTrue(darkCells(rect, 0f).isEmpty())
        // Zoomed in, only the squares on the screen are drawn, on the same grid.
        assertEquals(listOf(Rect(26f, 28f, 30f, 36f)), darkCells(rect, 8f, visible = Rect(27f, 30f, 40f, 40f)))
        assertTrue(darkCells(rect, 8f, visible = Rect(100f, 100f, 200f, 200f)).isEmpty())
    }

    @Test fun theVisiblePartOfAZoomedPhotosLayer() {
        val size = Size(400f, 800f)
        assertEquals(Rect(0f, 0f, 400f, 800f), Checkerboard.visible(size, 1f, Offset.Zero))
        // 2×: the middle half; moved 100 px right, the part 50 px further left.
        assertEquals(Rect(100f, 200f, 300f, 600f), Checkerboard.visible(size, 2f, Offset.Zero))
        assertEquals(Rect(50f, 200f, 250f, 600f), Checkerboard.visible(size, 2f, Offset(100f, 0f)))
    }

    private fun assertRect(expected: Rect, actual: Rect) {
        assertEquals(expected.left, actual.left, 0.01f)
        assertEquals(expected.top, actual.top, 0.01f)
        assertEquals(expected.right, actual.right, 0.01f)
        assertEquals(expected.bottom, actual.bottom, 0.01f)
    }

    private fun darkCells(rect: Rect, cell: Float, visible: Rect = rect): List<Rect> {
        val out = mutableListOf<Rect>()
        Checkerboard.forEachDarkCell(rect, cell, visible) { l, t, r, b -> out += Rect(l, t, r, b) }
        return out
    }
}
