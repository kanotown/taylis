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

    // transformed(): one gesture event, as the crop dialog applies it from the first move.

    /** The picture point (in picture pixels) shown at a frame point (relative to the frame's centre). */
    private fun pictureAt(crop: AvatarCrop, px: Float, py: Float, frame: Float = 240f): Pair<Float, Float> {
        val scale = AvatarCrop.scale(w, h, frame, crop.zoom)
        return Pair(w / 2 + (px - crop.x) / scale, h / 2 + (py - crop.y) / scale)
    }

    @Test fun aDragMovesByExactlyTheFingersMotionFromTheFirstEvent() {
        val start = AvatarCrop(2f, 0f, 0f)
        // A 3 px first move is applied in full: no dead zone, no catch-up later.
        val first = start.transformed(1f, 3f, -2f, 10f, 10f, w, h, 240f)
        assertEquals(AvatarCrop(2f, 3f, -2f), first)
        val second = first.transformed(1f, 5f, 1f, 13f, 8f, w, h, 240f)
        assertEquals(AvatarCrop(2f, 8f, -1f), second)
    }

    @Test fun aPinchKeepsThePictureUnderTheCentroid() {
        val start = AvatarCrop(1.5f, 20f, -10f)
        val before = pictureAt(start, 30f, -40f)
        val after = start.transformed(1.2f, 0f, 0f, 30f, -40f, w, h, 240f)
        assertEquals(1.8f, after.zoom, 0.0001f)
        val now = pictureAt(after, 30f, -40f)
        assertEquals(before.first, now.first, 0.01f)
        assertEquals(before.second, now.second, 0.01f)
    }

    @Test fun pinchAndPanTogetherFollowTheMovingCentroid() {
        // The picture point under the old centroid ends up under the new one.
        val start = AvatarCrop(2f, 10f, 10f)
        val before = pictureAt(start, -20f, 15f)
        val after = start.transformed(1.1f, 6f, -4f, -20f, 15f, w, h, 240f)
        val now = pictureAt(after, -14f, 11f)
        assertEquals(before.first, now.first, 0.01f)
        assertEquals(before.second, now.second, 0.01f)
    }

    @Test fun aGestureIsTheSameWhetherItArrivesInOneEventOrMany() {
        val start = AvatarCrop(1.2f, 0f, 0f)
        val whole = start.transformed(1.21f, 8f, 6f, 5f, 5f, w, h, 240f)
        val steps = start.transformed(1.1f, 4f, 3f, 5f, 5f, w, h, 240f).transformed(1.1f, 4f, 3f, 9f, 8f, w, h, 240f)
        assertEquals(whole.zoom, steps.zoom, 0.0001f)
        assertEquals(whole.x, steps.x, 0.01f)
        assertEquals(whole.y, steps.y, 0.01f)
    }

    @Test fun theFrameStaysCoveredAndReversingAtAnEdgeMovesAtOnce() {
        // At zoom 1 the 4000x3000 picture has 40 px of pan each way and none vertically.
        val atEdge = AvatarCrop().transformed(1f, 500f, 30f, 0f, 0f, w, h, 240f)
        assertEquals(AvatarCrop(1f, 40f, 0f), atEdge)
        // No hidden overshoot: the first move back moves the picture.
        assertEquals(AvatarCrop(1f, 35f, 0f), atEdge.transformed(1f, -5f, 0f, 0f, 0f, w, h, 240f))
    }

    @Test fun zoomOutPastOneIsClampedAndStaysCovering() {
        val start = AvatarCrop(1.1f, 40f, 10f)
        val after = start.transformed(0.5f, 0f, 0f, 100f, 100f, w, h, 240f)
        assertEquals(1f, after.zoom)
        assertEquals(AvatarCrop(1f, after.x, after.y).clamped(w, h, 240f), after)
        assertEquals(0f, after.y)
    }

    @Test fun aPinchNearAnEdgeIsClampedOnceNotSnapped() {
        // At the right edge (x 40 of 40), a pinch about a point left of the frame overshoots to x 160 (the limit at
        // zoom 1.5 is 120) while the fingers also move 50 left. Clamping only the result gives 110, where the
        // fingers are; clamping the zoom first (the old zoomed().moved()) lost 40 px and landed at 70.
        val start = AvatarCrop(1f, 40f, 0f)
        assertEquals(AvatarCrop(1.5f, 110f, 0f), start.transformed(1.5f, -50f, 0f, -200f, 0f, w, h, 240f))
        assertEquals(AvatarCrop(1.5f, 70f, 0f), start.zoomed(1.5f, -200f, 0f, w, h, 240f).moved(-50f, 0f, w, h, 240f))
    }
}
