package dev.deeplinks.native

import androidx.compose.runtime.Immutable
import dev.deeplinks.core.DshStrings
import dev.deeplinks.core.L
import dev.deeplinks.native.util.optNullableString
import dev.deeplinks.native.util.optStringOrEmpty
import dev.deeplinks.native.util.presentOrNull
import org.json.JSONObject

@Immutable
data class MobileMessage(
    val id: String,
    val role: String, // "user", "assistant", "tool_call", "tool_result", "reasoning", "approval", "question", "compaction", "todo", "goal"
    val text: String,
    val toolName: String? = null,
    val toolArgs: String? = null,
    /**
     * 审批的具体工作内容（命令原文、改哪个文件等），插件从同 callId 的 tool/call 里拼出来。
     * 老插件不发；`text` 已经是同内容的兜底。
     */
    val detail: String? = null,
    val approvalId: String? = null,
    val callId: String? = null,
    val time: Long = 0L,
    val type: String = "text",
    val durationMs: Long? = null,
    val running: Boolean? = null,
    val todos: List<MobileTodoItem> = emptyList(),
    // SSE 流式消息为 true：播放入场动画；历史/全量刷新消息为 false：跳过（避免整列重放）
    val entrance: Boolean = false,
    val seq: Long = 0L,
    /**
     * 这条审批/提问来自**请求快照**——即插件把该会话的请求交给了这台手机（D1-A 的「手机接管」）。
     * 只有它才能显示「拒绝 / 批准」按钮；仅来自历史的 approval 消息一律走「在电脑上处理」行。
     * `/requests` 只对「正在查看该会话的设备」返回 200，所以拿到快照就等于接管成立。
     */
    val takenOverByPhone: Boolean = false,
    /** ask_user_question 的 rpcId（role=question） */
    val questionRpcId: String? = null,
    /** 选项 label 列表（JSON 亦可塞 toolArgs；此处便于 UI） */
    val questionOptions: List<String> = emptyList(),
    val questionHeader: String? = null,
    /** 完整 questions 数组 JSON，提交答案时回传 */
    val questionPayloadJson: String? = null,
    val requestStatus: String? = null,
    val outcome: String? = null,
    /** 本轮成功写入/编辑的工作区相对路径（role=produced_files） */
    val files: List<String> = emptyList(),
    /** 顶层轮次号（role=workspace_changes 按它做同轮取代） */
    val turn: Int? = null,
    /** 本轮改动文件摘要（role=workspace_changes） */
    val changes: WorkspaceChangesSummary? = null,
    /** goal/write 事件携带的目标文本（role=goal 时使用） */
    val goalSummary: String? = null,
    /**
     * 插件下发的展示类别（v4 R2.3）：user / injection / goal_round / model_changed，其余与 role 相同。
     * null = 旧插件或实时流，由 [dev.deeplinks.native.util.resolvedMessageKind] 按文本兜底。
     */
    val kind: String? = null,
    /** kind=goal_round 时插件解析好的轮次（整数，不再从文本里抠） */
    val goalRound: Int? = null,
    val goalMaxRounds: Int? = null,
    val goalObjective: String? = null,
)

@Immutable
data class MobileTodoItem(val content: String, val status: String = "pending")

@Immutable
data class HistoryResult(
    val messages: List<MobileMessage>,
    val stats: MobileSessionStats,
    val hasMore: Boolean = false,
    val nextBeforeSeq: Long? = null,
    val maxSeq: Long? = null,
    val stoppedReason: String? = null,
    /** 排队 / 引导中的消息；null = 旧插件没有该字段（不覆盖现值）。 */
    val queue: List<QueuedPrompt>? = null,
    val goal: SessionGoal? = null,
    /** 响应里带了 goal 字段（即便为 null，表示目标已清除）。 */
    val goalKnown: Boolean = false,
)

