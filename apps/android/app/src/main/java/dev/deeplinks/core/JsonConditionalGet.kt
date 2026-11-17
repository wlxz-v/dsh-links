package dev.deeplinks.core

import org.json.JSONObject

/**
 * 一次带 ETag 的 GET 结果。[code] 是服务端状态码，304 时 [text] 是上次缓存的正文（没有缓存就是空串）。
 */
internal class ConditionalJsonGet(val code: Int, val text: String)

/**
 * GET 一段 JSON，并处理 D1 的条件请求：
 * 有缓存就带 `If-None-Match`；服务端回 304 时直接复用缓存正文，省掉整段 JSON 的传输与解析。
 *
 * 调用方负责把非 2xx 变成自己的异常（这里不依赖 native 包的类型，保持 core 在下层）。
 */
@Suppress("LongParameterList")
internal fun conditionalJsonGet(
    host: Host,
    path: String,
    authHeaders: List<Pair<String, String>>,
    connectTimeoutMs: Int,
    readTimeoutMs: Int,
    maxBytes: Int,
): ConditionalJsonGet {
    // 键必须带电脑标识：同一份路径在不同电脑上是不同内容；缓存放对象级（MobileApiClient 每次新建）。
    val cacheKey = JsonHttpCache.key(host.slotKey, path)
    val cached = JsonHttpCache.get(cacheKey)
    val headers = buildList {
        addAll(authHeaders)
        add("Accept" to "application/json")
        if (cached != null) add("If-None-Match" to cached.etag)
    }
    HostHttp.execute(
        host,
        HostHttp.DshRequest(
            method = "GET",
            path = path,
            body = null,
            // F3：Accept-Encoding 交给 OkHttp 自己加 gzip（它只解自己加的），这里不写 identity。
            headers = headers,
            connectTimeoutMs = connectTimeoutMs,
            readTimeoutMs = readTimeoutMs,
        ),
    ).use { response ->
        val code = response.code
        // 304 没有正文；先复用缓存，别让上层读到空串再 JSONObject("") 抛错。
        if (code == 304) {
            if (cached != null) return ConditionalJsonGet(code, cached.body)
            JsonHttpCache.invalidate(cacheKey)
            return ConditionalJsonGet(code, "")
        }
        val text = response.body.byteStream().use { BoundedIo.readText(it, maxBytes) }
        if (code !in 200..299) {
            // 失败时丢掉旧条目，别让过期正文遮住服务端的新答案。
            JsonHttpCache.invalidate(cacheKey)
            return ConditionalJsonGet(code, text)
        }
        response.header("etag")?.let { etag -> JsonHttpCache.put(cacheKey, etag, text) }
        return ConditionalJsonGet(code, text)
    }
}

/**
 * `capabilities.host.missing` → 缺失的 Remote 名集合。
 * 插件探测不到时是空数组；老插件根本没有 `host` 对象 —— 两种情况都当「没有已知缺口」处理，
 * 入口维持原样（宁可点进去报一次错，也不要因为一次探测超时就把功能藏掉）。
 */
internal fun parseMissingHostRemotes(host: JSONObject?): Set<String> {
    val array = host?.optJSONArray("missing") ?: return emptySet()
    return buildSet {
        for (index in 0 until array.length()) {
            array.optString(index).takeIf { it.isNotBlank() }?.let { add(it) }
        }
    }
}

/**
 * 按电脑（[Host.slotKey]）缓存最近一次 bootstrap 实测缺失的宿主能力（B1），
 * 让独立的设置路由（SettingsRoute / ModelsSettingsPage）无需重新探测即可收敛不可用入口。
 */
object HostCapabilitiesCache {
    private val byHost = java.util.concurrent.ConcurrentHashMap<String, Set<String>>()

    fun put(slotKey: String, missing: Set<String>) {
        if (slotKey.isBlank()) return
        if (missing.isEmpty()) byHost.remove(slotKey) else byHost[slotKey] = missing
    }

    fun missing(slotKey: String): Set<String> = byHost[slotKey].orEmpty()

    fun clearHost(slotKey: String) {
        if (slotKey.isBlank()) return
        byHost.remove(slotKey)
    }

    fun clear() {
        byHost.clear()
    }
}
