package dev.deeplinks.native.util

import org.junit.Assert.assertEquals
import org.junit.Test

class TimeLabelsTest {
    @Test
    fun relativeTime_blankWhenMissing() {
        assertEquals("", relativeTime(0, now = 1_000_000))
        assertEquals("", relativeTime(-1, now = 1_000_000))
    }

    @Test
    fun relativeTime_buckets() {
        val now = 200_000_000L
        assertEquals(dev.deeplinks.core.L.justNowShort, relativeTime(now - 1_000, now))
        assertEquals(dev.deeplinks.core.L.minutesShort.format(3), relativeTime(now - 3 * 60_000, now))
        assertEquals(dev.deeplinks.core.L.hoursShort.format(2), relativeTime(now - 2 * 3_600_000, now))
        assertEquals(dev.deeplinks.core.L.daysShort.format(2), relativeTime(now - 2 * 86_400_000, now))
    }

    @Test
    fun clockAndMonthDayFormattersMatchZeroPaddedPatterns() {
        val zone = java.time.ZoneOffset.UTC
        // 2026-09-05T07:04:00Z = 1788591840000L
        val tsMillis = java.time.ZonedDateTime.of(2026, 9, 5, 7, 4, 0, 0, zone).toInstant().toEpochMilli()
        assertEquals("07:04", formatClockTime(tsMillis, zone))
        assertEquals("09-05 07:04", formatMonthDayTime(tsMillis, zone))
        assertEquals("09-05 07:04", formatMonthDayTime(tsMillis / 1000L, zone))
        assertEquals("", formatClockTime(0L, zone))
        assertEquals("", formatMonthDayTime(0L, zone))
    }

    @Test
    fun homeTimeClockMatchesSingleShotHomeTimeLabel() {
        val zone = java.time.ZoneOffset.UTC
        val locale = java.util.Locale.CHINA
        val now = java.time.ZonedDateTime.of(2026, 11, 18, 12, 0, 0, 0, zone).toInstant().toEpochMilli()
        val clock = HomeTimeClock(now, zone, locale)
        val samples = listOf(
            0L,
            now - 15_000L,
            now - 12 * 60_000L,
            now - 4 * 3_600_000L,
            now - 26 * 3_600_000L,
            now - 4 * 86_400_000L,
            now - 12 * 86_400_000L,
        )
        for (ts in samples) {
            assertEquals(homeTimeLabel(ts, now, zone, locale), clock.format(ts))
        }
    }
}