@Immutable
data class MobileSession(
    val sessionId: String,
    val title: String,
    val updatedAt: Long,
    val running: Boolean,
    val blank: Boolean,
    val cwd: String?,
    val agentPreset: String?,
    val origin: String? = null, // "subagent" = 子智能体会话（侧边栏隐藏，对齐 Web UI rowVisible）
    val parentSessionId: String? = null,
    val subagentCount: Int? = null,
    /** 有未结束的审批 / 澄清问题（插件自记，见 MOBILE_SYNC_CONTRACT）；首页「等待确认」分区。 */
    val awaitingInput: Boolean = false,
    /**
     * 当前步骤（只在 running 时有）：插件从 session.history 推导，字段级约定见 MOBILE_SYNC_CONTRACT。
     * 旧插件不下发，为 null 时首页写「运行中」。
     */
    val activity: MobileSessionActivity? = null,
    /**
     * 结果一句话（只在非 running 时有）：最后一条回复摘要 + 本轮改动统计。
     * 旧插件不下发，为 null 时首页写「已完成」。
     */
    val lastResult: MobileSessionResult? = null,
    /** 这一轮怎么结束的（插件阶段 2 起下发）：null = 正常完成或旧插件 → 各处按「已完成」回退。 */
    val stoppedReason: String? = null,
)

/** 会话当前步骤：`kind` 决定文案，`tool` 时 [label] 是命令或参数摘要。 */
@Immutable
data class MobileSessionActivity(
    val kind: String,
    val label: String? = null,
    val step: Long? = null,
    val startedAt: Long? = null,
) {
    val isTool: Boolean get() = kind == "tool"
}

/** 会话结果一句话：文本与改动统计都可缺。 */
@Immutable
data class MobileSessionResult(
    val text: String? = null,
    val files: Long? = null,
    val added: Long? = null,
    val deleted: Long? = null,
)

@Immutable
data class MobilePairedDevice(
    val deviceId: String,
    val name: String,
    val createdAt: Long = 0L,
    val lastSeenAt: Long = 0L,
    /** `lan` / `remote`（经远程首配）/ `relay`（旧版云端配对，该中继已下线）。 */
    val via: String = "lan",
)

@Immutable
data class MobileSearchResult(val sessionId: String, val snippet: String)

data class MobilePreview(val previewId: String, val label: String, val port: Int, val expiresAt: Long)

data class MobileBootstrap(
    val hostName: String,
    val deviceName: String,
    val sessions: List<MobileSession>,
    val archivedSessionIds: Set<String> = emptySet(),
    val archiveSnapshotAvailable: Boolean = false,
    val protocol: Int = 1,
    val syncResync: Boolean = false,
    val multiQuestion: Boolean = false,
    val requestSnapshot: Boolean = false,
    /** 插件支持按层列工作区目录（capabilities.files.tree）。 */
    val filesTree: Boolean = false,
    /** 插件支持排队 / 目标 / 定时任务管理（capabilities.control）。 */
    val sessionControl: Boolean = false,
    /** 插件可以列出已批准的本机预览（capabilities.preview.v = 1）。 */
    val preview: Boolean = false,
    /** 插件可以从工具输出里看到本机端口（capabilities.preview.detect = 1）。手机不能批准。 */
    val previewDetect: Boolean = false,
    /** 实测缺失的宿主能力（capabilities.host.missing）；对应入口直接藏，老插件不发为空集。 */
    val hostMissing: Set<String> = emptySet(),
    /** 插件版本与最低兼容 App 版本声明（capabilities.compat）；老插件为 null。 */
    val compat: dev.deeplinks.core.PluginCompatInfo? = null,
)

data class SessionRequestState(
    val id: String,
    val kind: String,
    val status: String,
    val outcome: String? = null,
    val questionsJson: String? = null,
    val toolName: String? = null,
    val callId: String? = null,
    /** 审批的工作内容（命令原文等）；老插件不发。 */
    val detail: String? = null,
)

data class SessionRequestSnapshot(
    val approvals: List<SessionRequestState> = emptyList(),
    val questions: List<SessionRequestState> = emptyList(),
)

