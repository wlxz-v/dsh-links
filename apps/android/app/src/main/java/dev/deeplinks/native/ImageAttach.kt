package dev.deeplinks.native

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.Base64
import dev.deeplinks.core.BoundedIo
import dev.deeplinks.native.util.IMAGE_MAX_BYTES
import dev.deeplinks.native.util.IMAGE_MAX_EDGE
import dev.deeplinks.native.util.IMAGE_TARGET_BYTES
import dev.deeplinks.native.util.inSampleSize
import dev.deeplinks.native.util.redactUriForLog
import dev.deeplinks.native.util.scaledSize
import dev.deeplinks.native.util.viewfinderCropOnBitmap
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream

object ImageAttach {
    private const val TAG = "dsh-image"

    /** 原图落盘临时文件的上限：超过则拒绝，避免相机 200MP / 长全景图打爆存储或内存。 */
    private const val MAX_SOURCE_BYTES = 64L * 1024 * 1024

    /**
     * 把 provider 流式落盘到临时文件再按文件解码，避免在 JVM 堆上同时持有 64~192MB 字节缓冲，
     * 同时绕开 HyperOS 安全访问 / MIUI 相册 provider 不支持流 seek 的差异。
     */
    private fun copyToTempFile(context: Context, input: InputStream): File {
        val tmp = File.createTempFile("img-attach-", ".tmp", context.cacheDir)
        try {
            val written = tmp.outputStream().use { sink -> BoundedIo.copy(input, sink, MAX_SOURCE_BYTES) }
            if (written <= 0L) {
                tmp.delete()
                throw IOException("empty image stream")
            }
            return tmp
        } catch (e: Exception) {
            tmp.delete()
            throw e
        }
    }

    /** 逐个尝试 content provider 的三种打开方式，返回第一份非空临时文件。 */
    private fun readToTempFile(context: Context, uri: Uri): File? {
        val attempts: List<() -> File?> = listOf(
            { context.contentResolver.openInputStream(uri)?.use { copyToTempFile(context, it) } },
            {
                context.contentResolver.openFileDescriptor(uri, "r")?.use { pfd ->
                    android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd).use { copyToTempFile(context, it) }
                }
            },
            {
                context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                    afd.createInputStream().use { copyToTempFile(context, it) }
                }
            },
        )
        for (attempt in attempts) {
            val file = try {
                attempt()
            } catch (e: Exception) {
                android.util.Log.w(
                    TAG,
                    "read failed uri=${redactUriForLog(uri.toString())} " +
                        "auth=${uri.authority}: ${e.javaClass.simpleName} ${e.message}",
                )
                null
            }
            if (file != null && file.length() > 0L) return file
            file?.delete()
        }
        return null
    }

    /** HyperOS 安全访问 provider 的兜底：整图字节读不到时，尽力取一张系统缩略图。 */
    private fun loadThumbnail(context: Context, uri: Uri): Bitmap? {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) return null
        return try {
            val thumb = context.contentResolver.loadThumbnail(
                uri,
                android.util.Size(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE),
                null,
            ) ?: return null
            val (w, h) = scaledSize(thumb.width, thumb.height)
            if (w == thumb.width && h == thumb.height) thumb
            else Bitmap.createScaledBitmap(thumb, w, h, true).also {
                if (it !== thumb && !thumb.isRecycled) thumb.recycle()
            }
        } catch (e: Exception) {
            android.util.Log.w(TAG, "loadThumbnail failed: ${redactUriForLog(uri.toString())}", e)
            null
        }
    }

    fun decode(context: Context, uri: Uri): Bitmap {
        val tempFile = readToTempFile(context, uri)
            ?: throw IOException("image stream unavailable (${uri.scheme}://${uri.authority})")
        try {
            val size = tempFile.length()
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(tempFile.path, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                loadThumbnail(context, uri)?.let { return it }
                throw IOException("image decode failed (${size}B ${uri.authority})")
            }

            val sample = inSampleSize(bounds.outWidth, bounds.outHeight)
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            val raw = BitmapFactory.decodeFile(tempFile.path, opts)
                ?: loadThumbnail(context, uri)
                ?: throw IOException("image decode failed (${size}B ${uri.authority})")

            val rotated = rotate(raw, exifRotation(tempFile))
            val (w, h) = scaledSize(rotated.width, rotated.height)
            return if (w == rotated.width && h == rotated.height) rotated
            else Bitmap.createScaledBitmap(rotated, w, h, true).also {
                if (it !== rotated && !rotated.isRecycled) rotated.recycle()
            }
        } finally {
            runCatching { tempFile.delete() }
        }
    }

    fun crop(bitmap: Bitmap, viewW: Float, viewH: Float, scale: Float, offsetX: Float, offsetY: Float): Bitmap {
        val rect = viewfinderCropOnBitmap(viewW, viewH, bitmap.width, bitmap.height, scale, offsetX, offsetY)
        return Bitmap.createBitmap(bitmap, rect.left, rect.top, rect.width, rect.height)
    }

    fun toPending(bitmap: Bitmap): Pair<String, String> {
        val jpeg = compressJpeg(bitmap)
        if (jpeg.size > IMAGE_MAX_BYTES) throw IOException("image exceeds 8 MiB")
        val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
        return "image/jpeg" to b64
    }

    fun compressJpeg(bitmap: Bitmap, targetBytes: Int = IMAGE_TARGET_BYTES, maxBytes: Int = IMAGE_MAX_BYTES): ByteArray {
        var quality = 85
        var out: ByteArray
        do {
            val stream = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)
            out = stream.toByteArray()
            quality -= 15
        } while (out.size > targetBytes && quality >= 55)
        if (out.size > maxBytes) {
            val stream = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 40, stream)
            out = stream.toByteArray()
        }
        return out
    }

    private fun exifRotation(file: File): Int {
        return try {
            val exif = ExifInterface(file.path)
            when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90
                ExifInterface.ORIENTATION_ROTATE_180 -> 180
                ExifInterface.ORIENTATION_ROTATE_270 -> 270
                else -> 0
            }
        } catch (_: Exception) {
            0
        }
    }

    private fun rotate(bitmap: Bitmap, degrees: Int): Bitmap {
        if (degrees == 0) return bitmap
        val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also {
            if (it !== bitmap && !bitmap.isRecycled) bitmap.recycle()
        }
    }
}
