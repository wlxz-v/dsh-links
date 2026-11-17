package dev.deeplinks.native

import dev.deeplinks.core.L
import dev.deeplinks.native.util.optNullableString
import dev.deeplinks.native.util.optStringOrEmpty
import dev.deeplinks.native.util.parseStoppedReason
import dev.deeplinks.native.util.presentOrNull
import org.json.JSONObject
internal fun JSONObject.optPositiveLong(key: String): Long? =
    if (has(key) && !isNull(key)) optLong(key).takeIf { it > 0 } else null

internal fun JSONObject.optStringList(key: String): List<String> {
    val arr = optJSONArray(key) ?: return emptyList()
    return (0 until arr.length()).mapNotNull { arr.optString(it).presentOrNull() }
}

internal fun parseModelOption(m: JSONObject): MobileModelOption = MobileModelOption(
    id = m.optStringOrEmpty("id", ""),
    name = m.optNullableString("name"),
    contextWindow = m.optPositiveLong("contextWindow"),
    maxTokens = m.optPositiveLong("maxTokens"),
    reasoningEfforts = m.optStringList("reasoningEfforts"),
    defaultEffort = m.optNullableString("defaultEffort"),
)

internal fun parseModelGroups(arr: org.json.JSONArray?): List<MobileModelGroup> {
    if (arr == null) return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val g = arr.optJSONObject(i) ?: return@mapNotNull null
        val models = g.optJSONArray("models") ?: org.json.JSONArray()
        MobileModelGroup(
            provider = g.optStringOrEmpty("provider", L.unknownProvider),
            displayName = g.optStringOrEmpty("providerName").ifBlank { g.optStringOrEmpty("provider", L.unknownProvider) },
            models = (0 until models.length()).mapNotNull { j -> models.optJSONObject(j)?.let(::parseModelOption) },
        )
    }
}

private fun parseWallets(arr: org.json.JSONArray?): List<MobileWallet> {
    if (arr == null) return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val w = arr.optJSONObject(i) ?: return@mapNotNull null
        val currency = w.optStringOrEmpty("currency").presentOrNull() ?: return@mapNotNull null
        MobileWallet(currency = currency, balance = w.optStringOrEmpty("balance"))
    }
}

internal fun parseBalance(root: JSONObject): MobileBalance = MobileBalance(
    status = root.optStringOrEmpty("status").presentOrNull() ?: "unavailable",
    wallets = parseWallets(root.optJSONArray("wallets")),
    bonusWallets = parseWallets(root.optJSONArray("bonusWallets")),
)

internal fun parseProviderDirectory(root: JSONObject): MobileProviderDirectory {
    val rows = root.optJSONArray("providers") ?: org.json.JSONArray()
    val addable = root.optJSONArray("addable") ?: org.json.JSONArray()
    return MobileProviderDirectory(
        writable = root.optBoolean("writable", false),
        providers = (0 until rows.length()).mapNotNull { i ->
            val p = rows.optJSONObject(i) ?: return@mapNotNull null
            val provider = p.optStringOrEmpty("provider").presentOrNull() ?: return@mapNotNull null
            val cred = p.optJSONObject("credential")
            val models = p.optJSONArray("models") ?: org.json.JSONArray()
            MobileProviderRow(
                provider = provider,
                displayName = p.optStringOrEmpty("displayName").presentOrNull() ?: provider,
                kind = p.optStringOrEmpty("kind").presentOrNull() ?: "api",
                active = p.optBoolean("active", true),
                custom = p.optBoolean("custom", false),
                keyRef = p.optNullableString("keyRef"),
                credential = cred?.let {
                    MobileProviderCredential(
                        configured = it.optBoolean("configured", false),
                        writable = it.optBoolean("writable", false),
                        source = it.optNullableString("source"),
                    )
                },
                models = (0 until models.length()).mapNotNull { j -> models.optJSONObject(j)?.let(::parseModelOption) }
                    .filter { it.id.isNotBlank() },
                modelsEditable = p.optBoolean("modelsEditable", false),
                canDiscover = p.optBoolean("canDiscover", false),
            )
        },
        addable = (0 until addable.length()).mapNotNull { i ->
            val a = addable.optJSONObject(i) ?: return@mapNotNull null
            val provider = a.optStringOrEmpty("provider").presentOrNull() ?: return@mapNotNull null
            MobileAddableProvider(provider, a.optStringOrEmpty("displayName").presentOrNull() ?: provider)
        },
    )
}