internal fun parseSessionRequestSnapshot(root: JSONObject): SessionRequestSnapshot {
    val approvals = root.optJSONArray("approvals") ?: org.json.JSONArray()
    val questions = root.optJSONArray("questions") ?: org.json.JSONArray()
    return SessionRequestSnapshot(
        approvals = (0 until approvals.length()).mapNotNull { i ->
            val obj = approvals.optJSONObject(i) ?: return@mapNotNull null
            val id = obj.optStringOrEmpty("approvalId").ifBlank { obj.optStringOrEmpty("id") }
            if (id.isBlank()) return@mapNotNull null
            SessionRequestState(
                id = id,
                kind = "approval",
                status = obj.optStringOrEmpty("status", REQUEST_PENDING),
                outcome = obj.optNullableString("outcome"),
                toolName = obj.optNullableString("toolName"),
                callId = obj.optNullableString("callId"),
                detail = obj.optNullableString("detail"),
            )
        },
        questions = (0 until questions.length()).mapNotNull { i ->
            val obj = questions.optJSONObject(i) ?: return@mapNotNull null
            val id = obj.optStringOrEmpty("rpcId").ifBlank { obj.optStringOrEmpty("id") }
            if (id.isBlank()) return@mapNotNull null
            SessionRequestState(
                id = id,
                kind = "question",
                status = obj.optStringOrEmpty("status", REQUEST_PENDING),
                outcome = obj.optNullableString("outcome"),
                questionsJson = obj.optJSONArray("questions")?.toString()
                    ?: obj.optNullableString("questionsJson"),
            )
        },
    )
}

@Immutable
data class MobileWorkspace(
    val workspaceId: String,
    val path: String,
    val title: String = "",
    val sessionIds: List<String> = emptyList(),
)

@Immutable
data class MobileWorkspaceCatalog(
    val workspaces: List<MobileWorkspace>,
    val archivedSessionIds: Set<String> = emptySet(),
    val archiveSnapshotAvailable: Boolean = false,
) {
    val paths: List<String> get() = workspaces.map { it.path }
}

@Immutable
data class MobileSessionSnapshot(
    val sessions: List<MobileSession>,
    val archivedSessionIds: Set<String> = emptySet(),
    val archiveSnapshotAvailable: Boolean = false,
)

data class MobileWorkspaceCreation(
    val workspace: MobileWorkspace?,
    val created: Boolean,
    val pending: Boolean = false,
    val path: String = "",
)

internal fun parseMobileWorkspace(json: JSONObject?): MobileWorkspace? {
    if (json == null) return null
    val path = json.optStringOrEmpty("path").ifBlank { json.optStringOrEmpty("title") }.trimEnd('/')
    if (path.isBlank()) return null
    val ids = json.optJSONArray("sessionIds") ?: org.json.JSONArray()
    return MobileWorkspace(
        workspaceId = json.optStringOrEmpty("workspaceId").ifBlank { json.optStringOrEmpty("id") },
        path = path,
        title = json.optStringOrEmpty("title").ifBlank { path.substringAfterLast('/') },
        sessionIds = (0 until ids.length()).mapNotNull { index ->
            ids.optString(index).takeIf { it.isNotBlank() }
        },
    )
}

internal fun parseHistoryFiles(json: JSONObject): List<String> {
    val arr = json.optJSONArray("files") ?: return emptyList()
    return (0 until arr.length()).mapNotNull { index ->
        arr.optString(index).trim().takeIf { it.isNotBlank() }
    }
}

/**
 * 会话「当前步骤」：字段缺失或 `kind` 为空视为没有（旧插件回退）。
 * `label` / `step` / `startedAt` 都是可缺的，缺了就不给值，让 UI 走通用文案。
 */
internal fun parseMobileSessionActivity(json: JSONObject?): MobileSessionActivity? {
    val kind = json?.optNullableString("kind") ?: return null
    return MobileSessionActivity(
        kind = kind,
        label = json.optNullableString("label"),
        step = json.optLong("step", -1L).takeIf { it >= 0 },
        startedAt = json.optLong("startedAt", -1L).takeIf { it >= 0 },
    )
}

