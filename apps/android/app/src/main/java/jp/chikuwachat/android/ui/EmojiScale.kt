package jp.chikuwachat.android.ui

import java.util.WeakHashMap
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Custom emoji drawn at the pixels they take (docs/EMOJI.md §10, 2026-10-27). Pure Kotlin on ARGB ints so the JVM tests
 * can run it: the picker's 28 dp cells, a reaction chip's 16 dp and a line of text showed the 72 dp still scaled down by
 * plain filtering, which dropped parts of a thin white outline — other parts at each sub-pixel move, so on a dark
 * background the outline shimmered.
 */
object EmojiScale {
    /** The whole pixels a [width] × [height] picture takes fitted (its ratio kept) into a [boxWidth] × [boxHeight] px box. */
    fun fitPixels(width: Int, height: Int, boxWidth: Float, boxHeight: Float): Pair<Int, Int> {
        if (width <= 0 || height <= 0 || boxWidth <= 0f || boxHeight <= 0f) return 1 to 1
        val fit = min(boxWidth / width, boxHeight / height)
        return max((width * fit).roundToInt(), 1) to max((height * fit).roundToInt(), 1)
    }

    /** The size a [width] × [height] picture is kept at: at most [maxHeight] high, its ratio kept (never enlarged). */
    fun storedPixels(width: Int, height: Int, maxHeight: Int): Pair<Int, Int> {
        if (height <= maxHeight || height <= 0 || maxHeight <= 0) return width to height
        return max((width.toFloat() * maxHeight / height).roundToInt(), 1) to maxHeight
    }

    /**
     * [pixels] ([width] × [height], non-premultiplied ARGB as `Bitmap.getPixels` gives them) shrunk to [newWidth] ×
     * [newHeight] by area averaging: every output pixel is the alpha-weighted mean of exactly the source area it covers,
     * so every source pixel counts and a thin outline stays, evenly, wherever it falls. Never enlarges (each axis is
     * clamped to the source).
     */
    fun shrink(pixels: IntArray, width: Int, height: Int, newWidth: Int, newHeight: Int): IntArray {
        require(width > 0 && height > 0 && pixels.size >= width * height)
        val dw = min(max(newWidth, 1), width)
        val dh = min(max(newHeight, 1), height)
        if (dw == width && dh == height) return pixels.copyOf(width * height)
        val xs = spans(width, dw)
        val ys = spans(height, dh)
        // Horizontal pass, premultiplied (a transparent pixel's colour must not bleed into the edge).
        val mid = FloatArray(dw * height * 4)
        for (y in 0 until height) {
            val row = y * width
            for (x in 0 until dw) {
                val span = xs[x]
                var a = 0f; var r = 0f; var g = 0f; var b = 0f
                for (i in span.weights.indices) {
                    val c = pixels[row + span.start + i]
                    val ca = (c ushr 24) * span.weights[i]
                    a += ca
                    r += ((c shr 16) and 0xFF) * ca
                    g += ((c shr 8) and 0xFF) * ca
                    b += (c and 0xFF) * ca
                }
                val o = (y * dw + x) * 4
                mid[o] = a; mid[o + 1] = r; mid[o + 2] = g; mid[o + 3] = b
            }
        }
        val out = IntArray(dw * dh)
        for (y in 0 until dh) {
            val span = ys[y]
            for (x in 0 until dw) {
                var a = 0f; var r = 0f; var g = 0f; var b = 0f
                for (i in span.weights.indices) {
                    val o = ((span.start + i) * dw + x) * 4
                    val w = span.weights[i]
                    a += mid[o] * w; r += mid[o + 1] * w; g += mid[o + 2] * w; b += mid[o + 3] * w
                }
                val alpha = a.roundToInt().coerceIn(0, 255)
                out[y * dw + x] = if (alpha == 0) 0 else (alpha shl 24) or (channel(r / a) shl 16) or (channel(g / a) shl 8) or channel(b / a)
            }
        }
        return out
    }

    private fun channel(value: Float) = value.roundToInt().coerceIn(0, 255)

    /** One output pixel's source pixels from [start] and the share of each (they add up to 1). */
    private class Span(val start: Int, val weights: FloatArray)

    private fun spans(source: Int, target: Int): Array<Span> {
        val step = source.toDouble() / target
        return Array(target) { i ->
            val from = i * step
            val to = min((i + 1) * step, source.toDouble())
            val first = from.toInt()
            val last = min(ceil(to).toInt(), source) - 1
            Span(first, FloatArray(last - first + 1) { k ->
                val px = first + k
                ((min(to, px + 1.0) - max(from, px.toDouble())) / step).toFloat()
            })
        }
    }

    /**
     * The copies of each still at the pixel sizes it is shown at, kept with the still itself (weakly: they go when it
     * goes; a new picture or a redrawn text pill is a new still with new copies, so none can be stale). At most
     * [perStill] sizes each (the picker's cell, a chip, a line of text, a stamp), the least recently used one replaced.
     * Keys are compared by identity (a Bitmap does not override equals).
     */
    class DisplayCopies<K : Any, V : Any>(private val perStill: Int = 4) {
        private val byStill = WeakHashMap<K, LinkedHashMap<Long, V>>()

        @Synchronized
        fun copy(still: K, width: Int, height: Int, make: () -> V): V {
            val sizes = byStill.getOrPut(still) {
                object : LinkedHashMap<Long, V>(perStill + 1, 0.75f, true) {
                    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, V>?) = size > perStill
                }
            }
            val key = (width.toLong() shl 32) or height.toLong()
            return sizes[key] ?: make().also { sizes[key] = it }
        }

        /** How many sizes of [still] are kept (tests). */
        @Synchronized
        fun count(still: K): Int = byStill[still]?.size ?: 0
    }
}
