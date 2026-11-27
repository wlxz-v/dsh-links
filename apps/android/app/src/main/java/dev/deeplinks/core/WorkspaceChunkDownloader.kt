package dev.deeplinks.core

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

internal const val DEFAULT_RANGE_CHUNK_BYTES = 2 * 1_048_576
internal const val MAX_WORKSPACE_RANGE_FILE_BYTES = 256L * 1_048_576L
private const val MAX_PRECONDITION_RESETS = 2

internal data class WorkspaceFileHead(
    val totalBytes: Long,
    val etag: String?,
    val mime: String,
    val supportsRanges: Boolean,
)

internal data class WorkspaceFileRangeChunk(
    val bytes: ByteArray,
    val start: Long,
    val endInclusive: Long,
    val totalBytes: Long,
    val etag: String?,
    val mime: String,
    val chunkSha256: String?,
)

internal data class DownloadedWorkspaceFile(
    val file: File,
    val mime: String,
    val totalBytes: Long,
    val etag: String?,
)

internal class RangePreconditionException(message: String) : IllegalStateException(message)

internal interface WorkspaceRangeTransport {
    fun head(): WorkspaceFileHead
    fun fetchRange(start: Long, endInclusive: Long, ifRangeEtag: String?): WorkspaceFileRangeChunk
}

private data class DownloadMeta(
    val etag: String?,
    val totalBytes: Long,
    val offset: Long,
    val mime: String,
)

internal fun hexSha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

internal fun chunkSha256Matches(expectedHex: String?, bytes: ByteArray): Boolean {
    val expected = expectedHex?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return true
    return hexSha256(bytes) == expected
}

private fun normalizeEtag(raw: String?): String =
    raw?.trim()?.removePrefix("W/")?.removePrefix("w/")?.trim()?.trim('"').orEmpty()

internal fun etagsMatch(left: String?, right: String?): Boolean {
    val a = normalizeEtag(left)
    val b = normalizeEtag(right)
    return a.isNotEmpty() && a == b
}

/** 分片下载与断点续传调度器：落盘 `.part` + `.meta`，绝不把超大文件整体装入内存。 */
internal class WorkspaceChunkDownloader(
    private val cacheRootDir: File,
    private val maxFileBytes: Long = MAX_WORKSPACE_RANGE_FILE_BYTES,
    private val chunkBytes: Int = DEFAULT_RANGE_CHUNK_BYTES,
) {
    init {
        require(maxFileBytes > 0L) { "maxFileBytes must be positive" }
        require(chunkBytes > 0) { "chunkBytes must be positive" }
    }

    fun download(
        key: String,
        targetFile: File,
        transport: WorkspaceRangeTransport,
        onProgress: (downloaded: Long, total: Long) -> Unit = { _, _ -> },
    ): DownloadedWorkspaceFile {
        val downloadsDir = File(cacheRootDir, "downloads").apply { mkdirs() }
        targetFile.parentFile?.mkdirs()
        val id = hexSha256(key.toByteArray(Charsets.UTF_8)).take(32)
        val partFile = File(downloadsDir, "$id.part")
        val metaFile = File(downloadsDir, "$id.meta")

        for (attempt in 0..MAX_PRECONDITION_RESETS) {
            val head = transport.head()
            if (head.totalBytes < 0L) throw IOException("invalid content length")
            if (head.totalBytes > maxFileBytes) throw IOException("input too large")
            if (head.totalBytes == 0L) {
                partFile.delete()
                metaFile.delete()
                targetFile.writeBytes(ByteArray(0))
                onProgress(0L, 0L)
                return DownloadedWorkspaceFile(targetFile, head.mime, 0L, head.etag)
            }

            var offset = prepareResumeOffset(metaFile, partFile, head)
            onProgress(offset, head.totalBytes)
            var currentMime = head.mime
            var currentEtag = head.etag
            var resetNeeded = false

            while (offset < head.totalBytes) {
                val end = minOf(offset + chunkBytes.toLong() - 1L, head.totalBytes - 1L)
                val chunk = try {
                    transport.fetchRange(offset, end, currentEtag)
                } catch (_: RangePreconditionException) {
                    partFile.delete()
                    metaFile.delete()
                    resetNeeded = true
                    break
                }
                if (chunk.bytes.isEmpty()) throw IOException("empty range chunk")
                if (chunk.etag != null && currentEtag != null && !etagsMatch(chunk.etag, currentEtag)) {
                    partFile.delete()
                    metaFile.delete()
                    resetNeeded = true
                    break
                }
                if (!chunkSha256Matches(chunk.chunkSha256, chunk.bytes)) {
                    throw IOException("chunk sha256 mismatch")
                }
                if (chunk.mime.isNotBlank()) currentMime = chunk.mime
                if (!chunk.etag.isNullOrBlank()) currentEtag = chunk.etag
                RandomAccessFile(partFile, "rw").use { raf ->
                    raf.seek(offset)
                    raf.write(chunk.bytes)
                    raf.setLength(offset + chunk.bytes.size)
                }
                offset += chunk.bytes.size.toLong()
                writeMeta(metaFile, DownloadMeta(currentEtag, head.totalBytes, offset, currentMime))
                onProgress(offset, head.totalBytes)
            }

            if (resetNeeded) continue
            metaFile.delete()
            moveIntoPlace(partFile, targetFile)
            return DownloadedWorkspaceFile(targetFile, currentMime, head.totalBytes, currentEtag)
        }
        throw IOException("file changed repeatedly while downloading")
    }

    private fun prepareResumeOffset(metaFile: File, partFile: File, head: WorkspaceFileHead): Long {
        val saved = readMeta(metaFile)
        val canResume = saved != null &&
            saved.totalBytes == head.totalBytes &&
            etagsMatch(saved.etag, head.etag) &&
            saved.offset in 0L..head.totalBytes &&
            partFile.isFile &&
            partFile.length() >= saved.offset
        if (canResume) {
            val resumeAt = saved!!.offset
            if (partFile.length() > resumeAt) {
                RandomAccessFile(partFile, "rw").use { it.setLength(resumeAt) }
            }
            return resumeAt
        }
        partFile.delete()
        metaFile.delete()
        writeMeta(metaFile, DownloadMeta(head.etag, head.totalBytes, 0L, head.mime))
        return 0L
    }

    private fun readMeta(metaFile: File): DownloadMeta? {
        if (!metaFile.isFile) return null
        return runCatching {
            val obj = JSONObject(metaFile.readText(Charsets.UTF_8))
            DownloadMeta(
                etag = obj.optString("etag").takeIf { it.isNotBlank() },
                totalBytes = obj.getLong("totalBytes"),
                offset = obj.getLong("offset"),
                mime = obj.optString("mime").ifBlank { "application/octet-stream" },
            )
        }.getOrNull()
    }

    private fun writeMeta(metaFile: File, meta: DownloadMeta) {
        val obj = JSONObject().apply {
            put("etag", meta.etag ?: "")
            put("totalBytes", meta.totalBytes)
            put("offset", meta.offset)
            put("mime", meta.mime)
        }
        metaFile.writeText(obj.toString(), Charsets.UTF_8)
    }

    private fun moveIntoPlace(partFile: File, targetFile: File) {
        try {
            Files.move(partFile.toPath(), targetFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            if (targetFile.exists()) targetFile.delete()
            if (!partFile.renameTo(targetFile)) {
                partFile.copyTo(targetFile, overwrite = true)
                partFile.delete()
            }
        }
    }
}
