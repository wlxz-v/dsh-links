package dev.deeplinks.native

import dev.deeplinks.core.Host
import dev.deeplinks.core.HostCapabilitiesCache
import dev.deeplinks.core.HostHttp
import dev.deeplinks.core.JsonHttpCache
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyStore
import java.security.MessageDigest
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

/**
 * 守护 [MobileApiClient] 的 HTTP 契约：
 * 1. GET 支持 ETag/304 复用缓存正文，不抛 304 异常；
 * 2. POST / PUT / DELETE 保留原始 HTTP 方法、UTF-8 JSON 请求体与 Content-Type；
 * 3. 401/403 自动清理对应电脑的内存缓存。
 */
class MobileApiRequestTest {

    @After
    fun tearDown() {
        JsonHttpCache.clear()
        HostCapabilitiesCache.clear()
        HostHttp.onNetworkChanged()
    }

    private fun withPinnedServer(block: (MockWebServer, Host) -> Unit) {
        val password = "dlp1-test".toCharArray()
        val keyStore = KeyStore.getInstance("PKCS12")
        javaClass.getResourceAsStream("/dlp1-test-server.p12")!!.use { keyStore.load(it, password) }
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keyStore, password) }
        val ssl = SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, null, null) }
        val cert = keyStore.getCertificate(keyStore.aliases().nextElement())
        val pin = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }

        val server = MockWebServer()
        server.useHttps(ssl.socketFactory)
        server.start()
        val host = Host(
            name = "test-pc",
            baseUrl = "https://127.0.0.1:${server.port}",
            token = "tok-test-123",
            deviceId = "dev-test",
            certFingerprint = pin,
        )
        try {
            block(server, host)
        } finally {
            HostHttp.onNetworkChanged()
            runCatching { server.close() }
        }
    }

    @Test
    fun `GET caches ETag and reuses body on 304 without throwing`() = withPinnedServer { server, host ->
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .addHeader("Content-Type", "application/json; charset=utf-8")
                .addHeader("ETag", "W/\"snap-1\"")
                .body("""{"sessions":[{"sessionId":"s-1","title":"First","updatedAt":10,"running":false,"blank":false}],"archivedSessionIds":[]}""")
                .build(),
        )
        server.enqueue(
            MockResponse.Builder()
                .code(304)
                .addHeader("ETag", "W/\"snap-1\"")
                .build(),
        )

        val client = MobileApiClient(host)
        val first = client.getSessions()
        assertEquals(1, first.sessions.size)
        assertEquals("s-1", first.sessions[0].sessionId)

        val second = client.getSessions()
        assertEquals(1, second.sessions.size)
        assertEquals("First", second.sessions[0].title)

        val req1 = server.takeRequest()
        assertEquals("GET", req1.method)
        assertNull(req1.headers["If-None-Match"])

        val req2 = server.takeRequest()
        assertEquals("GET", req2.method)
        assertEquals("W/\"snap-1\"", req2.headers["If-None-Match"])
    }

    @Test
    fun `POST and DELETE preserve HTTP method, JSON body, and Content-Type`() = withPinnedServer { server, host ->
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .addHeader("Content-Type", "application/json; charset=utf-8")
                .body("""{"ok":true}""")
                .build(),
        )
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .addHeader("Content-Type", "application/json; charset=utf-8")
                .body("""{"ok":true,"deleted":true}""")
                .build(),
        )

        val client = MobileApiClient(host)
        client.sendPrompt("s-1", "你好", mode = "queue")
        client.deleteSchedule("s-1", "sched-9")

        val postReq = server.takeRequest()
        assertEquals("POST", postReq.method)
        assertEquals("/dsh-link/mobile/sessions/s-1/prompt", postReq.target)
        val postBody = postReq.body?.utf8().orEmpty()
        assertTrue(postBody.contains("\"text\":\"你好\""))
        assertTrue(postReq.headers["Content-Type"].orEmpty().startsWith("application/json"))

        val deleteReq = server.takeRequest()
        assertEquals("DELETE", deleteReq.method)
        assertEquals("/dsh-link/mobile/sessions/s-1/schedules/sched-9", deleteReq.target)
        assertTrue(deleteReq.headers["Content-Type"].orEmpty().startsWith("application/json"))
    }

    @Test
    fun `401 clears cached GET entries for that host and records hostMissing on bootstrap`() = withPinnedServer { server, host ->
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .addHeader("Content-Type", "application/json; charset=utf-8")
                .addHeader("ETag", "W/\"boot-1\"")
                .body("""{"host":{"name":"PC"},"device":{"name":"Phone"},"sessions":[],"capabilities":{"host":{"v":1,"missing":["schedule.edit","agentPreset.list"]}}}""")
                .build(),
        )
        server.enqueue(
            MockResponse.Builder()
                .code(401)
                .addHeader("Content-Type", "application/json; charset=utf-8")
                .body("""{"error":"unauthorized"}""")
                .build(),
        )

        val client = MobileApiClient(host)
        val (boot, _) = client.bootstrap()
        assertEquals(setOf("schedule.edit", "agentPreset.list"), boot.hostMissing)
        assertEquals(setOf("schedule.edit", "agentPreset.list"), HostCapabilitiesCache.missing(host.slotKey))

        val cacheKey = JsonHttpCache.key(host.slotKey, "/dsh-link/mobile/bootstrap")
        assertEquals("W/\"boot-1\"", JsonHttpCache.get(cacheKey)?.etag)

        assertThrows(MobileAuthException::class.java) {
            client.getSessions()
        }
        assertNull(JsonHttpCache.get(cacheKey))
    }
}
