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
    class Entry(val etag: String, val body: String, internal val byteSize: Int)

    internal const val MAX_ENTRIES = 24
    /** 单条上限 256 KB（UTF-8 估算）：超大历史页不长驻内存，避免多 MB 字符串撑高堆占用。 */
    internal const val MAX_ENTRY_BYTES = 256 * 1024
    /** 总内存预算 2 MB：超出时按 LRU 淘汰最久未读条目。 */
    internal const val MAX_TOTAL_BYTES = 2 * 1024 * 1024

    private var totalBytes = 0
    private val entries = LinkedHashMap<String, Entry>(MAX_ENTRIES, 0.75f, true)

    /** 缓存键：`slotKey|path`（path 含查询串，不同分页各存各的）。 */
    fun key(slotKey: String, path: String): String = slotKey + "|" + path

    @Synchronized
    fun get(key: String): Entry? = entries[key]

    @Synchronized
    fun put(key: String, etag: String, body: String) {
        if (etag.isBlank() || body.isEmpty()) return
        val bytes = body.toByteArray(Charsets.UTF_8).size
        if (bytes > MAX_ENTRY_BYTES) {
            // 同一路径变大超过单条上限时，移除旧副本以免下次误发过期的 If-None-Match。
            invalidate(key)
            return
        }
        entries.remove(key)?.let { totalBytes -= it.byteSize }
        entries[key] = Entry(etag, body, bytes)
        totalBytes += bytes
        val iter = entries.entries.iterator()
        while (iter.hasNext() && (entries.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES)) {
            val eldest = iter.next().value
            totalBytes -= eldest.byteSize
            iter.remove()
        }
        if (totalBytes < 0) totalBytes = 0
    }

    /** 写失败（例如 4xx）时把旧条目丢掉，别让过期正文遮住服务端的新答案。 */
    @Synchronized
    fun invalidate(key: String) {
        entries.remove(key)?.let {
            totalBytes = (totalBytes - it.byteSize).coerceAtLeast(0)
        }
    }

    /** 解除配对或凭据失效时，按电脑标识清除该电脑的全部内存缓存副本。 */
    @Synchronized
    fun clearHost(slotKey: String) {
        if (slotKey.isBlank()) return
        val prefix = "$slotKey|"
        val iter = entries.entries.iterator()
        while (iter.hasNext()) {
            val item = iter.next()
            if (item.key.startsWith(prefix)) {
                totalBytes -= item.value.byteSize
                iter.remove()
            }
        }
        if (totalBytes < 0) totalBytes = 0
    }

    @Synchronized
    fun clear() {
        entries.clear()
        totalBytes = 0
    }

    @Synchronized
    internal fun currentTotalBytes(): Int = totalBytes
}