/** 会话「结果一句话」：文本与三个统计都可缺；全缺时不下发该字段。 */
internal fun parseMobileSessionResult(json: JSONObject?): MobileSessionResult? {
    if (json == null) return null
    val result = MobileSessionResult(
        text = json.optNullableString("text"),
        files = json.optLong("files", -1L).takeIf { it >= 0 },
        added = json.optLong("added", -1L).takeIf { it >= 0 },
        deleted = json.optLong("deleted", -1L).takeIf { it >= 0 },
    )
    val empty = result.text == null && result.files == null && result.added == null && result.deleted == null
    return result.takeUnless { empty }
}

internal fun parseMobileSession(json: JSONObject): MobileSession = MobileSession(
    sessionId = json.getString("sessionId"),
    title = json.optNullableString("title") ?: L.untitledSession,
    updatedAt = json.optLong("updatedAt"),
    running = json.optBoolean("running"),
    blank = json.optBoolean("blank"),
    cwd = json.optNullableString("cwd"),
    agentPreset = json.optNullableString("agentPreset"),
    origin = json.optNullableString("origin"),
    parentSessionId = json.optNullableString("parentSessionId"),
    subagentCount = json.optInt("subagentCount", -1).takeIf { it >= 0 },
    awaitingInput = json.optBoolean("awaitingInput"),
    activity = parseMobileSessionActivity(json.optJSONObject("activity")),
    lastResult = parseMobileSessionResult(json.optJSONObject("lastResult")),
    stoppedReason = json.optNullableString("stoppedReason"),
)

internal fun resolveHarnessLabel(
    presets: List<MobileAgentPreset>,
    activeId: String?,
    settingsId: String,
    fallback: String,
): String {
    val id = activeId.presentOrNull() ?: settingsId.presentOrNull() ?: return fallback
    return presetDisplayName(id, presets.find { it.id == id }?.name)
}

/**
 * DSH 内置预设的本地化名称（对齐桌面版 ui-agent-preset 文案表）。
 * 内置预设在服务端没有 name，列表里只剩 id；自定义预设用它自己的 name。
 */
internal fun builtinPresetName(id: String, strings: DshStrings = L): String? = when (id) {
    "standard" -> strings.presetStandard
    "ptc", "code" -> strings.presetCode
    "minimal" -> strings.presetMinimal
    "cordis", "creator" -> strings.presetCreator
    else -> null
}

internal fun builtinPresetDescription(id: String): String? = when (id) {
    "standard" -> L.presetStandardDesc
    "ptc", "code" -> L.presetCodeDesc
    "minimal" -> L.presetMinimalDesc
    "cordis", "creator" -> L.presetCreatorDesc
    else -> null
}

internal fun presetDisplayName(id: String, serverName: String?, strings: DshStrings = L): String {
    val name = serverName.presentOrNull()
    if (name != null && name != id) return name
    return builtinPresetName(id, strings) ?: name ?: id
}

internal fun presetDisplayDescription(id: String, serverDescription: String?): String =
    builtinPresetDescription(id) ?: serverDescription.presentOrNull() ?: ""

data class MobileSessionStats(
    val turns: Long = 0,
    val steps: Long = 0,
    val llmMs: Long = 0,
    val toolMs: Long = 0,
    val ttftMs: Long = 0,
    val ttftSteps: Long = 0,
    val decodeMs: Long = 0,
    val decodeTokens: Long = 0,
    val uncachedInputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val outputTokens: Long = 0,
    // ContextMeter（contextPressure/contextBreakdown 投影）
    val contextPressureTokens: Long = 0,
    val contextWindow: Long = 0,
    val systemTokens: Long = 0,
    val toolsTokens: Long = 0,
    val messageTokens: Long = 0,
    val estimatedCost: EstimatedCost? = null,
)

/** 插件算的预估花费。旧 App 忽略这个字段。source 为 host 或 builtin。 */
data class EstimatedCost(
    val amount: Double,
    val currency: String,
    val priceDate: String?,
    val source: String,
    /** 内置表计价时：整段全按谷时 / 全按峰时的金额（插件拿不到逐轮时间，只能给区间）。 */
    val amountMin: Double? = null,
    val amountMax: Double? = null,
)

