/**
 * 审批要显示「这次到底要做什么」。宿主只把 `toolName` / `callId` / `reason` 交给
 * approval/request，真正的参数在同一条 `tool/call` 事件里（seq 紧挨着 approval/asked），
 * 所以手机端要自己按 callId 把参数拼回去，否则审批卡只剩「有个待审批」。
 */

/** 审批卡里最多展示多少字符（手机窄屏，再长也看不清）。 */
export const APPROVAL_DETAIL_LIMIT = 600
/** 通知栏/单行摘要的上限。 */
export const APPROVAL_HEADLINE_LIMIT = 180

/** 这些键单独展示就足够说明「在做什么」，优先于其他参数。 */
const PRIMARY_KEYS = ["command", "cmd", "script", "cmdline"]

/** 参数里可能出现的路径类键，找不到主键时按顺序回退（搜索类工具先给 pattern 再给 path）。 */
const FALLBACK_KEYS = [
  "file_path", "filePath", "notebook_path", "url", "pattern", "query", "path", "target", "prompt",
  // run_code 的源码、桌面工具的人类说明：有就显示，实在没有才只剩工具名。
  "code", "description",
]

/** 原始参数可能是对象，也可能是 JSON 字符串（历史事件里两种都出现过）。 */
export function parseToolArguments(args) {
  if (args == null) return null
  if (typeof args === "object") return Array.isArray(args) ? null : args
  const text = String(args).trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function clip(text, max) {
  const value = String(text ?? "")
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

/** 多行折叠成一行，用于通知标题/正文与事件帧。 */
export function oneLine(text, max = APPROVAL_HEADLINE_LIMIT) {
  return clip(String(text ?? "").replace(/\s+/g, " ").trim(), max)
}

/**
 * 把 tool 参数拼成一段给人看的工作内容。
 * 命令类工具直接给命令原文（保留换行），其他工具给「键: 值」列表；没有可展示的参数时返回 null。
 */
export function toolCallDetail(toolName, args) {
  const parsed = parseToolArguments(args)
  if (!parsed) return null
  for (const key of PRIMARY_KEYS) {
    const value = parsed[key]
    if (typeof value === "string" && value.trim()) return clip(value.trim(), APPROVAL_DETAIL_LIMIT)
  }
  const lines = []
  for (const key of FALLBACK_KEYS) {
    const value = parsed[key]
    if (typeof value === "string" && value.trim()) {
      lines.push(value.trim())
      if (lines.length >= 2) return clip(lines.join("\n"), APPROVAL_DETAIL_LIMIT)
    }
  }
  if (lines.length > 0) return clip(lines.join("\n"), APPROVAL_DETAIL_LIMIT)
  // 没有常用键就把参数平铺（去掉 null/空串），至少让人看出调了什么。
  const entries = Object.entries(parsed).filter(([, value]) => value != null && !(typeof value === "string" && !value.trim()))
  if (entries.length === 0) return null
  const body = entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n")
  return clip(body, APPROVAL_DETAIL_LIMIT)
}

/** 审批卡标题：工具名 + 第一行工作内容。 */
export function approvalHeadline(toolName, detail) {
  const name = String(toolName ?? "").trim() || "tool"
  const line = oneLine(detail, APPROVAL_HEADLINE_LIMIT - name.length - 4)
  return line ? `${name} · ${line}` : name
}
