package dev.deeplinks.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Test

class UpdateCheckTest {
    @Test
    fun betaTenIsNewerThanBetaNine() {
        assertTrue(compareVersions("0.5.0-beta.10", "0.5.0-beta.9") > 0)
        assertTrue(compareVersions("app-v0.5.0-beta.10", "0.5.0-beta.9") > 0)
    }

    @Test
    fun releaseIsNewerThanPrereleaseOfTheSameNumber() {
        assertTrue(compareVersions("0.5.0", "0.5.0-beta.23") > 0)
        assertTrue(compareVersions("0.5.0-beta.23", "0.5.0") < 0)
    }

    @Test
    fun parseKeepsAppTagsAndDropsPluginTagsAndDrafts() {
        val json = """
            [
              {"tag_name":"v0.1.0-beta.19","draft":false,"html_url":"https://github.com/wlxz-v/dsh-links/releases/tag/v0.1.0-beta.19","published_at":"2026-09-30T00:00:00Z"},
              {"tag_name":"app-v0.5.0-beta.24","draft":true,"html_url":"https://github.com/wlxz-v/dsh-links/releases/tag/app-v0.5.0-beta.24","published_at":"2026-09-30T00:00:00Z"},
              {"tag_name":"app-v0.5.0-beta.23","draft":false,"html_url":"https://github.com/wlxz-v/dsh-links/releases/tag/app-v0.5.0-beta.23","published_at":"2026-09-29T00:00:00Z"}
            ]
        """.trimIndent()
        val releases = parseReleases(json)
        assertEquals(listOf("app-v0.5.0-beta.23"), releases.map { it.tagName })
        assertEquals("https://github.com/wlxz-v/dsh-links/releases/tag/app-v0.5.0-beta.23", releases.single().htmlUrl)
    }

    @Test
    fun newerReleaseIgnoresCurrentAndOlder() {
        val releases = listOf(
            AppRelease("app-v0.5.0-beta.22", "https://example.com/22", ""),
            AppRelease("app-v0.5.0-beta.24", "https://example.com/24", ""),
        )
        assertEquals("app-v0.5.0-beta.24", newerRelease("0.5.0-beta.23", releases)?.tagName)
        assertNull(newerRelease("0.5.0-beta.24", releases))
    }

    @Test
    fun checksAtMostOncePerDay() {
        val now = 1_700_000_000_000L
        assertTrue(shouldCheck(0L, now))
        assertTrue(!shouldCheck(now - 60_000L, now))
        assertTrue(shouldCheck(now - DAY, now))
    }

    @Test
    fun parseFiltersNonRepoApkUrlAndTruncatesBody() {
        val longBody = "x".repeat(500)
        val json = """
            [
              {
                "tag_name":"app-v0.5.0-beta.28",
                "draft":false,
                "html_url":"https://github.com/wlxz-v/dsh-links/releases/tag/app-v0.5.0-beta.28",
                "published_at":"2026-10-01T00:00:00Z",
                "body":"$longBody",
                "assets":[{"name":"evil.apk","browser_download_url":"https://evil.example.com/evil.apk"}]
              },
              {
                "tag_name":"app-v0.5.0-beta.29",
                "draft":false,
                "html_url":"https://github.com/wlxz-v/dsh-links/releases/tag/app-v0.5.0-beta.29",
                "published_at":"2026-10-02T00:00:00Z",
                "assets":[{"name":"DeepLinks.apk","browser_download_url":"https://github.com/wlxz-v/dsh-links/releases/download/app-v0.5.0-beta.29/DeepLinks.apk"}]
              },
              {
                "tag_name":"app-v0.5.0-beta.27",
                "draft":false,
                "html_url":"https://github.com/wlxz-v/dsh-links/releases/tag/app-v0.5.0-beta.27",
                "published_at":"2026-09-30T00:00:00Z"
              }
            ]
        """.trimIndent()
        val releases = parseReleases(json)
        assertEquals(3, releases.size)
        assertEquals("", releases[0].apkUrl)
        assertEquals(400, releases[0].bodySummary.length)
        assertEquals(
            "https://github.com/wlxz-v/dsh-links/releases/download/app-v0.5.0-beta.29/DeepLinks.apk",
            releases[1].apkUrl,
        )
        assertEquals("", releases[2].apkUrl)
    }

    @Test
    fun fetchUpdateStatusDistinguishesAvailableUpToDateAndFailed() {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse(code = 200, body = """[{"tag_name":"app-v0.5.0-beta.28","draft":false,"html_url":"https://github.com/wlxz-v/dsh-links/releases/tag/app-v0.5.0-beta.28","published_at":"2026-10-01T00:00:00Z"}]""".trimIndent()))
            val avail = UpdateChecker.fetchUpdateStatus("0.5.0-beta.27", server.url("/releases").toString())
            assertTrue(avail is UpdateCheckResult.UpdateAvailable)

            server.enqueue(MockResponse(code = 200, body = """[{"tag_name":"app-v0.5.0-beta.27","draft":false,"html_url":"https://github.com/wlxz-v/dsh-links/releases/tag/app-v0.5.0-beta.27","published_at":"2026-10-01T00:00:00Z"}]""".trimIndent()))
            val upToDate = UpdateChecker.fetchUpdateStatus("0.5.0-beta.27", server.url("/releases").toString())
            assertEquals(UpdateCheckResult.UpToDate, upToDate)

            server.enqueue(MockResponse(code = 500, body = "err"))
            val failed = UpdateChecker.fetchUpdateStatus("0.5.0-beta.27", server.url("/releases").toString())
            assertTrue(failed is UpdateCheckResult.Failed)
        } finally {
            runCatching { server.close() }
        }
    }

    private companion object {
        const val DAY = 24L * 60L * 60L * 1000L
    }
}
