package jp.chikuwachat.android

import jp.chikuwachat.android.ui.imagePanLimit
import jp.chikuwachat.android.ui.imageSampleSize
import org.junit.Assert.assertEquals
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
}
