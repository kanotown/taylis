package jp.chikuwachat.android

import jp.chikuwachat.android.ui.EmojiScale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** docs/EMOJI.md §10 (2026-10-27): custom emoji drawn from copies at the pixels they take. */
class EmojiScaleTest {
    @Test fun fittedPixels() {
        // A 72 dp still (216 px at 3x) in the picker's 28 dp cell, a chip's 16 dp, a 3:1 one in a square.
        assertEquals(84 to 84, EmojiScale.fitPixels(216, 216, 84f, 84f))
        assertEquals(48 to 48, EmojiScale.fitPixels(216, 216, 48f, 48f))
        assertEquals(84 to 28, EmojiScale.fitPixels(648, 216, 84f, 84f))
        // A fractional box (16 dp at 2.625x) rounds to whole pixels.
        assertEquals(42 to 42, EmojiScale.fitPixels(216, 216, 42f, 42f))
        assertEquals(42 to 42, EmojiScale.fitPixels(189, 189, 42.0f, 42.4f))
        assertEquals(1 to 1, EmojiScale.fitPixels(0, 10, 10f, 10f))
        // Kept at most 216 high, never enlarged.
        assertEquals(216 to 216, EmojiScale.storedPixels(512, 512, 216))
        assertEquals(648 to 216, EmojiScale.storedPixels(1536, 512, 216))
        assertEquals(128 to 128, EmojiScale.storedPixels(128, 128, 216))
    }

    @Test fun areaAverageKeepsAlphaAndColour() {
        val white = 0xFFFFFFFF.toInt()
        // 2x1 → 1x1: half opaque white, half transparent black: half-transparent white, no grey edge.
        assertEquals(0x80FFFFFF.toInt(), EmojiScale.shrink(intArrayOf(white, 0), 2, 1, 1, 1)[0])
        // 3x1 → 2x1: thirds split between output pixels.
        val red = 0xFFFF0000.toInt(); val blue = 0xFF0000FF.toInt()
        val out = EmojiScale.shrink(intArrayOf(red, red, blue), 3, 1, 2, 1)
        assertEquals(red, out[0])
        assertEquals(0xFF5500AA.toInt(), out[1])
        // Never enlarged.
        assertEquals(4, EmojiScale.shrink(IntArray(4) { white }, 2, 2, 5, 5).size)
    }

    @Test fun oneCopyPerSizeTiedToTheStill() {
        val copies = EmojiScale.DisplayCopies<Any, String>(perStill = 3)
        val still = Any()
        var made = 0
        val first = copies.copy(still, 84, 84) { made++; "84" }
        assertSame(first, copies.copy(still, 84, 84) { made++; "again" })
        copies.copy(still, 48, 48) { made++; "48" }
        assertEquals(2, made)
        assertEquals(2, copies.count(still))
        // A new picture (another still) has its own copies.
        val newer = Any()
        assertEquals("new", copies.copy(newer, 84, 84) { "new" })
        assertEquals(1, copies.count(newer))
        // Bounded: the least recently used size goes.
        copies.copy(still, 30, 30) { "30" }
        copies.copy(still, 84, 84) { "unused" }
        copies.copy(still, 20, 20) { "20" }
        assertEquals(3, copies.count(still))
        assertEquals("84", copies.copy(still, 84, 84) { "remade" })
        assertEquals("48 again", copies.copy(still, 48, 48) { "48 again" })
    }

    /**
     * The reported picture: a 512 px emoji with a thin (4 px) white outline on dark, kept at 216 px and shown in the
     * picker's 84 px cell (28 dp at 3x). Every row and column the outline crosses keeps it at the same strength.
     */
    @Test fun thinOutlineKeptEvenly() {
        val size = 512
        val white = 0xFFFFFFFF.toInt()
        val source = IntArray(size * size) { i ->
            val x = i % size; val y = i / size
            val inRing = x in 40 until 472 && y in 40 until 472 && (x < 44 || x >= 468 || y < 44 || y >= 468)
            if (inRing) white else 0xFF101010.toInt()
        }
        val stored = EmojiScale.shrink(source, size, size, 216, 216)
        val shown = EmojiScale.shrink(stored, 216, 216, 84, 84)
        // The left side of the outline (x 40..44 of 512 → around column 7 of 84), rows well inside the square.
        val rows = 12 until 72
        val strength = rows.map { y -> (0 until 14).sumOf { x -> (shown[y * 84 + x] shr 16) and 0xFF } }
        val spread = strength.max() - strength.min()
        assertTrue("outline strength per row $strength", strength.min() > 0 && spread <= 3)
        // The right side and the top come out as strong as the left one.
        val right = rows.map { y -> (70 until 84).sumOf { x -> (shown[y * 84 + x] shr 16) and 0xFF } }
        val top = rows.map { x -> (0 until 14).sumOf { y -> (shown[y * 84 + x] shr 16) and 0xFF } }
        assertTrue("right $right / top $top vs left $strength", (right + top).all { kotlin.math.abs(it - strength.first()) <= 3 })
    }
}
