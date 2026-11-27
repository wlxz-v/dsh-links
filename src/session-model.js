/** 会话内切模型防全局回写保护（C4）。 */

function normalizeModelValue(raw) {
  if (!raw || typeof raw !== "object") return null
  const provider = typeof raw.provider === "string" ? raw.provider : ""
  const model = typeof raw.model === "string" ? raw.model : ""
  const effort = typeof raw.reasoningEffort === "string" && raw.reasoningEffort.trim() ? raw.reasoningEffort.trim() : null
  if (!provider && !model && !effort) return null
  return effort !== null ? { provider, model, reasoningEffort: effort } : { provider, model }
}

export function extractDefaultModelSnapshot(described) {
  if (!described || typeof described !== "object") return null
  let entry = null
  if (Array.isArray(described.namespaces)) {
    entry = described.namespaces.find((item) => item?.ns === "agent-default-model") ?? null
  } else if (described["agent-default-model"] && typeof described["agent-default-model"] === "object") {
    entry = described["agent-default-model"]
  }
  if (!entry) return null
  const rawValue = entry.value && typeof entry.value === "object" ? entry.value : entry
  const value = normalizeModelValue(rawValue)
  if (!value) return null
  const revision = Number.isInteger(entry.revision) ? entry.revision : undefined
  return { value, revision }
}

export function defaultModelChanged(before, after) {
  if (!before || !after) return false
  return (
    (before.provider ?? "") !== (after.provider ?? "") ||
    (before.model ?? "") !== (after.model ?? "") ||
    (before.reasoningEffort ?? "") !== (after.reasoningEffort ?? "")
  )
}

let switchQueue = Promise.resolve()

export function withSessionModelLock(fn) {
  const next = switchQueue.then(fn, fn)
  switchQueue = next.catch(() => {})
  return next
}

/**
 * 在单进程串行锁内执行会话切模型；若宿主 `session.selectModel` 副作用改写了
 * `agent-default-model`，静默用 `settings.update` 还原快照（还原失败只 warn 不阻断切模型）。
 */
export function runIsolatedSessionModelSwitch({ rpcCall, executeSelect, isRevoked = () => false, onWarn = () => {} }) {
  return withSessionModelLock(async () => {
    let before = null
    try {
      before = extractDefaultModelSnapshot(await rpcCall("settings.describe", {}))
    } catch {
      before = null
    }
    const result = await executeSelect()
    if (!before || isRevoked(result)) return result
    try {
      const after = extractDefaultModelSnapshot(await rpcCall("settings.describe", {}))
      if (after && defaultModelChanged(before.value, after.value)) {
        const patch = {
          provider: before.value.provider,
          model: before.value.model,
          ...(before.value.reasoningEffort !== undefined
            ? { reasoningEffort: before.value.reasoningEffort }
            : after.value.reasoningEffort !== undefined
              ? { reasoningEffort: "" }
              : {}),
        }
        await rpcCall("settings.update", {
          ns: "agent-default-model",
          patch,
          ...(Number.isInteger(after.revision) ? { expectedRevision: after.revision } : {}),
        })
      }
    } catch (err) {
      try { onWarn(err) } catch {}
    }
    return result
  })
}
