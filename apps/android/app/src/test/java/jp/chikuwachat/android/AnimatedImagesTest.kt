package jp.chikuwachat.android

import androidx.compose.ui.unit.IntSize
import jp.chikuwachat.android.ui.AnimatedImageRules
import jp.chikuwachat.android.ui.AnimatedImageRules.Conditions
import jp.chikuwachat.android.ui.AnimatedTileSlots
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** docs/MOBILE_UI.md §22.10: animated GIFs move in the conversation's tiles and the viewer. */
class AnimatedImagesTest {
    @Test fun whichTilesAreGifs() {
        assertTrue(AnimatedImageRules.isGif("image/gif", "a.bin"))
        assertTrue(AnimatedImageRules.isGif("IMAGE/GIF", "a"))
        assertTrue(AnimatedImageRules.isGif("application/octet-stream", "Party.GIF"))
        assertFalse(AnimatedImageRules.isGif("image/png", "a.png"))
        assertFalse(AnimatedImageRules.isGif("image/webp", "a.webp"))
    }

    @Test fun aTileMovesOnlyWhenNothingKeepsItStill() {
        fun moves(conditions: Conditions, size: Long = 1L shl 20, sdk: Int = 34, type: String = "image/gif") =
            AnimatedImageRules.tileAnimates(type, "a.gif", size, conditions, sdk)
        assertTrue(moves(Conditions()))
        assertFalse(moves(Conditions(reduceMotion = true)))
        assertFalse(moves(Conditions(powerSave = true)))
        assertFalse(moves(Conditions(dataSaver = true)))
        assertTrue(moves(Conditions(), size = AnimatedImageRules.TILE_MAX_BYTES))
        assertFalse(moves(Conditions(), size = AnimatedImageRules.TILE_MAX_BYTES + 1))
        assertFalse(moves(Conditions(), size = 0))
        // Below API 28 there is no AnimatedImageDrawable: the still and the badge.
        assertFalse(moves(Conditions(), sdk = 27))
        assertTrue(moves(Conditions(), sdk = 28))
        assertFalse(AnimatedImageRules.tileAnimates("image/png", "a.png", 100, Conditions(), 34))
    }

    @Test fun onlyGifsAndAnimatedWebpAreDecodedAsAnimations() {
        assertTrue(AnimatedImageRules.mayAnimate("GIF89a\u0001\u0000".toByteArray(Charsets.ISO_8859_1)))
        fun webp(flags: Int) = ("RIFF\u0000\u0000\u0000\u0000WEBPVP8X\u000a\u0000\u0000\u0000" + flags.toChar() + "\u0000\u0000\u0000")
            .toByteArray(Charsets.ISO_8859_1)
        assertTrue(AnimatedImageRules.mayAnimate(webp(0x02)))
        assertTrue(AnimatedImageRules.mayAnimate(webp(0x12)))  // with alpha too
        assertFalse(AnimatedImageRules.mayAnimate(webp(0x10)))  // alpha only: a still WebP
        assertFalse(AnimatedImageRules.mayAnimate(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)))
        assertFalse(AnimatedImageRules.mayAnimate(ByteArray(0)))
    }

    @Test fun framesAreDecodedWithinTheMemoryCaps() {
        assertEquals(IntSize(480, 270), AnimatedImageRules.decodeSize(480, 270))
        // 2048 × 2048 is exactly 16 MB a frame; 4096 × 4096 is decoded at 2048.
        assertEquals(IntSize(2048, 2048), AnimatedImageRules.decodeSize(2048, 2048))
        assertEquals(IntSize(2048, 2048), AnimatedImageRules.decodeSize(4096, 4096))
        val wide = AnimatedImageRules.decodeSize(8000, 2000)
        val bytes = wide.width.toLong() * wide.height * 4
        assertTrue(bytes <= AnimatedImageRules.MAX_FRAME_BYTES)
        assertTrue(bytes > AnimatedImageRules.MAX_FRAME_BYTES * 9 / 10)
        // A tile: no more than fills its box (a wide GIF in a square tile covers its height), never enlarged.
        assertEquals(IntSize(600, 300), AnimatedImageRules.decodeSize(1000, 500, fill = IntSize(300, 300)))
        assertEquals(IntSize(200, 100), AnimatedImageRules.decodeSize(200, 100, fill = IntSize(840, 720)))
    }

    @Test fun onlySoManyTilesMoveAtOnce() {
        val slots = AnimatedTileSlots(limit = 2)
        val a = Any(); val b = Any(); val c = Any()
        assertTrue(slots.claim(a))
        assertTrue(slots.claim(b))
        assertTrue(slots.claim(a)) // already holds one
        assertFalse(slots.claim(c))
        assertEquals(2, slots.count)
        slots.release(a)
        assertTrue(slots.claim(c))
        slots.release(b); slots.release(c)
        assertEquals(0, slots.count)
        assertEquals(3, AnimatedTileSlots.shared.limit)
    }
}
