package dev.deeplinks.core

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * 手机上的本地预览代理。只听 127.0.0.1，路径必须带随机密钥。
 * 真正连电脑的部分由调用方经 HostHttp 完成。
 */
internal class PreviewLocalProxy(
    private val exchange: (PreviewForward) -> PreviewHttpResult,
    private val webSocket: (PreviewForward, Socket, () -> Unit) -> Unit,
) {
    val key: String = randomKey()
    private val server = ServerSocket()
    @Volatile private var closed = false
    private var acceptThread: Thread? = null
    private val activeClients = ConcurrentHashMap.newKeySet<Socket>()
    private val workerPool = ThreadPoolExecutor(
        0,
        MAX_PREVIEW_WORKERS,
        30L,
        TimeUnit.SECONDS,
        SynchronousQueue(),
    ) { r -> Thread(r, "dsh-preview").apply { isDaemon = true } }

    val port: Int get() = server.localPort
    val bindAddress: InetAddress get() = server.inetAddress

    fun start() {
        server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
        val thread = Thread({
            while (!closed) {
                val socket = try {
                    server.accept()
                } catch (_: Exception) {
                    break
                }
                if (closed) {
                    runCatching { socket.close() }
                    break
                }
                try {
                    workerPool.execute { handle(socket) }
                } catch (_: Exception) {
                    runCatching {
                        socket.use { writeStatus(it.getOutputStream(), 503, "service unavailable") }
                    }
                }
            }
        }, "dsh-preview-accept")
        thread.isDaemon = true
        acceptThread = thread
        thread.start()
    }

    fun close() {
        closed = true
        runCatching { server.close() }
        for (client in activeClients) {
            runCatching { client.close() }
        }
        activeClients.clear()
        workerPool.shutdownNow()
    }

    fun localUrl(previewId: String): String = "http://127.0.0.1:$port/$key/$previewId/"

    private fun handle(socket: Socket) {
        activeClients.add(socket)
        try {
            socket.use { client ->
                client.soTimeout = 60_000
                val input = client.getInputStream()
                val output = client.getOutputStream()
                val head = readHead(input) ?: return
                val request = parseHead(head) ?: run {
                    writeStatus(output, 400, "bad request")
                    return
                }
                val pluginPath = mapPreviewPath(key, request.path)
                if (pluginPath == null) {
                    writeStatus(output, 404, "not found")
                    return
                }
                val body = if (request.contentLength > 0) {
                    readBody(input, request.contentLength) ?: run {
                        writeStatus(output, 400, "bad request")
                        return
                    }
                } else {
                    ByteArray(0)
                }
                val forward = PreviewForward(
                    method = request.method,
                    pluginPath = pluginPath,
                    headers = request.headers,
                    body = body,
                )
                if (request.websocket) {
                    client.soTimeout = 0
                    val wsKey = request.headers.firstOrNull { it.first.equals("sec-websocket-key", true) }?.second
                    var accepted = false
                    try {
                        webSocket(forward, client) {
                            if (!accepted) {
                                accepted = true
                                writeSwitching(output, wsKey)
                            }
                        }
                    } catch (_: Exception) {
                        // 上游失败时如果还没 101，就回 502。
                    }
                    if (!accepted) writeStatus(output, 502, "bad gateway")
                    return
                }
                val result = try {
                    exchange(forward)
                } catch (_: Exception) {
                    writeStatus(output, 502, "bad gateway")
                    return
                }
                result.use { writeResult(output, it) }
            }
        } finally {
            activeClients.remove(socket)
        }
    }
}

internal data class PreviewForward(
    val method: String,
    val pluginPath: String,
    val headers: List<Pair<String, String>>,
    val body: ByteArray,
)

internal class PreviewHttpResult(
    val status: Int,
    val headers: List<Pair<String, String>>,
    val body: InputStream,
    val contentLength: Long? = null,
) : AutoCloseable {
    override fun close() {
        try { body.close() } catch (_: Exception) {}
    }
}

internal data class WsFrame(val opcode: Int, val payload: ByteArray)

