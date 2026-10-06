package jp.chikuwachat.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.graphics.createBitmap
import com.agog.mathdisplay.MTFontManager
import com.agog.mathdisplay.parse.MTLineStyle
import com.agog.mathdisplay.parse.MTMathListBuilder
import com.agog.mathdisplay.parse.MTParseError
import com.agog.mathdisplay.parse.MTParseErrors
import com.agog.mathdisplay.render.MTTypesetter
import kotlin.math.ceil
import kotlin.math.max

/**
 * TeX math in bodies and canvases (DATA_MODEL.md 「本文の形式」, apps/shared/math.json), drawn with AndroidMath (MIT, a
 * port of iosMath like the iPhone's SwiftMath; THIRD_PARTY_NOTICES.md) into alpha bitmaps that are tinted with the text's
 * colour, cached by formula, size and style. Inline math is an inline image whose baseline sits on the text's (its box
 * ends at the line's text bottom, the font's descent below the baseline); display math is a block of its own, centred,
 * scrolling sideways when wider than the row. A formula AndroidMath cannot read (or one too large to draw) shows its
 * source in the code style.
 */
object MathRender {
    class Rendered(val bitmap: ImageBitmap, val width: Int, val height: Int)

    /** A drawn formula larger than this (px) is shown as its source instead. */
    private const val MAX_WIDTH = 6000
    private const val MAX_HEIGHT = 2000

    private val failed = Any()
    private val cache = object : LruCache<String, Any>(300) {}

    /**
     * [tex] at [fontPx] (display style when [display]), or null when AndroidMath cannot read or draw it. For inline math
     * ([display] false) the bitmap reaches [fontDescentPx] below the baseline at least, so a box aligned to the text's
     * bottom puts the formula's baseline on the text's.
     */
    fun render(context: Context, tex: String, fontPx: Float, display: Boolean, fontDescentPx: Float = 0f): Rendered? {
        val key = "${if (display) 'D' else 'I'}$fontPx|$fontDescentPx|$tex"
        cache.get(key)?.let { return it as? Rendered }
        val rendered = try {
            draw(context, tex, fontPx, display, fontDescentPx)
        } catch (_: Exception) {
            null // AndroidMath throws on some input it cannot lay out
        }
        cache.put(key, rendered ?: failed)
        return rendered
    }

    private fun draw(context: Context, tex: String, fontPx: Float, display: Boolean, fontDescentPx: Float): Rendered? {
        MTFontManager.setContext(context.applicationContext)
        val error = MTParseError()
        val list = MTMathListBuilder.buildFromString(tex, error) ?: return null
        if (error.errorcode != MTParseErrors.ErrorNone) return null
        val font = MTFontManager.defaultFont()?.copyFontWithSize(fontPx) ?: return null
        val line = MTTypesetter.createLineForMathList(list, font, if (display) MTLineStyle.KMTLineStyleDisplay else MTLineStyle.KMTLineStyleText)
        val descent = max(line.descent, fontDescentPx)
        val width = ceil(line.width).toInt()
        val height = ceil(line.ascent + descent).toInt()
        if (width <= 0 || height <= 0 || width > MAX_WIDTH || height > MAX_HEIGHT) return null
        val bitmap = createBitmap(width, height, Bitmap.Config.ALPHA_8)
        val canvas = Canvas(bitmap)
        line.textColor = android.graphics.Color.BLACK
        line.position.x = 0f
        line.position.y = descent
        // As AndroidMath's MTMathView: the display list draws in a y-up space.
        canvas.translate(0f, height.toFloat())
        canvas.scale(1f, -1f)
        line.draw(canvas)
        return Rendered(bitmap.asImageBitmap(), width, height)
    }

    /** How far the default font reaches below the baseline at [fontPx] (what PlaceholderVerticalAlign.TextBottom meets). */
    fun fontDescent(fontPx: Float): Float = Paint().apply { textSize = fontPx }.fontMetrics.descent
}

/**
 * Display math (`$$…$$` on lines of its own): centred, scrolling sideways when wider than the row; its source when it
 * cannot be drawn. TalkBack reads the TeX.
 */
@Composable
fun MathBlockView(tex: String) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val fontPx = with(density) { MaterialTheme.typography.bodyLarge.fontSize.toPx() } * 1.1f
    val rendered = remember(tex, fontPx) { MathRender.render(context, tex, fontPx, display = true) }
    val color = MaterialTheme.colorScheme.onSurface
    if (rendered == null) {
        Text("$$" + tex + "$$", style = MaterialTheme.typography.bodyMedium.copy(fontFamily = CodeFont), color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    BoxWithConstraints(Modifier.fillMaxWidth().padding(vertical = 4.dp).semantics { contentDescription = tex }) {
        val row = maxWidth
        // In a sideways scroll the content may be any width: at least the row's, so a narrow formula is centred.
        Box(Modifier.horizontalScroll(rememberScrollState())) {
            Box(Modifier.widthIn(min = row), contentAlignment = Alignment.Center) {
                Image(
                    rendered.bitmap,
                    contentDescription = null,
                    colorFilter = ColorFilter.tint(color),
                    modifier = Modifier.size(with(density) { rendered.width.toDp() }, with(density) { rendered.height.toDp() }),
                )
            }
        }
    }
}
