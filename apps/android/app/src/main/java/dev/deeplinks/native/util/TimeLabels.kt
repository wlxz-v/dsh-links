package dev.deeplinks.native.util

import dev.deeplinks.core.L
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.EnumMap
import java.util.Locale

private fun twoDigits(n: Int): String = if (n < 10) "0$n" else n.toString()

/** 消息行的钟点时间（HH:mm），对齐 Web 助手行末尾的时间戳（零 SimpleDateFormat 分配）。 */
fun formatClockTime(timestamp: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    if (timestamp <= 0) return ""
    val time = Instant.ofEpochMilli(timestamp).atZone(zone).toLocalTime()
    return "${twoDigits(time.hour)}:${twoDigits(time.minute)}"
}

/** 归档/设置页的时间戳（MM-dd HH:mm，兼容秒级旧时间戳，零 SimpleDateFormat 分配）。 */
fun formatMonthDayTime(timestamp: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    if (timestamp <= 0L) return ""
    val zdt = Instant.ofEpochMilli(sessionMillis(timestamp)).atZone(zone)
    return "${twoDigits(zdt.monthValue)}-${twoDigits(zdt.dayOfMonth)} ${twoDigits(zdt.hour)}:${twoDigits(zdt.minute)}"
}

/** 侧栏/历史相对时间（刚刚 / n分钟 / n小时 / n天）。 */
fun relativeTime(timestamp: Long, now: Long = System.currentTimeMillis()): String {
    if (timestamp <= 0) return ""
    val diff = now - timestamp
    return when {
        diff < 60_000 -> L.justNowShort
        diff < 3_600_000 -> L.minutesShort.format(diff / 60_000)
        diff < 86_400_000 -> L.hoursShort.format(diff / 3_600_000)
        else -> L.daysShort.format(diff / 86_400_000)
    }
}

/**
 * 批量格式化首页会话行尾时间的时钟快照：一次解析 [ZoneId] / [Locale] / [today] 并缓存星期简称，
 * 避免数百年目列表在每次布局/重组时重复获取系统默认时区锁与 ICU 符号表。
 */
class HomeTimeClock(
    private val now: Long = System.currentTimeMillis(),
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val locale: Locale = Locale.getDefault(),
) {
    private val today: LocalDate by lazy(LazyThreadSafetyMode.NONE) {
        Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    }
    private val weekdayLabels = EnumMap<DayOfWeek, String>(DayOfWeek::class.java)

    fun format(timestamp: Long): String {
        if (timestamp <= 0) return ""
        // 旧 Host 给的是秒：先归一到毫秒，否则 diff 会算成几十年
        val ts = sessionMillis(timestamp)
        val diff = now - ts
        if (diff < 60_000) return L.justNowShort
        if (diff < 3_600_000) return L.minutesShort.format(diff / 60_000)
        val day = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(day, today)
        return when {
            days <= 0L -> L.hoursShort.format(diff / 3_600_000)
            days == 1L -> L.timeYesterday
            days in 2..6 -> weekdayLabels.getOrPut(day.dayOfWeek) {
                day.dayOfWeek.getDisplayName(TextStyle.SHORT, locale)
            }
            else -> L.daysShort.format(days)
        }
    }
}

/**
 * 首页会话行尾的时间（2026-09-28 重设计「最近」分组）。
 *
 * 比 [relativeTime] 多一层自然日判断：稿子里最近分组的行尾写的是「昨天 / 周五」，
 * 而不是「1 天前 / 4 天前」——按天分段更符合「这是哪天干的活」这个问法。
 * 一周以外退回 [relativeTime] 的「n 天前」。
 */
fun homeTimeLabel(
    timestamp: Long,
    now: Long = System.currentTimeMillis(),
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): String = HomeTimeClock(now, zone, locale).format(timestamp)

/** 「上次在线」的时间戳 → 相对时间文案；0/负数表示没有记录，返回 null（不写假时间）。 */
fun lastOnlineLabel(lastOnlineAt: Long): String? = lastOnlineAt.takeIf { it > 0 }?.let(::relativeTime)
