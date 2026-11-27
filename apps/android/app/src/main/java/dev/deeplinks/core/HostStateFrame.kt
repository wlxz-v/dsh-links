package dev.deeplinks.core

import org.json.JSONObject

/**
 * `session/state` 一帧的字段（插件的 hostEventFrame 输出）。
 *
 * 抽成纯数据类 + 纯函数是为了能被单测直接喂 JSON：`ProtocolVectorsTest` 读仓库里的
 * `spec/protocol-vectors.json`，逐条断言这里解析出的键与插件承诺的形状一致 —— 双端契约
 * 只有一份来源，插件改了帧形状而 App 没跟上时测试立刻红。
 */
data class HostStateFields(
    val sessionId: String,
    val state: String,
    val title: String,
    val origin: String,
    val seq: Long,
    /** 宿主的通知建议：false 表示同一会话 60 秒内重复的同一种终态，不必再响一次。缺省 true。 */
    val notify: Boolean = true,
    /** 待办审批 id / 工具名（双端审批）；没有待办审批时都是 null。 */
    val approvalId: String? = null,
    val approvalToolName: String? = null,
    /** 这次审批要做什么（命令原文等）。 */
    val approvalDetail: String? = null,
    val approvalRiskLevel: String? = null,
    val approvalRiskReason: String? = null,
    /** 待回答的澄清请求 id 与第一题题干（双端澄清）。 */
    val questionId: String? = null,
    val questionText: String? = null,
)

/**
 * 解析 `session/state` 的数据体。`sessionId` 为空视为无效帧（返回 null）。
 * `eventSeq` 是 SSE 的 `id:` 行；帧里没有 `seq` 时用它兜底，两者都没有就是 0。
 */
fun parseHostStateFields(body: String, eventSeq: Long? = null): HostStateFields? {
    val obj = try {
        JSONObject(body)
    } catch (_: Exception) {
        return null
    }
    val sessionId = obj.optString("sessionId")
    if (sessionId.isBlank()) return null
    return HostStateFields(
        sessionId = sessionId,
        state = obj.optString("state"),
        title = obj.optString("title"),
        origin = obj.optString("origin"),
        seq = eventSeq ?: obj.optLong("seq"),
        notify = obj.optBoolean("notify", true),
        // optString 缺键返回 ""，这里要的是「有没有」，空串统一成 null。
        approvalId = obj.optString("approvalId").takeIf { it.isNotBlank() },
        approvalToolName = obj.optString("approvalToolName").takeIf { it.isNotBlank() },
        approvalDetail = obj.optString("approvalDetail").takeIf { it.isNotBlank() },
        approvalRiskLevel = obj.optString("approvalRiskLevel").takeIf { it.isNotBlank() },
        approvalRiskReason = obj.optString("approvalRiskReason").takeIf { it.isNotBlank() },
        questionId = obj.optString("questionId").takeIf { it.isNotBlank() },
        questionText = obj.optString("questionText").takeIf { it.isNotBlank() },
    )
}
