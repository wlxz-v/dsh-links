package dev.deeplinks.core

import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.net.Socket
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private val DROP_REQUEST = setOf(
    "host", "connection", "upgrade", "content-length", "transfer-encoding",
    "authorization", "x-dsh-link-token", "proxy-connection", "keep-alive",
)

/** 把本地预览请求经 HostHttp 转到插件。设备 token 只加在这一跳。 */
internal fun hostPreviewExchange(host: Host, forward: PreviewForward): PreviewHttpResult {
    assertSafePreviewPluginPath(forward.pluginPath)
    val headers = authHeaders(host) + forward.headers.filter { it.first.lowercase(Locale.US) !in DROP_REQUEST }
    val media = forward.headers.firstOrNull { it.first.equals("content-type", true) }?.second
    val response = HostHttp.execute(
        host,
        HostHttp.DshRequest(
            method = forward.method,
            path = forward.pluginPath,
            body = forward.body.takeIf { it.isNotEmpty() },
            headers = headers + listOf("Accept-Encoding" to "identity"),
            readTimeoutMs = 60_000,
            streaming = true,
            bodyMediaType = media,
        ),
    )
    return PreviewHttpResult(
        status = response.code,
        headers = buildList {
            for (i in 0 until response.headers.size) {
                add(response.headers.name(i) to response.headers.value(i))
            }
        },
        body = response.body.byteStream(),
        contentLength = response.body.contentLength().takeIf { it >= 0 },
    )
}

/** 本地 WebSocket 与插件上的预览 WebSocket 互转文本和二进制帧。 */
internal fun hostPreviewWebSocket(host: Host, forward: PreviewForward, client: Socket, accept: () -> Unit) {
    assertSafePreviewPluginPath(forward.pluginPath)
    val ready = CountDownLatch(1)
    val acceptedLatch = CountDownLatch(1)
    val writeLock = Any()
    val failed = AtomicBoolean(false)
    val upstream = AtomicReference<WebSocket?>(null)
    val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            upstream.set(webSocket)
            ready.countDown()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!acceptedLatch.await(10, TimeUnit.SECONDS)) return
            synchronized(writeLock) {
                runCatching { writeServerFrame(client.getOutputStream(), 0x1, text.toByteArray(Charsets.UTF_8)) }
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (!acceptedLatch.await(10, TimeUnit.SECONDS)) return
            synchronized(writeLock) {
                runCatching { writeServerFrame(client.getOutputStream(), 0x2, bytes.toByteArray()) }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
            runCatching { client.close() }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            failed.set(true)
            ready.countDown()
            acceptedLatch.countDown()
            runCatching { client.close() }
        }
    }
    val headers = authHeaders(host) + forward.headers.filter { it.first.lowercase(Locale.US) !in DROP_REQUEST }
    val socket = HostHttp.openWebSocket(host, forward.pluginPath, headers, listener)
    if (!ready.await(20, TimeUnit.SECONDS) || failed.get()) {
        socket.cancel()
        return
    }
    val activeUpstream = upstream.get() ?: run {
        socket.cancel()
        return
    }
    try {
        synchronized(writeLock) { accept() }
        acceptedLatch.countDown()
        val input = client.getInputStream()
        while (true) {
            val frame = readClientFrame(input) ?: break
            when (frame.opcode) {
                0x1 -> activeUpstream.send(frame.payload.toString(Charsets.UTF_8))
                0x2 -> activeUpstream.send(frame.payload.toByteString())
                0x8 -> {
                    activeUpstream.close(1000, null)
                    break
                }
                0x9 -> synchronized(writeLock) {
                    writeServerFrame(client.getOutputStream(), 0xA, frame.payload)
                }
            }
        }
    } finally {
        acceptedLatch.countDown()
        runCatching { activeUpstream.close(1000, null) }
    }
}

private fun assertSafePreviewPluginPath(pluginPath: String) {
    val pathOnly = pluginPath.substringBefore('?')
    require(pathOnly.startsWith("/dsh-link/mobile/preview/")) { "invalid preview path" }
    require(!pathOnly.contains("..") && !pathOnly.contains("%2e", ignoreCase = true) && !pathOnly.contains('\\') && !pathOnly.contains("%5c", ignoreCase = true)) {
        "unsafe preview path"
    }
}

private fun authHeaders(host: Host): List<Pair<String, String>> = buildList {
    add("x-dsh-link-token" to host.token)
    if (host.token.isNotBlank()) add("Authorization" to "Bearer ${host.token}")
}
