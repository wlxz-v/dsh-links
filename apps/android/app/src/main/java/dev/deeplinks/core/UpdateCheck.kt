package dev.deeplinks.core

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.util.concurrent.TimeUnit

data class AppRelease(
    val tagName: String,
    val htmlUrl: String,
    val publishedAt: String,
    val apkUrl: String = "",
    val bodySummary: String = "",
)

sealed interface UpdateCheckResult {
    data object UpToDate : UpdateCheckResult
    data class UpdateAvailable(val release: AppRelease) : UpdateCheckResult
    data class Failed(val reason: String) : UpdateCheckResult
}

private const val DAY_MS = 24L * 60L * 60L * 1000L
private const val MAX_RELEASE_BODY_BYTES = 512 * 1024
private const val PREFS = "dsh_settings"
private const val KEY_ENABLED = "update_check_enabled"
private const val KEY_CHECKED = "update_last_checked_at"
private const val KEY_TAG = "update_latest_tag"
private const val KEY_URL = "update_latest_url"

const val GITHUB_RELEASES_URL = "https://api.github.com/repos/wlxz-v/dsh-links/releases?per_page=10"
private const val ALLOWED_APK_PREFIX = "https://github.com/wlxz-v/dsh-links/"
private const val MAX_BODY_SUMMARY_CHARS = 400

private fun parseApkUrl(assets: JSONArray?): String {
    if (assets == null) return ""
    for (i in 0 until assets.length()) {
        val asset = assets.optJSONObject(i) ?: continue
        val name = asset.optString("name", "")
        val url = asset.optString("browser_download_url", "")
        if (name.endsWith(".apk", ignoreCase = true) && url.startsWith(ALLOWED_APK_PREFIX)) {
            return url
        }
    }
    return ""
}

/** 只认 App 的 `app-v*` 正式发布，插件 tag 和草稿都丢掉。 */
fun parseReleases(json: String): List<AppRelease> {
    val array = JSONArray(json)
    val out = ArrayList<AppRelease>(array.length())
    for (i in 0 until array.length()) {
        val item = array.optJSONObject(i) ?: continue
        if (item.optBoolean("draft", false)) continue
        val tag = item.optString("tag_name")
        if (!tag.startsWith("app-v")) continue
        val body = item.optString("body", "").trim()
        val summary = if (body.length > MAX_BODY_SUMMARY_CHARS) body.take(MAX_BODY_SUMMARY_CHARS) else body
        out += AppRelease(
            tagName = tag,
            htmlUrl = item.optString("html_url"),
            publishedAt = item.optString("published_at"),
            apkUrl = parseApkUrl(item.optJSONArray("assets")),
            bodySummary = summary,
        )
    }
    return out
}

/**
 * 正数表示 [a] 比 [b] 新。主版本按数字段比较，预发布里的数字也按数字比（`beta.10` > `beta.9`）。
 * 同一主版本下，没有预发布标签的正式版比任何预发布新。
 */
fun compareVersions(a: String, b: String): Int {
    val left = splitVersion(a)
    val right = splitVersion(b)
    val width = maxOf(left.numbers.size, right.numbers.size)
    for (i in 0 until width) {
        val delta = left.numbers.getOrElse(i) { 0 } - right.numbers.getOrElse(i) { 0 }
        if (delta != 0) return delta
    }
    if (left.pre.isEmpty() && right.pre.isNotEmpty()) return 1
    if (left.pre.isNotEmpty() && right.pre.isEmpty()) return -1
    val preWidth = maxOf(left.pre.size, right.pre.size)
    for (i in 0 until preWidth) {
        val x = left.pre.getOrNull(i)
        val y = right.pre.getOrNull(i)
        if (x == null) return -1
        if (y == null) return 1
        val xi = x.toIntOrNull()
        val yi = y.toIntOrNull()
        val delta = if (xi != null && yi != null) xi - yi else x.compareTo(y)
        if (delta != 0) return delta
    }
    return 0
}

fun shouldCheck(lastCheckedAt: Long, now: Long): Boolean {
    if (lastCheckedAt <= 0L) return true
    return now - lastCheckedAt >= DAY_MS
}

fun newerRelease(currentVersionName: String, releases: List<AppRelease>): AppRelease? {
    return releases
        .filter { it.htmlUrl.startsWith("https://") }
        .filter { compareVersions(it.tagName, currentVersionName) > 0 }
        .maxWithOrNull { a, b -> compareVersions(a.tagName, b.tagName) }
}