data class MobileModelOption(
    val id: String,
    val name: String?,
    val contextWindow: Long?,
    val maxTokens: Long?,
    val reasoningEfforts: List<String> = emptyList(),
    val defaultEffort: String? = null,
)

data class MobileModelGroup(
    val provider: String,
    val displayName: String = provider,
    val models: List<MobileModelOption>,
)

data class MobileModelCatalog(
    val currentProvider: String? = null,
    val currentModel: String? = null,
    val currentReasoningEffort: String? = null,
    val groups: List<MobileModelGroup> = emptyList(),
)

/** 一个设置命名空间的脱敏视图（settings.describe/update 的移动端投影）。 */
data class MobileSettingsNamespace(
    val ns: String,
    val value: JSONObject,
    val user: JSONObject? = null,
    val applies: String = "restart",
    val revision: Long = 0,
    val secrets: List<Pair<List<String>, Boolean>> = emptyList(),
)

data class MobileSettingsView(
    val writable: Boolean,
    val namespaces: List<MobileSettingsNamespace>,
)

data class MobileAgentPreset(
    val id: String,
    val name: String,
    val description: String = "",
    val isDefault: Boolean = false,
)

data class MobileWallet(val currency: String, val balance: String)

/**
 * DeepSeek 账户余额（插件代调 account/getBalance）。
 * status：ready / signed-out / failed / unavailable（旧 DSH）。
 */
data class MobileBalance(
    val status: String,
    val wallets: List<MobileWallet> = emptyList(),
    val bonusWallets: List<MobileWallet> = emptyList(),
)

data class MobileProviderCredential(
    val configured: Boolean,
    val writable: Boolean,
    val source: String? = null,
)

/** 模型页供应商行；kind = "account"（DeepSeek 账户）或 "api"（API 密钥）。 */
data class MobileProviderRow(
    val provider: String,
    val displayName: String,
    val kind: String,
    val active: Boolean,
    val custom: Boolean,
    val keyRef: String?,
    val credential: MobileProviderCredential?,
    val models: List<MobileModelOption>,
    val modelsEditable: Boolean,
    val canDiscover: Boolean,
)

data class MobileAddableProvider(val provider: String, val displayName: String)

data class MobileProviderDirectory(
    val writable: Boolean,
    val providers: List<MobileProviderRow>,
    val addable: List<MobileAddableProvider>,
)

/** 手机要追加到 profile.models 的条目；inputModalities 仅 text / image。 */
data class MobileModelDraft(
    val id: String,
    val name: String? = null,
    val contextWindow: Long? = null,
    val maxTokens: Long? = null,
    val inputModalities: List<String> = emptyList(),
)

/** 服务端为源的 AppSettings（WI-004）：默认 Agent 预设/权限/语言/主题/Enter 行为/默认模型。 */
data class AppSettings(
    val agentPreset: String = "standard",
    val permissionPreset: String = "workspace-write",
    val language: String = "zh",
    val theme: String = "system",
    val busyEnter: String = "queue",
    val defaultModelProvider: String? = null,
    val defaultModel: String? = null,
    val defaultReasoningEffort: String? = null,
) {
    companion object {
        fun fromServer(namespaces: List<MobileSettingsNamespace>): AppSettings {
            val byNs = namespaces.associateBy { it.ns }
            fun valueOf(ns: String, key: String): String? =
                byNs[ns]?.value?.optNullableString(key)
            return AppSettings(
                agentPreset = valueOf("agent-presets", "default") ?: "standard",
                permissionPreset = valueOf("permission", "defaultPreset") ?: "workspace-write",
                language = valueOf("locale", "preference") ?: "zh",
                theme = valueOf("ui-theme", "preference") ?: "system",
                busyEnter = valueOf("ui-conversation", "busyEnter") ?: "queue",
                defaultModelProvider = valueOf("agent-default-model", "provider"),
                defaultModel = valueOf("agent-default-model", "model"),
                defaultReasoningEffort = valueOf("agent-default-model", "reasoningEffort"),
            )
        }
    }
}