internal fun MobileModelDraft.toJson(): JSONObject {
    val o = JSONObject().put("id", id)
    name.presentOrNull()?.let { o.put("name", it) }
    contextWindow?.takeIf { it > 0 }?.let { o.put("contextWindow", it) }
    maxTokens?.takeIf { it > 0 }?.let { o.put("maxTokens", it) }
    if (inputModalities.isNotEmpty()) o.put("inputModalities", org.json.JSONArray(inputModalities))
    return o
}

/** 非 2xx 且非鉴权失败：携带 HTTP 状态码与原始响应体，供调用方按 code 细分处理。 */
internal class MobileApiHttpException(val httpCode: Int, val body: String, message: String) : IllegalStateException(message)

/** Host 端已取不到这份改动对比（4.4）：UI 映射为本地化「已不可用」+ 重试。 */
internal class ChangesUnavailableException : IllegalStateException("changes_unavailable")

/** HTTP 404 且服务端 error code == "changes_unavailable"（纯函数，便于单测）。 */
internal fun isChangesUnavailable(httpCode: Int, body: String): Boolean =
    httpCode == 404 &&
        runCatching { JSONObject(body).optString("error") }.getOrNull() == "changes_unavailable"

internal fun parseMobileApiError(code: Int, text: String): String {
    val fromJson = runCatching { JSONObject(text).optStringOrEmpty("error") }.getOrNull()?.takeIf { it.isNotBlank() }
    return fromJson ?: text.ifBlank { "HTTP $code" }
}

