package jp.chikuwachat.android.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.VectorGroup
import androidx.compose.ui.graphics.vector.VectorPath
import jp.chikuwachat.android.ui.AttendanceIcons

/**
 * The states' icons for the widget: a home-screen widget cannot draw a Compose [ImageVector], so the same Material icon
 * the app draws (AttendanceIcons) is painted once into a small white bitmap, then tinted by the widget (ColorFilter).
 * Kept per key for the process (a few dozen icons at most, a few KB each).
 */
object WidgetIcons {
    private const val PX = 72
    private val cache = HashMap<String, Bitmap>()

    /** The white picture of an icon key, or null (no icon, or a key this app does not know: the emoji is shown). */
    @Synchronized
    fun bitmap(key: String?): Bitmap? {
        val vector = AttendanceIcons.vector(key) ?: return null
        return cache.getOrPut(key!!) { render(vector) }
    }

    /** The white picture of any Material icon (the widgets' row and kind glyphs), kept under [key]. */
    @Synchronized
    fun bitmap(key: String, vector: ImageVector): Bitmap = cache.getOrPut("ui:$key") { render(vector) }

    private fun render(vector: ImageVector): Bitmap {
        val bitmap = Bitmap.createBitmap(PX, PX, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.scale(PX / vector.viewportWidth, PX / vector.viewportHeight)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE; style = Paint.Style.FILL }
        draw(canvas, vector.root, paint)
        return bitmap
    }

    private fun draw(canvas: Canvas, group: VectorGroup, paint: Paint) {
        canvas.save()
        canvas.translate(group.translationX + group.pivotX, group.translationY + group.pivotY)
        canvas.rotate(group.rotation)
        canvas.scale(group.scaleX, group.scaleY)
        canvas.translate(-group.pivotX, -group.pivotY)
        for (node in group) {
            when (node) {
                is VectorGroup -> draw(canvas, node, paint)
                is VectorPath -> {
                    val path = PathParser().addPathNodes(node.pathData).toPath().asAndroidPath()
                    path.fillType = if (node.pathFillType == PathFillType.EvenOdd) android.graphics.Path.FillType.EVEN_ODD else android.graphics.Path.FillType.WINDING
                    if (node.fill != null) {
                        paint.style = Paint.Style.FILL
                        paint.alpha = (255 * node.fillAlpha).toInt()
                        canvas.drawPath(path, paint)
                    }
                    if (node.stroke != null && node.strokeLineWidth > 0f) {
                        paint.style = Paint.Style.STROKE
                        paint.strokeWidth = node.strokeLineWidth
                        paint.alpha = (255 * node.strokeAlpha).toInt()
                        canvas.drawPath(path, paint)
                    }
                }
            }
        }
        canvas.restore()
    }
}
