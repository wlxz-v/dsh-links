/** 运行时热开关管理（C3）：持久化到 state.json，切换后免重启生效。 */

export const FEATURE_KEYS = Object.freeze(["previewProxy", "workspaceFiles", "diagnostics"])
export const DEFAULT_FEATURES = Object.freeze({
  previewProxy: true,
  workspaceFiles: true,
  diagnostics: true,
})

const FEATURE_SET = new Set(FEATURE_KEYS)

export function normalizeFeatures(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  return {
    previewProxy: typeof src.previewProxy === "boolean" ? src.previewProxy : DEFAULT_FEATURES.previewProxy,
    workspaceFiles: typeof src.workspaceFiles === "boolean" ? src.workspaceFiles : DEFAULT_FEATURES.workspaceFiles,
    diagnostics: typeof src.diagnostics === "boolean" ? src.diagnostics : DEFAULT_FEATURES.diagnostics,
  }
}

export function createFeatureManager({ state, save, now = () => Date.now() }) {
  const current = normalizeFeatures(state?.features)
  if (state && typeof state === "object") {
    state.features = { ...current }
  }
  let updatedAt = Number.isFinite(state?.featuresUpdatedAt) ? state.featuresUpdatedAt : null

  return {
    isEnabled(name) {
      if (!FEATURE_SET.has(name)) return true
      return current[name] !== false
    },
    snapshot() {
      return {
        features: { ...current },
        updatedAt,
      }
    },
    update(patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return { ok: false, status: 400, error: "请求体必须是 JSON 对象" }
      }
      const entries = Object.entries(patch)
      if (entries.length === 0) {
        return { ok: false, status: 400, error: "至少需要一个功能开关字段" }
      }
      for (const [key, val] of entries) {
        if (!FEATURE_SET.has(key)) {
          return { ok: false, status: 400, error: `未知功能开关: ${key}` }
        }
        if (typeof val !== "boolean") {
          return { ok: false, status: 400, error: `开关 ${key} 必须是布尔值` }
        }
      }
      const disabledNow = []
      for (const [key, val] of entries) {
        if (current[key] !== false && val === false) disabledNow.push(key)
        current[key] = val
      }
      updatedAt = now()
      if (state && typeof state === "object") {
        state.features = { ...current }
        state.featuresUpdatedAt = updatedAt
      }
      save()
      return { ok: true, status: 200, features: { ...current }, updatedAt, disabledNow }
    },
  }
}
