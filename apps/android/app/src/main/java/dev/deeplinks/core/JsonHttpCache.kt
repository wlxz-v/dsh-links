package dev.deeplinks.core

/**
 * GET JSON 响应的内存缓存（D1：ETag / 304）。
 *
 * 服务端对 200 的 JSON 会带 `etag`，同一路径再次请求时带 `If-None-Match`，命中就回 304 且没有正文。
 * 手机端把上次的正文留着，304 时直接复用 —— 省的是整段 JSON（会话列表、bootstrap、待办快照都不小）。
 *
 * 缓存键必须是「电脑 + 路径」：同一台手机上可以存多台已配对电脑（[Host.slotKey] 区分），
 * 而 [dev.deeplinks.native.MobileApiClient] 是每次调用新建的，所以缓存只能放在对象级、按 key 存活。
 * 进程内缓存，不做持久化：冷启动后第一次仍然走 200。
 */
object JsonHttpCache {

    /** 一条缓存：ETag 用服务端给的原样字符串，正文是解压后的 JSON 文本。 */
    class Entry(val etag: String, val body: String)

    private const val MAX_ENTRIES = 24

    // accessOrder = true：命中就挪到末尾，满了先淘汰最久没用的那条。
    private val entries = object : LinkedHashMap<String, Entry>(MAX_ENTRIES, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?): Boolean =
            size > MAX_ENTRIES
    }

    /** 缓存键：`slotKey|path`（path 含查询串，不同分页各存各的）。 */
    fun key(slotKey: String, path: String): String = slotKey + "|" + path

    @Synchronized
    fun get(key: String): Entry? = entries[key]

    @Synchronized
    fun put(key: String, etag: String, body: String) {
        if (etag.isBlank() || body.isEmpty()) return
        entries[key] = Entry(etag, body)
    }

    /** 写失败（例如 4xx）时把旧条目丢掉，别让过期正文遮住服务端的新答案。 */
    @Synchronized
    fun invalidate(key: String) {
        entries.remove(key)
    }

    @Synchronized
    fun clear() {
        entries.clear()
    }
}
