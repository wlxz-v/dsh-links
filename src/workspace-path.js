import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve, sep } from "node:path"
import { optionalString } from "./optional-string.js"

/** 跟随符号链接。末段尚不存在时，realpath 最深的已存在祖先，再接回缺失后缀。 */
function canonicalPathForContainment(p) {
  const resolved = resolve(String(p ?? ""))
  const missing = []
  let current = resolved
  while (true) {
    try {
      const real = realpathSync(current)
      return missing.length ? resolve(real, ...missing) : real
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err
      const parent = dirname(current)
      if (parent === current) return resolved
      missing.unshift(basename(current))
      current = parent
    }
  }
}

export function normalizeComparisonPath(p, platform = process.platform) {
  if (platform !== "win32") return String(p).replace(/\/+$/, "") || "/"
  return String(p).replace(/\//g, "\\").replace(/\\+$/, (m, offset) => (offset <= 2 ? m : "")).toLowerCase()
}

export function isPathWithinRoot(target, root, platform = process.platform) {
  const normTarget = normalizeComparisonPath(target, platform)
  const normRoot = normalizeComparisonPath(root, platform)
  if (normTarget === normRoot) return true
  const separator = platform === "win32" ? "\\" : sep
  const prefix = normRoot.endsWith(separator) ? normRoot : normRoot + separator
  return normTarget.startsWith(prefix)
}

/** session.create 的 cwd / workspaceId 必须落在已注册工作区内。都没给时交给 DSH 选默认工作区。 */
export function validateSessionCreateWorkspace({ cwd, workspaceId, workspaces }) {
  const roots = (Array.isArray(workspaces) ? workspaces : [])
    .map((item) => ({ workspaceId: String(item?.workspaceId ?? "").trim(), path: optionalString(item?.path) }))
    .filter((w) => w.path && isAbsolute(w.path))
  if (workspaceId) {
    const hit = roots.find((w) => w.workspaceId && w.workspaceId === workspaceId)
    if (!hit) return { error: "workspaceId 未注册或不可用" }
    return { workspaceId }
  }
  if (!cwd) return { ok: true }
  if (!isAbsolute(String(cwd))) return { error: "cwd 必须是绝对路径" }
  let target
  try {
    target = canonicalPathForContainment(cwd)
  } catch {
    return { error: "无法解析 cwd 路径" }
  }
  const inside = roots.some((w) => {
    try {
      return isPathWithinRoot(target, canonicalPathForContainment(w.path))
    } catch {
      return false
    }
  })
  if (!inside) return { error: "cwd 不在已注册工作区内" }
  return { cwd: target }
}
