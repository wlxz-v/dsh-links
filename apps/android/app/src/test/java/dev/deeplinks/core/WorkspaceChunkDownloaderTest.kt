package dev.deeplinks.core

import dev.deeplinks.native.FileIntegrityException
import dev.deeplinks.native.MobileApiClient
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.KeyStore
import java.security.MessageDigest
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

class WorkspaceChunkDownloaderTest {

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

    private fun samplePayload(size: Int, seed: Int = 17): ByteArray =
        ByteArray(size) { i -> ((i * 31 + seed) and 0xFF).toByte() }

    private fun chunkResponse(slice: ByteArray, start: Long, total: Long, etag: String, chunkSha: String = hexSha256(slice)): MockResponse {
        val end = start + slice.size - 1
        return MockResponse.Builder()
            .code(206)
            .addHeader("Content-Type", "application/octet-stream")
            .addHeader("Accept-Ranges", "bytes")
            .addHeader("Content-Range", "bytes $start-$end/$total")
            .addHeader("ETag", etag)
            .addHeader("X-Dsh-Link-Chunk-Sha256", chunkSha)
            .body(okio.Buffer().write(slice))
            .build()
    }

    @Test
    fun `multi-chunk download merges chunks, reports progress, and verifies checksum`() = withPinnedServer { server, host ->
        val payload = samplePayload(3000)
        val etag = "\"3000-100\""
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .addHeader("Content-Type", "application/octet-stream")
                .addHeader("Content-Length", payload.size.toString())
                .addHeader("Accept-Ranges", "bytes")
                .addHeader("ETag", etag)
                .build(),
        )
        server.enqueue(chunkResponse(payload.copyOfRange(0, 1024), 0, 3000, etag))
        server.enqueue(chunkResponse(payload.copyOfRange(1024, 2048), 1024, 3000, etag))
        server.enqueue(chunkResponse(payload.copyOfRange(2048, 3000), 2048, 3000, etag))