private data class ParsedRequest(
    val method: String,
    val path: String,
    val headers: List<Pair<String, String>>,
    val contentLength: Int,
    val websocket: Boolean,
)

private const val MAX_HEAD = 64 * 1024
private const val MAX_BODY = 8 * 1024 * 1024
private const val MAX_FRAME = 1 * 1024 * 1024
private const val MAX_PREVIEW_WORKERS = 32
private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
private val PREVIEW_ID_REGEX = Regex("^[a-f0-9]{24}$")

internal fun mapPreviewPath(key: String, pathAndQuery: String): String? {
    if (!pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//")) return null
    if (pathAndQuery.any { it.code < 0x20 || it.code == 0x7f || it == '#' }) return null
    val cut = pathAndQuery.indexOf('?')
    val path = if (cut >= 0) pathAndQuery.substring(0, cut) else pathAndQuery
    val query = if (cut >= 0) pathAndQuery.substring(cut) else ""
    if (path.contains('\\') || path.contains("%5c", ignoreCase = true) || path.contains("%2f", ignoreCase = true)) {
        return null
    }
    val parts = path.split('/').filter { it.isNotEmpty() }
    // 恒定时间比较：不让逐字节的提前返回泄露 key 的前缀
    if (parts.size < 2 || !MessageDigest.isEqual(parts[0].toByteArray(), key.toByteArray())) return null
    val id = parts[1]
    if (!PREVIEW_ID_REGEX.matches(id)) return null
    val restParts = parts.drop(2)
    for (seg in restParts) {
        val decoded = percentDecodeSegment(seg) ?: return null
        if (decoded == "." || decoded == ".." || decoded.contains('/') || decoded.contains('\\')) return null
        if (decoded.any { it.code < 0x20 || it.code == 0x7f }) return null
    }
    val rest = restParts.joinToString("/")
    val suffix = if (rest.isEmpty()) "/" else "/$rest"
    return "/dsh-link/mobile/preview/$id$suffix$query"
}

private fun percentDecodeSegment(segment: String): String? {
    val out = ByteArrayOutputStream(segment.length)
    var i = 0
    while (i < segment.length) {
        val c = segment[i]
        if (c == '%') {
            if (i + 2 >= segment.length) return null
            val hi = Character.digit(segment[i + 1], 16)
            val lo = Character.digit(segment[i + 2], 16)
            if (hi < 0 || lo < 0) return null
            out.write((hi shl 4) or lo)
            i += 3
        } else {
            out.write(c.code)
            i++
        }
    }
    return String(out.toByteArray(), Charsets.UTF_8)
}

internal fun readClientFrame(input: InputStream): WsFrame? {
    val b0 = input.read()
    if (b0 < 0) return null
    val b1 = input.read()
    if (b1 < 0) return null
    val opcode = b0 and 0x0f
    var len = (b1 and 0x7f).toLong()
    if (len == 126L) {
        val hi = input.read()
        val lo = input.read()
        if (hi < 0 || lo < 0) return null
        len = ((hi shl 8) or lo).toLong()
    } else if (len == 127L) {
        val ext = ByteArray(8)
        if (!readFully(input, ext)) return null
        var wide = 0L
        for (byte in ext) {
            wide = (wide shl 8) or (byte.toInt() and 0xff).toLong()
        }
        if (wide < 0 || wide > MAX_FRAME) return null
        len = wide
    }
    if (len > MAX_FRAME) return null
    val lenInt = len.toInt()
    val masked = (b1 and 0x80) != 0
    val mask = ByteArray(4)
    if (masked && !readFully(input, mask)) return null
    val payload = ByteArray(lenInt)
    if (lenInt > 0 && !readFully(input, payload)) return null
    if (masked) {
        for (i in payload.indices) {
            payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
        }
    }
    return WsFrame(opcode, payload)
}

internal fun writeServerFrame(output: OutputStream, opcode: Int, payload: ByteArray) {
    if (payload.size > MAX_FRAME) return
    val head = ByteArrayOutputStream(10)
    head.write(0x80 or opcode)
    when {
        payload.size < 126 -> head.write(payload.size)
        payload.size <= 0xffff -> {
            head.write(126)
            head.write(payload.size shr 8)
            head.write(payload.size and 0xff)
        }
        else -> {
            head.write(127)
            val len = payload.size.toLong()
            for (shift in 56 downTo 0 step 8) {
                head.write(((len ushr shift) and 0xffL).toInt())
            }
        }
    }
    output.write(head.toByteArray())
    output.write(payload)
    output.flush()
}

private fun readFully(input: InputStream, buf: ByteArray): Boolean {
    var off = 0
    while (off < buf.size) {
        val n = input.read(buf, off, buf.size - off)
        if (n < 0) return false
        off += n
    }
    return true
}

private fun randomKey(): String {
    val bytes = ByteArray(16)
    SecureRandom().nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

private fun readHead(input: InputStream): String? {
    val out = ByteArrayOutputStream()
    var matched = 0
    while (out.size() < MAX_HEAD) {
        val b = input.read()
        if (b < 0) return null
        out.write(b)
        matched = when {
            matched == 0 && b == '\r'.code -> 1
            matched == 1 && b == '\n'.code -> 2
            matched == 2 && b == '\r'.code -> 3
            matched == 3 && b == '\n'.code -> return String(out.toByteArray(), Charsets.ISO_8859_1)
            else -> if (b == '\r'.code) 1 else 0
        }
    }
    return null
}

private fun parseHead(head: String): ParsedRequest? {
    val lines = head.split("\r\n")
    val request = lines.firstOrNull()?.split(" ") ?: return null
    if (request.size < 2) return null
    val headers = mutableListOf<Pair<String, String>>()
    for (line in lines.drop(1)) {
        if (line.isEmpty()) continue
        val colon = line.indexOf(':')
        if (colon <= 0) continue
        headers += line.substring(0, colon).trim() to line.substring(colon + 1).trim()
    }
    val length = headers.firstOrNull { it.first.equals("content-length", true) }?.second?.toIntOrNull() ?: 0
    if (length !in 0..MAX_BODY) return null
    val upgrade = headers.any { it.first.equals("upgrade", true) && it.second.equals("websocket", true) }
    return ParsedRequest(request[0], request[1], headers, length, upgrade)
}

private fun readBody(input: InputStream, length: Int): ByteArray? {
    val buf = ByteArray(length)
    if (!readFully(input, buf)) return null
    return buf
}

private fun writeStatus(output: OutputStream, code: Int, reason: String) {
    val body = reason.toByteArray()
    val text = "HTTP/1.1 $code $reason\r\ncontent-type: text/plain\r\ncontent-length: ${body.size}\r\nconnection: close\r\n\r\n"
    output.write(text.toByteArray(Charsets.ISO_8859_1))
    output.write(body)
    output.flush()
}

internal fun computeWebSocketAccept(secWebSocketKey: String): String {
    val digest = MessageDigest.getInstance("SHA-1")
        .digest((secWebSocketKey.trim() + WS_GUID).toByteArray(Charsets.ISO_8859_1))
    return Base64.getEncoder().encodeToString(digest)
}

private fun writeSwitching(output: OutputStream, wsKey: String?) {
    val acceptLine = wsKey?.takeIf { it.isNotBlank() && it.none { c -> c == '\r' || c == '\n' } }
        ?.let { "sec-websocket-accept: ${computeWebSocketAccept(it)}\r\n" }
        .orEmpty()
    val text = "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n$acceptLine\r\n"
    output.write(text.toByteArray(Charsets.ISO_8859_1))
    output.flush()
}

private fun writeResult(output: OutputStream, result: PreviewHttpResult) {
    val skip = setOf("connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection")
    val lines = StringBuilder("HTTP/1.1 ${result.status} OK\r\n")
    for ((name, value) in result.headers) {
        if (name.lowercase() in skip) continue
        lines.append(name).append(": ").append(value).append("\r\n")
    }
    lines.append("connection: close\r\n\r\n")
    output.write(lines.toString().toByteArray(Charsets.ISO_8859_1))
    result.body.copyTo(output)
    output.flush()
}
