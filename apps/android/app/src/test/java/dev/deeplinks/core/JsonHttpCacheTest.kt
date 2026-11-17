package dev.deeplinks.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonHttpCacheTest {

    @After
    fun tearDown() {
        JsonHttpCache.clear()
        HostCapabilitiesCache.clear()
    }

    @Test
    fun `oversized body above MAX_ENTRY_BYTES is not retained and invalidates stale entry`() {
        val key = JsonHttpCache.key("lan|host-a", "/dsh-link/mobile/sessions/s1/history")
        JsonHttpCache.put(key, "W/\"small\"", """{"messages":[]}""")
        assertNotNull(JsonHttpCache.get(key))

        val huge = "x".repeat(JsonHttpCache.MAX_ENTRY_BYTES + 16)
        JsonHttpCache.put(key, "W/\"huge\"", huge)
        assertNull(JsonHttpCache.get(key))
        assertEquals(0, JsonHttpCache.currentTotalBytes())
    }

    @Test
    fun `total byte budget evicts least recently used entries`() {
        val chunk = "a".repeat(200 * 1024) // 200 KB per entry (< 256 KB per-entry cap)
        for (i in 1..12) {
            JsonHttpCache.put(JsonHttpCache.key("lan|h", "/p/$i"), "W/\"$i\"", chunk)
        }
        // 12 * 200 KB = 2400 KB > 2048 KB budget -> earliest entries evicted
        assertTrue(JsonHttpCache.currentTotalBytes() <= JsonHttpCache.MAX_TOTAL_BYTES)
        assertNull(JsonHttpCache.get(JsonHttpCache.key("lan|h", "/p/1")))
        assertNotNull(JsonHttpCache.get(JsonHttpCache.key("lan|h", "/p/12")))
    }

    @Test
    fun `clearHost removes only target slotKey entries`() {
        val keyA = JsonHttpCache.key("lan|host-a", "/dsh-link/mobile/sessions")
        val keyB = JsonHttpCache.key("lan|host-b", "/dsh-link/mobile/sessions")
        JsonHttpCache.put(keyA, "W/\"a\"", """{"sessions":[]}""")
        JsonHttpCache.put(keyB, "W/\"b\"", """{"sessions":[1]}""")

        JsonHttpCache.clearHost("lan|host-a")
        assertNull(JsonHttpCache.get(keyA))
        assertNotNull(JsonHttpCache.get(keyB))
    }

    @Test
    fun `HostCapabilitiesCache stores and clears per host`() {
        HostCapabilitiesCache.put("lan|host-a", setOf("schedule.edit"))
        assertEquals(setOf("schedule.edit"), HostCapabilitiesCache.missing("lan|host-a"))
        assertEquals(emptySet<String>(), HostCapabilitiesCache.missing("lan|host-b"))
        HostCapabilitiesCache.clearHost("lan|host-a")
        assertEquals(emptySet<String>(), HostCapabilitiesCache.missing("lan|host-a"))
    }
}