fun displayVersion(tagOrName: String): String {
    return tagOrName.removePrefix("app-v").removePrefix("v")
}

object UpdateCheckPrefs {
    fun enabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true)

    fun setEnabled(context: Context, value: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, value).apply()
    }

    fun lastCheckedAt(context: Context): Long =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_CHECKED, 0L)

    fun setLastCheckedAt(context: Context, value: Long) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_CHECKED, value).apply()
    }

    fun cachedNewer(context: Context): AppRelease? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val tag = prefs.getString(KEY_TAG, null)?.takeIf { it.isNotBlank() } ?: return null
        val url = prefs.getString(KEY_URL, null)?.takeIf { it.startsWith("https://") } ?: return null
        return AppRelease(tag, url, "")
    }

    fun setCachedNewer(context: Context, release: AppRelease?) {
        val edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (release == null) {
            edit.remove(KEY_TAG).remove(KEY_URL)
        } else {
            edit.putString(KEY_TAG, release.tagName).putString(KEY_URL, release.htmlUrl)
        }
        edit.apply()
    }
}

object UpdateChecker {
    private val client = OkHttpClient.Builder()
        .callTimeout(20, TimeUnit.SECONDS)
        .build()

    internal fun fetchUpdateStatus(versionName: String, url: String = GITHUB_RELEASES_URL): UpdateCheckResult {
        return try {
            val request = Request.Builder()
                .url(url)
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "DeepLinks-Android/$versionName")
                .get()
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    return UpdateCheckResult.Failed("http ${response.code}")
                }
                val body = response.body.byteStream().use { BoundedIo.readText(it, MAX_RELEASE_BODY_BYTES) }
                val newer = newerRelease(versionName, parseReleases(body))
                if (newer != null) UpdateCheckResult.UpdateAvailable(newer) else UpdateCheckResult.UpToDate
            }
        } catch (e: Exception) {
            UpdateCheckResult.Failed(e.message?.take(80) ?: "check failed")
        }
    }

    /** 手动立即检查更新（绕过 24h 节流），供设置页使用。 */
    fun checkNow(context: Context, versionName: String, url: String = GITHUB_RELEASES_URL, now: Long = System.currentTimeMillis()): UpdateCheckResult {
        return when (val result = fetchUpdateStatus(versionName, url)) {
            is UpdateCheckResult.UpdateAvailable -> {
                UpdateCheckPrefs.setCachedNewer(context, result.release)
                UpdateCheckPrefs.setLastCheckedAt(context, now)
                result
            }
            is UpdateCheckResult.UpToDate -> {
                UpdateCheckPrefs.setCachedNewer(context, null)
                UpdateCheckPrefs.setLastCheckedAt(context, now)
                result
            }
            is UpdateCheckResult.Failed -> {
                CrashRecorder.breadcrumb("update", result.reason)
                result
            }
        }
    }

    /** 后台调用。失败只留面包屑，不抛给界面。 */
    fun checkBlocking(context: Context, versionName: String, url: String = GITHUB_RELEASES_URL, now: Long = System.currentTimeMillis()) {
        if (!UpdateCheckPrefs.enabled(context)) return
        if (!shouldCheck(UpdateCheckPrefs.lastCheckedAt(context), now)) return
        when (val result = fetchUpdateStatus(versionName, url)) {
            is UpdateCheckResult.UpdateAvailable -> {
                UpdateCheckPrefs.setCachedNewer(context, result.release)
                UpdateCheckPrefs.setLastCheckedAt(context, now)
            }
            is UpdateCheckResult.UpToDate -> {
                UpdateCheckPrefs.setCachedNewer(context, null)
                UpdateCheckPrefs.setLastCheckedAt(context, now)
            }
            is UpdateCheckResult.Failed -> {
                CrashRecorder.breadcrumb("update", result.reason)
            }
        }
    }
}

private data class SplitVersion(val numbers: List<Int>, val pre: List<String>)

private fun splitVersion(raw: String): SplitVersion {
    var text = raw.trim()
    text = when {
        text.startsWith("app-v") -> text.removePrefix("app-v")
        text.startsWith("v") -> text.removePrefix("v")
        else -> text
    }
    val cut = text.split('-', limit = 2)
    val numbers = cut[0].split('.').map { it.toIntOrNull() ?: 0 }
    val pre = if (cut.size < 2 || cut[1].isBlank()) emptyList() else cut[1].split('.')
    return SplitVersion(numbers, pre)
}