/** history 响应 → [HistoryResult]；[beforeSeq] 仅用于给缺 id 的消息生成稳定兜底 id。 */
internal fun parseHistoryResponse(root: JSONObject, beforeSeq: Long?): HistoryResult {
    val rawList = root.optJSONArray("messages") ?: org.json.JSONArray()
    val messages = (0 until rawList.length()).map { i ->
        val obj = rawList.getJSONObject(i)
        val todosArr = obj.optJSONArray("todos") ?: org.json.JSONArray()
        MobileMessage(
            id = obj.optStringOrEmpty("id").ifBlank { "msg-${beforeSeq ?: "tail"}-$i" },
            role = obj.optStringOrEmpty("role", "assistant"),
            text = obj.optStringOrEmpty("text", ""),
            toolName = obj.optNullableString("name") ?: obj.optNullableString("toolName"),
            toolArgs = obj.optNullableString("args"),
            detail = obj.optNullableString("detail"),
            approvalId = obj.optNullableString("approvalId"),
            callId = obj.optNullableString("callId"),
            time = obj.optLong("time", 0L),
            type = obj.optStringOrEmpty("type", "text"),
            durationMs = if (obj.has("durationMs") && !obj.isNull("durationMs")) obj.optLong("durationMs") else null,
            running = if (obj.has("running") && !obj.isNull("running")) obj.optBoolean("running") else null,
            todos = (0 until todosArr.length()).map { j ->
                val t = todosArr.getJSONObject(j)
                MobileTodoItem(t.optStringOrEmpty("content", ""), t.optStringOrEmpty("status", "pending"))
            },
            seq = obj.optLong("seq", 0L),
            questionRpcId = obj.optNullableString("questionRpcId"),
            questionOptions = obj.optJSONArray("questionOptions")?.let { arr ->
                (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotBlank() }
            } ?: emptyList(),
            questionHeader = obj.optNullableString("questionHeader"),
            questionPayloadJson = obj.optNullableString("questionPayloadJson")
                ?: obj.optJSONArray("questions")?.toString(),
            requestStatus = obj.optNullableString("requestStatus"),
            outcome = obj.optNullableString("outcome"),
            files = parseHistoryFiles(obj),
            turn = if (obj.has("turn") && !obj.isNull("turn")) obj.optInt("turn") else null,
            changes = obj.optJSONObject("changes")?.let { parseWorkspaceChanges(it, obj.optLong("seq", 0L)) },
            kind = obj.optNullableString("kind"),
            goalRound = obj.optJSONObject("goal")?.optIntOrNull("round"),
            goalMaxRounds = obj.optJSONObject("goal")?.optIntOrNull("maxRounds"),
            goalObjective = obj.optJSONObject("goal")?.optNullableString("objective"),
        )
    }
    // stats（StatsLine：轮次/步骤/LLM 耗时/工具调用/首 token/吞吐/缓存/tokens）
    val stats = root.optJSONObject("stats")
    val result = HistoryResult(
        messages = messages,
        hasMore = root.optBoolean("hasMore", false),
        nextBeforeSeq = if (root.has("nextBeforeSeq") && !root.isNull("nextBeforeSeq")) root.optLong("nextBeforeSeq") else null,
        maxSeq = if (root.has("maxSeq") && !root.isNull("maxSeq")) root.optLong("maxSeq") else null,
        stoppedReason = parseStoppedReason(root.optNullableString("stoppedReason")),
        stats = parseMobileSessionStats(stats),
        queue = if (root.has("queue")) parseQueueItems(root.optJSONArray("queue")) else null,
        goal = parseSessionGoal(root.optJSONObject("goal")),
        goalKnown = root.has("goal"),
    )
    return result
}

/** 工作区目录的一项；[outside] 为指向工作区外或断开的链接，不可进入也不可打开。 */
data class WorkspaceDirEntry(
    val name: String,
    val type: String,
    val size: Long? = null,
    val link: Boolean = false,
    val outside: Boolean = false,
) {
    val isDir: Boolean get() = type == "dir"
    val isFile: Boolean get() = type == "file"
}

data class WorkspaceDirListing(
    val path: String,
    val entries: List<WorkspaceDirEntry>,
    val total: Int,
    val truncated: Boolean,
)

internal fun parseWorkspaceDirListing(root: JSONObject): WorkspaceDirListing {
    val arr = root.optJSONArray("entries") ?: org.json.JSONArray()
    val entries = (0 until arr.length()).mapNotNull { i ->
        val obj = arr.optJSONObject(i) ?: return@mapNotNull null
        val name = obj.optStringOrEmpty("name")
        if (name.isEmpty() || name == "." || name == ".." || name.contains('/')) return@mapNotNull null
        WorkspaceDirEntry(
            name = name,
            type = obj.optStringOrEmpty("type", "other"),
            size = if (obj.has("size") && !obj.isNull("size")) obj.optLong("size") else null,
            link = obj.optBoolean("link", false),
            outside = obj.optBoolean("outside", false),
        )
    }
    return WorkspaceDirListing(
        path = root.optStringOrEmpty("path").trim('/'),
        entries = entries,
        total = root.optInt("total", entries.size),
        truncated = root.optBoolean("truncated", false),
    )
}

/** 目录内子项的相对路径（根为空串）。 */
internal fun childWorkspacePath(dir: String, name: String): String =
    if (dir.isEmpty()) name else "$dir/$name"

/** 上一级目录的相对路径；根的上一级仍是根。 */
internal fun parentWorkspacePath(dir: String): String =
    dir.substringBeforeLast('/', missingDelimiterValue = "")

private fun JSONObject.optIntOrNull(key: String): Int? =
    if (has(key) && !isNull(key)) optInt(key) else null
