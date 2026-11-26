package dev.deeplinks.core

import dev.deeplinks.core.remote.HostRoute
import dev.deeplinks.core.remote.RouteBusyException
import dev.deeplinks.core.remote.RouteSelector
import dev.deeplinks.native.MobileApiHttpException
import dev.deeplinks.native.StreamFailure
import dev.deeplinks.native.chunkPreviewLines
import dev.deeplinks.native.classifyFailure
import dev.deeplinks.native.friendlyNetworkError
import dev.deeplinks.native.intralineEmphasis
import dev.deeplinks.native.isSafeLocalAssetUrl
import dev.deeplinks.native.shouldRetryStream
import dev.deeplinks.native.utf8ByteLength
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.Socket
import java.nio.charset.StandardCharsets

class AndroidHardeningTest {

    @Test
    fun `preview proxy blocks percent-encoded traversal, backslashes, and control chars`() {
        val key = "ab".repeat(16)
        val id = "cd".repeat(12)
        assertNull(mapPreviewPath(key, "/$key/$id/%2e%2e/%2e%2e/sessions"))
        assertNull(mapPreviewPath(key, "/$key/$id/.%2e/sessions"))
        assertNull(mapPreviewPath(key, "/$key/$id/%2e./sessions"))
        assertNull(mapPreviewPath(key, "/$key/$id/..\\..\\sessions"))
        assertNull(mapPreviewPath(key, "/$key/$id/%5c..%5csessions"))
        assertNull(mapPreviewPath(key, "/$key/$id/a%2fb"))
        assertNull(mapPreviewPath(key, "//$key/$id/"))
        assertNull(mapPreviewPath(key, "/$key/$id/foo#bar"))
        assertNull(mapPreviewPath(key, "/$key/$id/foo\u0000bar"))
        assertEquals(
            "/dsh-link/mobile/preview/$id/assets/main.js?v=1",
            mapPreviewPath(key, "/$key/$id/assets/main.js?v=1"),
        )
    }

    @Test
    fun `preview proxy emits RFC 6455 Sec-WebSocket-Accept and handles large frames`() {
        // RFC 6455 §1.3 标准向量
        assertEquals(
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
            computeWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
        )
        val id = "22".repeat(12)
        val largePayload = ByteArray(70_000) { (it % 251).toByte() }
        val proxy = PreviewLocalProxy(
            exchange = { error("http") },
            webSocket = { _, client, accept ->
                accept()
                writeServerFrame(client.getOutputStream(), 0x2, largePayload)
            },
        )
        proxy.start()
        try {
            Socket(InetAddress.getByName("127.0.0.1"), proxy.port).use { socket ->
                socket.soTimeout = 3_000
                val out = socket.getOutputStream()
                val req = "GET /${proxy.key}/$id/ws HTTP/1.1\r\n" +
                    "Host: 127.0.0.1\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
                    "Sec-WebSocket-Version: 13\r\n\r\n"
                out.write(req.toByteArray(StandardCharsets.ISO_8859_1))
                out.flush()
                val head = StringBuilder()
                val input = socket.getInputStream()
                while (!head.endsWith("\r\n\r\n") && head.length < 4096) {
                    val b = input.read()
                    if (b < 0) break
                    head.append(b.toChar())
                }
                val text = head.toString()
                assertTrue(text.startsWith("HTTP/1.1 101"))
                assertTrue(text.contains("sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", ignoreCase = true))
                val frame = readClientFrame(input)!!
                assertEquals(0x2, frame.opcode)
                assertArrayEquals(largePayload, frame.payload)
            }
        } finally {
            proxy.close()
        }
    }

    @Test
    fun `resolveExactHost never falls back to another host on mismatch`() {
        val hostA = Host("书房", "https://10.0.0.2:18640", "tok-a")
        val hostB = Host("客厅", "https://10.0.0.3:18640", "tok-b")
        val onlyB = listOf(hostB)
        assertNull(onlyB.resolveExactHost("书房", hostA.baseUrl))
        assertNull(onlyB.resolveExactHost(null, null))
        assertEquals(hostB, onlyB.resolveExactHost("客厅", hostB.baseUrl))
    }

    @Test
    fun `CertChangedException stops SSE retries as AUTH failure`() {
        val direct = PinnedSsl.CertChangedException()
        val wrapped = IOException("tls failed", direct)
        assertEquals(StreamFailure.AUTH, classifyFailure(direct))
        assertEquals(StreamFailure.AUTH, classifyFailure(wrapped))
        assertFalse(shouldRetryStream(StreamFailure.AUTH))
    }

    @Test
    fun `409 settings conflict and RouteBusyException map to friendly localized text`() {
        val conflict = MobileApiHttpException(409, """{"error":"设置已在电脑端被修改，请刷新后重试"}""", "设置已在电脑端被修改，请刷新后重试")
        assertEquals(L.settingsChangedElsewhere, friendlyNetworkError(conflict))
        assertEquals(L.remoteBusy, friendlyNetworkError(RouteBusyException("DEVICE_LIMIT")))
        assertEquals(L.remoteBusy, friendlyNetworkError(RouteBusyException("LOCAL_QUEUE")))
    }

    @Test
    fun `single-URL LAN-only host skips redundant LAN probe`() {
        val selector = RouteSelector()
        var probes = 0
        val routes = selector.order(
            key = "lan-only",
            hasRemote = false,
            candidates = listOf("https://192.168.1.2:18640"),
            probeDirect = { probes++; true },
        )
        assertEquals(listOf(HostRoute.LAN), routes)
        assertEquals(0, probes)
    }

    @Test
    fun `BoundedIo readLine caps CR-only flood against maxBytes`() {
        val crFlood = ByteArray(128) { '\r'.code.toByte() }
        var threw = false
        try {
            BoundedIo.readLine(ByteArrayInputStream(crFlood), maxBytes = 32)
        } catch (_: IOException) {
            threw = true
        }
        assertTrue(threw)
    }

    @Test
    fun `WebView asset URL check rejects traversal and external origins`() {
        assertTrue(isSafeLocalAssetUrl("file:///android_asset/katex/katex.min.js"))
        assertFalse(isSafeLocalAssetUrl("file:///android_asset/katex/../../etc/hosts"))
        assertFalse(isSafeLocalAssetUrl("file:///android_asset/katex/%2e%2e/secret"))
        assertFalse(isSafeLocalAssetUrl("file:///android_asset/katex\\..\\secret"))
        assertFalse(isSafeLocalAssetUrl("https://evil.example/a.js"))
    }

    @Test
    fun `FilePreviewPage utf8ByteLength and chunkPreviewLines match exact UTF-8 and line grouping`() {
        val sample = "hello\n中文测试\n🚀emoji"
        assertEquals(sample.toByteArray(StandardCharsets.UTF_8).size.toLong(), utf8ByteLength(sample))
        val many = (1..120).joinToString("\n") { "line $it" }
        val chunks = chunkPreviewLines(many, linesPerChunk = 50)
        assertEquals(3, chunks.size)
        assertEquals(many, chunks.joinToString("\n"))
    }

    @Test
    fun `intralineEmphasis zero-substring matching detects exact changed tokens`() {
        val (oldR, newR) = intralineEmphasis(
            "val timeout = 30_000 // 旧配置",
            "val timeout = 90_000 // 旧配置",
        )
        assertEquals(listOf("30_000"), oldR.map { "val timeout = 30_000 // 旧配置".substring(it) })
        assertEquals(listOf("90_000"), newR.map { "val timeout = 90_000 // 旧配置".substring(it) })
    }
}
