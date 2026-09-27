package jp.chikuwachat.android

import jp.chikuwachat.android.ui.AvatarCrop
import org.junit.Assert.assertEquals
import org.junit.Test

/** Same cases as the desktop's avatarCrop.test.ts and iOS AvatarCropTests: the three clients crop alike. */
class AvatarCropTest {
    private val w = 4000f
    private val h = 3000f

    @Test fun startsWithTheCentreSquare() {
        assertEquals(AvatarCrop.Square(500f, 0f, 3000f), AvatarCrop().sourceRect(w, h, 240f))
    }

    @Test fun neverPansPastTheEdges() {
        // 3000 high fits the 240 frame; 4000 wide shows 320, so 40 of pan each way.
        val crop = AvatarCrop(1f, 500f, 30f).clamped(w, h, 240f)
        assertEquals(AvatarCrop(1f, 40f, 0f), crop)
        assertEquals(0f, crop.sourceRect(w, h, 240f).x, 0.001f)
    }

    @Test fun zoomStaysBetweenOneAndFour() {
        assertEquals(1f, AvatarCrop(0.2f).clamped(w, h, 240f).zoom)
        assertEquals(4f, AvatarCrop(9f).clamped(w, h, 240f).zoom)
    }

    @Test fun zoomsAroundThePinchPoint() {
        val before = AvatarCrop().sourceRect(w, h, 240f)
        val after = AvatarCrop().zoomed(2f, -120f, -120f, w, h, 240f).sourceRect(w, h, 240f)
        assertEquals(before.side / 2, after.side, 0.01f)
        assertEquals(before.x, after.x, 0.01f)
        assertEquals(before.y, after.y, 0.01f)
    }
}
