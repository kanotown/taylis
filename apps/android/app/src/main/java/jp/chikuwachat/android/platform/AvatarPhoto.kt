package jp.chikuwachat.android.platform

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import jp.chikuwachat.android.ui.AvatarCrop
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** Picked photos for the profile picture (M16g): decoded small and upright, then the chosen square as a JPEG. */
object AvatarPhoto {
    /**
     * At most [maxPixel] on the longer side, upright (EXIF applied): a large photo never lands in memory whole.
     * null when the picture cannot be read (HEIC on an old phone, a broken file…).
     */
    fun decode(resolver: ContentResolver, uri: Uri, maxPixel: Int = 2048): Bitmap? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                val longer = max(info.size.width, info.size.height)
                if (longer > maxPixel) {
                    val ratio = maxPixel.toFloat() / longer
                    decoder.setTargetSize(max(1, (info.size.width * ratio).roundToInt()), max(1, (info.size.height * ratio).roundToInt()))
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // drawn on a software canvas by render()
            }
        } else {
            decodeLegacy(resolver, uri, maxPixel)
        }
    }.getOrNull()

    /** API 26–27: sample down while decoding, then turn by the EXIF orientation ourselves. */
    private fun decodeLegacy(resolver: ContentResolver, uri: Uri, maxPixel: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxPixel) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
        val degrees = resolver.openInputStream(uri)?.use {
            when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        } ?: 0f
        if (degrees == 0f) return bitmap
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(degrees) }, true)
            .also { if (it !== bitmap) bitmap.recycle() }
    }

    /** The chosen square as a 512 px JPEG; a transparent picture gets a white background. */
    fun render(bitmap: Bitmap, crop: AvatarCrop, frame: Float): ByteArray {
        val rect = crop.sourceRect(bitmap.width.toFloat(), bitmap.height.toFloat(), frame)
        val out = Bitmap.createBitmap(AvatarCrop.OUTPUT, AvatarCrop.OUTPUT, Bitmap.Config.ARGB_8888)
        Canvas(out).apply {
            drawColor(Color.WHITE)
            val source = Rect(rect.x.roundToInt(), rect.y.roundToInt(), (rect.x + rect.side).roundToInt(), (rect.y + rect.side).roundToInt())
            drawBitmap(bitmap, source, RectF(0f, 0f, AvatarCrop.OUTPUT.toFloat(), AvatarCrop.OUTPUT.toFloat()), Paint(Paint.FILTER_BITMAP_FLAG))
        }
        return ByteArrayOutputStream().use { stream ->
            out.compress(Bitmap.CompressFormat.JPEG, 90, stream)
            out.recycle()
            stream.toByteArray()
        }
    }
}
