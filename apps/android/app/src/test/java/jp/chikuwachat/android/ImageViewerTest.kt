package jp.chikuwachat.android

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
}
