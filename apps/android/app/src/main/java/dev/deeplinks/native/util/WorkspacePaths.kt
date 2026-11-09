package dev.deeplinks.native.util

/**
 * Host 路径展示与本轮产出文件分类。
 * 对标 DSH Web：HOME 缩写成 `~`；产出文件按后缀决定预览方式。
 */
private val POSIX_HOME = Regex("^/(?:Users|home)/[^/]+")

fun abbreviateHomePath(path: String?): String {
    if (path.isNullOrBlank()) return ""
    return POSIX_HOME.replace(path.trim(), "~")
}

fun producedFileName(path: String): String {
    val trimmed = path.trim()
    return trimmed.substringAfterLast('/').ifBlank { trimmed }
}

enum class ProducedFileKind { IMAGE, TEXT, PDF, OTHER }

private val IMAGE_EXT = setOf("png", "jpg", "jpeg", "gif", "webp")
private val TEXT_EXT = setOf(
    "md", "txt", "json", "kt", "kts", "js", "ts", "tsx", "jsx",
    "py", "yml", "yaml", "xml", "csv", "html", "css", "sh", "toml", "svg",
)

fun producedFileKind(path: String): ProducedFileKind {
    val ext = path.trim().substringAfterLast('.', missingDelimiterValue = "").lowercase()
    return when (ext) {
        in IMAGE_EXT -> ProducedFileKind.IMAGE
        in TEXT_EXT -> ProducedFileKind.TEXT
        "pdf" -> ProducedFileKind.PDF
        else -> ProducedFileKind.OTHER
    }
}

/**
 * 交给系统应用打开时用的 MIME：插件给的是 octet-stream（老插件不认识的格式）就按后缀补，
 * 否则 WPS / Office / 阅读器会被通用类型挡住。返回空串表示「不知道类型」。
 */
fun mimeForProducedFile(path: String, serverMime: String?): String {
    val clean = serverMime?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    if (clean.isNotEmpty() && clean != "application/octet-stream") return clean
    return when (path.trim().substringAfterLast('.', missingDelimiterValue = "").lowercase()) {
        "pdf" -> "application/pdf"
        "doc" -> "application/msword"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "xls" -> "application/vnd.ms-excel"
        "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        "ppt" -> "application/vnd.ms-powerpoint"
        "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        "odt" -> "application/vnd.oasis.opendocument.text"
        "ods" -> "application/vnd.oasis.opendocument.spreadsheet"
        "odp" -> "application/vnd.oasis.opendocument.presentation"
        "rtf" -> "application/rtf"
        "zip" -> "application/zip"
        "csv" -> "text/csv"
        "md" -> "text/markdown"
        "txt" -> "text/plain"
        "json" -> "application/json"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "svg" -> "image/svg+xml"
        "html" -> "text/html"
        "mp4" -> "video/mp4"
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "wav" -> "audio/wav"
        else -> "application/octet-stream"
    }
}

/** 缓存目录里的文件名：去掉路径分隔与控制字符，避免在外面打开时被拼出奇怪路径。 */
fun safeCacheFileName(path: String): String {
    val name = path.trim().substringAfterLast('/')
        .replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_")
        .trim()
    return name.ifBlank { "file" }
}

fun decodeProducedText(bytes: ByteArray, maxChars: Int = 32_768): String {
    val text = String(bytes, Charsets.UTF_8)
    if (text.length <= maxChars) return text
    return text.take(maxChars) + "…"
}

fun isProducedTextMime(mime: String): Boolean {
    val kind = mime.substringBefore(';').trim().lowercase()
    return kind.startsWith("text/") ||
        kind == "application/json" ||
        kind == "application/xml" ||
        kind.endsWith("+json") ||
        kind.endsWith("+xml")
}

/** 无后缀或未知后缀的文件：前 8KB 无 NUL 且是合法 UTF-8 即按文本预览（Makefile、.env、go/rs 源码等）。 */
fun looksLikeText(bytes: ByteArray): Boolean {
    val head = if (bytes.size > 8192) bytes.copyOf(8192) else bytes
    if (head.any { it == 0.toByte() }) return false
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
    val out = java.nio.CharBuffer.allocate(head.size)
    // 截断时 endOfInput=false：尾部被切开的多字节字符算「未完」而不是非法
    val result = decoder.decode(java.nio.ByteBuffer.wrap(head), out, head.size == bytes.size)
    return !result.isError
}

/** 文件大小：B / KB / MB，一位小数。 */
fun formatFileSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024L * 1024 -> String.format(java.util.Locale.ROOT, "%.1f KB", bytes / 1024.0)
    else -> String.format(java.util.Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024))
}