        val cacheDir = Files.createTempDirectory("dsh-c1-dl").toFile()
        try {
            val api = MobileApiClient(host)
            val progress = mutableListOf<Pair<Long, Long>>()
            val downloaded = api.downloadWorkspaceFile(
                sessionId = "s1",
                path = "out/big.bin",
                cacheRootDir = cacheDir,
                chunkBytes = 1024,
                onProgress = { got, total -> progress += got to total },
            )
            assertEquals(3000L, downloaded.totalBytes)
            assertArrayEquals(payload, downloaded.file.readBytes())
            assertEquals(0L to 3000L, progress.first())
            assertEquals(3000L to 3000L, progress.last())
            val req0 = server.takeRequest()
            assertEquals("HEAD", req0.method)
            val req1 = server.takeRequest()
            assertEquals("bytes=0-1023", req1.headers["Range"])
            assertEquals(etag, req1.headers["If-Range"])
            assertEquals("bytes=1024-2047", server.takeRequest().headers["Range"])
            assertEquals("bytes=2048-2999", server.takeRequest().headers["Range"])
        } finally {
            cacheDir.deleteRecursively()
        }
    }

    @Test
    fun `interrupted download resumes from last verified chunk when ETag matches`() = withPinnedServer { server, host ->
        val payload = samplePayload(2500, seed = 9)
        val etag = "\"2500-55\""
        val cacheDir = Files.createTempDirectory("dsh-c1-resume").toFile()
        try {
            val api = MobileApiClient(host)
            // Run 1: HEAD -> chunk 0 succeeds -> chunk 1 fails with 500
            server.enqueue(
                MockResponse.Builder()
                    .code(200)
                    .addHeader("Content-Length", payload.size.toString())
                    .addHeader("Accept-Ranges", "bytes")
                    .addHeader("ETag", etag)
                    .build(),
            )
            server.enqueue(chunkResponse(payload.copyOfRange(0, 1024), 0, 2500, etag))
            server.enqueue(MockResponse.Builder().code(500).body("""{"error":"transient"}""").build())

            assertThrows(IllegalStateException::class.java) {
                api.downloadWorkspaceFile("s1", "archive.tar", cacheDir, chunkBytes = 1024)
            }
            repeat(3) { server.takeRequest() }

            // Run 2: HEAD -> server must receive Range starting at 1024 directly
            server.enqueue(
                MockResponse.Builder()
                    .code(200)
                    .addHeader("Content-Length", payload.size.toString())
                    .addHeader("Accept-Ranges", "bytes")
                    .addHeader("ETag", etag)
                    .build(),
            )
            server.enqueue(chunkResponse(payload.copyOfRange(1024, 2048), 1024, 2500, etag))
            server.enqueue(chunkResponse(payload.copyOfRange(2048, 2500), 2048, 2500, etag))

            val downloaded = api.downloadWorkspaceFile("s1", "archive.tar", cacheDir, chunkBytes = 1024)
            assertArrayEquals(payload, downloaded.file.readBytes())
            assertEquals("HEAD", server.takeRequest().method)
            assertEquals("bytes=1024-2047", server.takeRequest().headers["Range"])
            assertEquals("bytes=2048-2499", server.takeRequest().headers["Range"])
        } finally {
            cacheDir.deleteRecursively()
        }
    }

    @Test
    fun `HTTP 412 precondition failed resets partial cache and restarts from zero`() = withPinnedServer { server, host ->
        val oldPayload = samplePayload(2048, seed = 1)
        val newPayload = samplePayload(1800, seed = 99)
        val oldEtag = "\"2048-1\""
        val newEtag = "\"1800-2\""
        val cacheDir = Files.createTempDirectory("dsh-c1-412").toFile()
        try {
            val api = MobileApiClient(host)
            // Stage 1024 bytes under old ETag
            server.enqueue(
                MockResponse.Builder()
                    .code(200)
                    .addHeader("Content-Length", oldPayload.size.toString())
                    .addHeader("Accept-Ranges", "bytes")
                    .addHeader("ETag", oldEtag)
                    .build(),
            )
            server.enqueue(chunkResponse(oldPayload.copyOfRange(0, 1024), 0, 2048, oldEtag))
            server.enqueue(MockResponse.Builder().code(503).body("""{"error":"pause"}""").build())
            assertThrows(IllegalStateException::class.java) {
                api.downloadWorkspaceFile("s1", "changed.bin", cacheDir, chunkBytes = 1024)
            }
            repeat(3) { server.takeRequest() }

            // Second run: initial HEAD still reports oldEtag, then chunk returns 412, downloader restarts with new HEAD
            server.enqueue(
                MockResponse.Builder()
                    .code(200)
                    .addHeader("Content-Length", oldPayload.size.toString())
                    .addHeader("Accept-Ranges", "bytes")
                    .addHeader("ETag", oldEtag)
                    .build(),
            )
            server.enqueue(MockResponse.Builder().code(412).addHeader("ETag", newEtag).body("""{"error":"changed"}""").build())
            server.enqueue(
                MockResponse.Builder()
                    .code(200)
                    .addHeader("Content-Length", newPayload.size.toString())
                    .addHeader("Accept-Ranges", "bytes")
                    .addHeader("ETag", newEtag)
                    .build(),
            )
            server.enqueue(chunkResponse(newPayload.copyOfRange(0, 1024), 0, 1800, newEtag))
            server.enqueue(chunkResponse(newPayload.copyOfRange(1024, 1800), 1024, 1800, newEtag))

            val downloaded = api.downloadWorkspaceFile("s1", "changed.bin", cacheDir, chunkBytes = 1024)
            assertArrayEquals(newPayload, downloaded.file.readBytes())
            assertEquals("HEAD", server.takeRequest().method)
            assertEquals("bytes=1024-2047", server.takeRequest().headers["Range"])
            assertEquals("HEAD", server.takeRequest().method)
            assertEquals("bytes=0-1023", server.takeRequest().headers["Range"])
            assertEquals("bytes=1024-1799", server.takeRequest().headers["Range"])
        } finally {
            cacheDir.deleteRecursively()
        }
    }

    @Test
    fun `tampered chunk checksum is rejected without promoting target file`() = withPinnedServer { server, host ->
        val payload = samplePayload(1500, seed = 42)
        val etag = "\"1500-7\""
        val cacheDir = Files.createTempDirectory("dsh-c1-badsha").toFile()
        try {
            val api = MobileApiClient(host)
            server.enqueue(
                MockResponse.Builder()
                    .code(200)
                    .addHeader("Content-Length", payload.size.toString())
                    .addHeader("Accept-Ranges", "bytes")
                    .addHeader("ETag", etag)
                    .build(),
            )
            server.enqueue(chunkResponse(payload.copyOfRange(0, 1024), 0, 1500, etag, chunkSha = "0".repeat(64)))

            assertThrows(FileIntegrityException::class.java) {
                api.downloadWorkspaceFile("s1", "corrupt.bin", cacheDir, chunkBytes = 1024)
            }
            val target = File(File(cacheDir, "opened"), "corrupt.bin")
            assertFalse(target.exists())
        } finally {
            cacheDir.deleteRecursively()
        }
    }

    @Test
    fun `zero-byte file completes from HEAD and oversize file throws too large`() = withPinnedServer { server, host ->
        val cacheDir = Files.createTempDirectory("dsh-c1-edge").toFile()
        try {
            val api = MobileApiClient(host)
            server.enqueue(
                MockResponse.Builder()
                    .code(200)
                    .addHeader("Content-Length", "0")
                    .addHeader("Accept-Ranges", "bytes")
                    .addHeader("ETag", "\"0-1\"")
                    .build(),
            )
            val empty = api.downloadWorkspaceFile("s1", "empty.bin", cacheDir, chunkBytes = 1024)
            assertEquals(0L, empty.totalBytes)
            assertEquals(0L, empty.file.length())
            assertTrue(empty.file.isFile)

            server.enqueue(
                MockResponse.Builder()
                    .code(200)
                    .addHeader("Content-Length", "10000")
                    .addHeader("Accept-Ranges", "bytes")
                    .addHeader("ETag", "\"10000-1\"")
                    .build(),
            )
            val err = assertThrows(IOException::class.java) {
                api.downloadWorkspaceFile("s1", "huge.bin", cacheDir, maxFileBytes = 4096, chunkBytes = 1024)
            }
            assertTrue(err.message.orEmpty().contains("too large"))
        } finally {
            cacheDir.deleteRecursively()
        }
    }
}
