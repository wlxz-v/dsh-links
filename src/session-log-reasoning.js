/**
 * 会话日志（JSONL 文本）→ reasoning 块索引。
 *
 * RPC 投影会剥掉父会话的思考内容，所以冷会话/分页历史的思考只能从会话
 * 日志文件里补：这里按块首 `seq` 建索引，与 `src/history.js` 投影的事件侧
 * 分组规则保持一致（flush 点必须同源，否则同一条思考会被拆成两段或重复）。
 *
 * 从 `src/index.js` 抽出，便于用多帧 zstd 日志做回归测试。
 */
const FLUSH_TYPES = new Set([
  "user/message",
  "approval/asked",
  "approval/decided",
  "tool/call",
  "tool/result",
  "compaction/start",
  "todo/write",
  "workspace/changes",
  "turn/end",
])

/**
 * @param {string} text 会话日志正文（已解压）
 * @returns {Map<number, { seq: number, time: number, text: string }>}
 */
export function reasoningBlocksFromSessionLog(text) {
  const raw = String(text ?? "")
  const reasoning = new Map()
  if (!raw || !raw.includes("reasoning")) return reasoning
  let pending = null // { seq, time, text }
  const flush = (time) => {
    if (!pending) return
    const blockText = pending.text.trim()
    if (blockText) {
      reasoning.set(pending.seq, { seq: pending.seq, time: pending.time || time, text: blockText })
    }
    pending = null
  }
  let pos = 0
  while (pos < raw.length) {
    let end = raw.indexOf("\n", pos)
    if (end === -1) end = raw.length
    const line = raw.slice(pos, end)
    pos = end + 1
    if (!line || !line.trim()) continue
    // pending 为空时，只有包含 "reasoning" 的 assistant/chunk 能开启新块；跳过 90%+ 无关大行（如 tool/result）。
    if (!pending && !line.includes("reasoning")) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e?.type === "assistant/chunk") {
      const chunk = e?.data?.chunk
      if (chunk?.type === "block-end" && chunk.block?.type === "reasoning") {
        const blockText = chunk.block?.text
        if (blockText && typeof e.seq === "number") {
          pending = pending
            ? { seq: pending.seq, time: pending.time, text: pending.text + "\n" + blockText }
            : { seq: e.seq, time: e.time, text: blockText }
        }
        continue
      }
      if (chunk?.type === "block-end" && chunk.block?.text) flush(e?.time ?? 0)
    } else if (e?.type === "assistant/message") {
      flush(e?.time ?? 0)
    } else if (FLUSH_TYPES.has(e?.type)) {
      flush(e?.time ?? 0)
    }
  }
  flush(0)
  return reasoning
}