/** 解析 history/stats 响应中的会话统计（StatsLine/ContextMeter 数据源）。 */
fun parseMobileSessionStats(stats: org.json.JSONObject?): MobileSessionStats {
    val usage = stats?.optJSONObject("tokenUsage")
    val sessionStats = stats?.optJSONObject("sessionStats")
    val pressure = stats?.optJSONObject("contextPressure")
    val breakdown = stats?.optJSONObject("contextBreakdown")
    return MobileSessionStats(
        turns = sessionStats?.optLong("turns", 0L) ?: 0L,
        steps = sessionStats?.optLong("steps", 0L) ?: 0L,
        llmMs = sessionStats?.optLong("llmMs", 0L) ?: 0L,
        toolMs = sessionStats?.optLong("toolMs", 0L) ?: 0L,
        ttftMs = sessionStats?.optLong("ttftMs", 0L) ?: 0L,
        ttftSteps = sessionStats?.optLong("ttftSteps", 0L) ?: 0L,
        decodeMs = sessionStats?.optLong("decodeMs", 0L) ?: 0L,
        decodeTokens = sessionStats?.optLong("decodeTokens", 0L) ?: 0L,
        uncachedInputTokens = usage?.optLong("uncachedInputTokens", 0L) ?: 0L,
        cacheReadTokens = usage?.optLong("cacheReadTokens", 0L) ?: 0L,
        outputTokens = usage?.optLong("outputTokens", 0L) ?: 0L,
        contextPressureTokens = pressure?.optLong("projectedTokens", 0L) ?: pressure?.optLong("pressureTokens", 0L) ?: 0L,
        contextWindow = pressure?.optLong("contextWindow", 0L) ?: 0L,
        systemTokens = breakdown?.optLong("systemTokens", 0L) ?: 0L,
        toolsTokens = breakdown?.optLong("toolsTokens", 0L) ?: 0L,
        messageTokens = breakdown?.optLong("messageTokens", 0L) ?: 0L,
        estimatedCost = parseEstimatedCost(stats?.optJSONObject("estimatedCost")),
    )
}

internal fun parseEstimatedCost(raw: org.json.JSONObject?): EstimatedCost? {
    if (raw == null) return null
    if (!raw.has("amount") || raw.isNull("amount")) return null
    val amount = raw.optDouble("amount")
    val currency = raw.optString("currency").trim()
    if (!amount.isFinite() || amount < 0 || currency.isEmpty()) return null
    val priceDate = raw.optString("priceDate").trim().ifEmpty { null }
    val source = raw.optString("source").trim().ifEmpty { "builtin" }
    val min = raw.optDouble("amountMin", Double.NaN).takeIf { it.isFinite() && it >= 0 }
    val max = raw.optDouble("amountMax", Double.NaN).takeIf { it.isFinite() && it >= 0 }
    val range = min != null && max != null && max > min
    return EstimatedCost(amount, currency, priceDate, source, if (range) min else null, if (range) max else null)
}

/** 智能体运行中时，按 ui-conversation.busyEnter 决定 prompt mode（对标 web）。 */
fun resolvePromptMode(running: Boolean, busyEnter: String): String {
    if (!running) return "queue"
    return when (busyEnter) {
        "send", "steer" -> busyEnter
        "queue", "newline" -> "queue"
        else -> "queue"
    }
}

/** 将服务端 busyEnter 规范化为设置 UI 可选 id（兼容历史 newline 与 web steer）。 */
fun canonicalBusyEnter(value: String?): String = when (value) {
    "send", "steer", "queue" -> value
    "newline" -> "queue"
    else -> "queue"
}

fun busyEnterLabel(value: String?): String = when (canonicalBusyEnter(value)) {
    "send" -> L.busySend
    "steer" -> L.busySteer
    else -> L.busyQueue
}
