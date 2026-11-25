/**
 * DSH JSONL 会话日志的当前 generation 文件名。
 * v0 是 `session.jsonl[.zstd]`；之后是 `session.vN.jsonl[.zstd]`（当前为 v3）。
 * 与 `@deepseek-ai/dsh-session-format` 的 canonical basename 规则对齐。
 */
import { existsSync, readdirSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const CANONICAL = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u

export function parseSessionLogFilename(filename) {
  if (typeof filename !== "string") return null
  const match = CANONICAL.exec(filename)
  if (!match) return null
  const version = match[1] === undefined ? 0 : Number(match[1])
  if (!Number.isSafeInteger(version)) return null
  return { version, compressed: match[2] === ".zstd" }
}

export function pickCurrentSessionLogFilename(names) {
  let best = null
  for (const name of names ?? []) {
    const parsed = parseSessionLogFilename(name)
    if (!parsed) continue
    if (
      !best
      || parsed.version > best.version
      || (parsed.version === best.version && parsed.compressed && !best.compressed)
    ) {
      best = { ...parsed, filename: name }
    }
  }
  return best?.filename ?? null
}

/**
 * 与 `@deepseek-ai/dsh-session-persistence-jsonl` 对齐的路径段转义与项目键编码：
 * - 路径分隔符 `/`、`\` 与盘符 `:` 合并为单个 `-`；
 * - 非 `[A-Za-z0-9._-]`（以及 `~` 本身）按 UTF-16 码元转义为 `~XXXX`；
 * - 会话目录：`<DSH 数据目录>/sessions/--<projectKey>--/<encodedSessionId>`（无 cwd 时为 `_no-cwd`）。
 */
export function encodeSessionSegment(raw) {
  const s = String(raw ?? "")
  if (s.length === 0) throw new Error("cannot encode an empty path segment")
  if (s === ".") return "~002E"
  if (s === "..") return "~002E~002E"
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== "~" && /^[A-Za-z0-9._-]$/u.test(ch)) out += ch
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0")
  }
  return out
}

export function encodeSessionProjectKey(cwd) {
  const s = String(cwd ?? "")
  if (s.length === 0) throw new Error("cannot encode an empty project path")
  let readable = ""
  let separatorRun = false
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-"
      separatorRun = true
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0")
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, "") || "root").slice(0, 251)}--`
}

export function sessionDirFor(cwd, sessionId, env = process.env) {
  const id = String(sessionId ?? "").trim()
  if (!id) return null
  const home = String(env?.DSH_HOME ?? "").trim() || join(homedir(), ".dsh")
  const rawCwd = cwd === undefined || cwd === null ? "" : String(cwd)
  const projectDir = rawCwd.length === 0 ? "_no-cwd" : encodeSessionProjectKey(rawCwd)
  return join(home, "sessions", projectDir, encodeSessionSegment(id))
}

export function resolveSessionLogPath(sessionDir) {
  if (!sessionDir || !existsSync(sessionDir)) return null
  let names
  try {
    names = readdirSync(sessionDir)
  } catch {
    return null
  }
  const filename = pickCurrentSessionLogFilename(names)
  return filename ? join(sessionDir, filename) : null
}

export async function resolveSessionLogPathAsync(sessionDir) {
  if (!sessionDir) return null
  let names
  try {
    names = await readdir(sessionDir)
  } catch {
    return null
  }
  const filename = pickCurrentSessionLogFilename(names)
  return filename ? join(sessionDir, filename) : null
}
