package dev.deeplinks.native

import android.util.Log
import dev.deeplinks.core.BoundedIo
import dev.deeplinks.core.Host
import dev.deeplinks.core.HostHttp
import dev.deeplinks.core.parseHostStateFields
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call
import org.json.JSONObject
import java.io.InputStream
import java.util.concurrent.atomic.AtomicLong

/**
 * 一台电脑一条主机事件连接。断线后用 Last-Event-ID 续传。
 */
class HostEventClient(
    private val host: Host,
    private val scope: CoroutineScope,
) {
    sealed interface Item {
        data class State(
            val sessionId: String,
            val state: String,
            val title: String,
            val origin: String,
            val seq: Long,
            /** 宿主的通知建议：false 表示同一会话 60 秒内重复的同一种终态，不必再响一次。老插件不发，缺省 true。 */
            val notify: Boolean = true,
            /**
             * 待办审批的 id 与工具名（双端审批）。有它就能在通知上直接「允许一次 / 拒绝」，
             * 不必等手机打开该会话；老插件不发，两个都是 null。
             */
            val approvalId: String? = null,
            val approvalToolName: String? = null,
            /** 这次审批要做什么（命令原文等），通知正文直接显示；老插件不发。 */
            val approvalDetail: String? = null,
            /**
             * 待回答的澄清请求 id 与第一题题干（双端澄清）。有它就能在通知栏说清
             * 「在问什么」，点进来由请求快照把整张澄清卡补回；老插件不发。
             */
            val questionId: String? = null,
            val questionText: String? = null,
        ) : Item
        data object Resync : Item
        data object Disconnected : Item
    }

    private val _items = Channel<Item>(capacity = 64)
    val items: Channel<Item> = _items
    private val lastEventId = AtomicLong(0)
    private val attemptGeneration = AtomicLong(0)
    private var job: Job? = null
    private var call: Call? = null
    var lastFailure: StreamFailure? = null
        private set

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) { connectLoop() }
    }

    fun reconnect() {
        stop()
        start()
    }

    fun stop() {
        attemptGeneration.incrementAndGet()
        job?.cancel()
        job = null
        try { call?.cancel() } catch (_: Exception) {}
        call = null
    }

    fun noteEventId(seq: Long) {
        if (seq > 0) lastEventId.updateAndGet { cur -> maxOf(cur, seq) }
    }

    fun resetEventId() {
        lastEventId.set(0)
    }

    private suspend fun connectLoop() {
        var failures = 0
        while (currentCoroutineContext().isActive) {
            val result = try { connectOnce() } catch (e: Exception) { HostConnectResult(false, classifyFailure(e)) }
            if (!currentCoroutineContext().isActive) break
            if (result.ok) {
                failures = 0
            } else {
                failures++
                lastFailure = result.failure
                if (!shouldRetryStream(result.failure)) break
            }
            delay(nextBackoffMillis(result.ok, failures))
        }
    }

    private suspend fun connectOnce(): HostConnectResult {
        val generation = attemptGeneration.get()
        val headers = mutableListOf(
            "Accept-Encoding" to "identity",
            "Cache-Control" to "no-cache",
            "Accept" to "text/event-stream",
            "x-dsh-link-token" to host.token,
        )
        val cursor = lastEventId.get()
        // 游标同时用查询串和标准头发：有些中间层会剥掉 Last-Event-ID，?since= 是它的等价替代
        // （插件侧两个都认，见 src/host-events.js 的 parseHostCursor）。
        val path = if (cursor > 0) "/dsh-link/mobile/events?since=$cursor" else "/dsh-link/mobile/events"
        if (cursor > 0) headers += "Last-Event-ID" to cursor.toString()
        val response = try {
            HostHttp.execute(
                host,
                HostHttp.DshRequest(
                    method = "GET",
                    path = path,
                    headers = headers,
                    connectTimeoutMs = 8_000,
                    readTimeoutMs = 90_000,
                    streaming = true,
                ),
                onCall = { call = it },
            )
        } catch (e: Exception) {
            return HostConnectResult(false, classifyFailure(e))
        }
        return try {
            if (!currentCoroutineContext().isActive || attemptGeneration.get() != generation) {
                return HostConnectResult(false, StreamFailure.NETWORK)
            }
            if (response.code != 200) return HostConnectResult(false, classifyHttpFailure(response.code))
            response.body.byteStream().use { readSSE(it) }
            HostConnectResult(true, null)
        } catch (e: Exception) {
            HostConnectResult(false, classifyFailure(e))
        } finally {
            runCatching { response.close() }
            call = null
            _items.trySend(Item.Disconnected)
        }
    }

    private suspend fun readSSE(input: InputStream) {
        var eventName = ""
        var eventId = ""
        val data = StringBuilder()
        while (currentCoroutineContext().isActive) {
            val line = BoundedIo.readLine(input) ?: break
            when {
                line.startsWith(":") -> Unit
                line.startsWith("id:") -> eventId = line.removePrefix("id:").trim()
                line.startsWith("event:") -> eventName = line.removePrefix("event:").trim()
                line.startsWith("data:") -> {
                    val payload = line.removePrefix("data:").let { if (it.startsWith(" ")) it.drop(1) else it }
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(payload)
                }
                line.isEmpty() -> {
                    if (data.isNotEmpty()) {
                        val seq = eventId.toLongOrNull()
                        if (seq != null) noteEventId(seq)
                        dispatch(eventName, data.toString(), seq)
                    }
                    eventName = ""
                    eventId = ""
                    data.clear()
                }
            }
        }
    }

    private suspend fun dispatch(name: String, body: String, seq: Long?) {
        when (name) {
            "session/state" -> {
                val fields = parseHostStateFields(body, seq) ?: return
                _items.send(
                    Item.State(
                        sessionId = fields.sessionId,
                        state = fields.state,
                        title = fields.title,
                        origin = fields.origin,
                        seq = fields.seq,
                        notify = fields.notify,
                        approvalId = fields.approvalId,
                        approvalToolName = fields.approvalToolName,
                        approvalDetail = fields.approvalDetail,
                        questionId = fields.questionId,
                        questionText = fields.questionText,
                    ),
                )
            }
            "resync-required" -> {
                resetEventId()
                _items.send(Item.Resync)
            }
            else -> Log.d(TAG, "ignore host event $name")
        }
    }

    private companion object {
        const val TAG = "HostEvents"
    }
}

private data class HostConnectResult(val ok: Boolean, val failure: StreamFailure?)
