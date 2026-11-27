import { isAbsolute, relative, resolve, sep } from "node:path"
import { constants as fsConstants, lstatSync, readdirSync, realpathSync, statSync } from "node:fs"
import { lstat, open, readdir, realpath, stat } from "node:fs/promises"

export const MAX_WORKSPACE_FILE_BYTES = 8 * 1024 * 1024
export const MAX_RANGE_FILE_BYTES = 256 * 1024 * 1024
export const MAX_RANGE_CHUNK_BYTES = 2 * 1024 * 1024
export const MAX_WORKSPACE_DIR_ENTRIES = 2000

function httpError(message, status) {
  const err = new Error(message)
  err.status = status
  return err
}

function insideRoot(root, real) {
  const rel = relative(root, real)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

function mapFsError(err, missingMessage) {
  if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return httpError(missingMessage, 404)
  if (err?.code === "EACCES" || err?.code === "EPERM") return httpError("无权限访问", 403)
  return err
}

export function resolveWorkspaceFile(cwd, requested) {
  if (typeof cwd !== "string" || !cwd.trim()) throw httpError("缺少工作区", 400)
  if (typeof requested !== "string" || !requested.trim()) throw httpError("缺少 path", 400)
  let root
  try {
    root = realpathSync(resolve(cwd.trim()))
  } catch (err) {
    throw mapFsError(err, "工作区不存在")
  }
  const candidate = isAbsolute(requested.trim()) ? resolve(requested.trim()) : resolve(root, requested.trim())
  if (candidate === root || !insideRoot(root, candidate)) {
    throw httpError("路径越出工作区", 403)
  }
  let real
  try {
    real = realpathSync(candidate)
  } catch (err) {
    throw mapFsError(err, "文件不存在")
  }
  const rel = relative(root, real)
  if (!rel || !insideRoot(root, real)) {
    throw httpError("路径越出工作区", 403)
  }
  let st
  try {
    st = statSync(real)
  } catch (err) {
    throw mapFsError(err, "文件不存在")
  }
  if (!st.isFile()) throw httpError("不是文件", 400)
  if (st.size > MAX_WORKSPACE_FILE_BYTES) throw httpError("文件过大", 413)
  return {
    abs: real,
    rel: rel.split("\\").join("/"),
    size: st.size,
    name: real.slice(real.lastIndexOf(sep) + 1),
  }
}

function buildWorkspaceFileEtag(st) {
  return `"${st.size}-${Math.trunc(st.mtimeMs)}"`
}

async function openWorkspaceFileAsync(cwd, requested) {
  if (typeof cwd !== "string" || !cwd.trim()) throw httpError("缺少工作区", 400)
  if (typeof requested !== "string" || !requested.trim()) throw httpError("缺少 path", 400)
  let root
  try {
    root = await realpath(resolve(cwd.trim()))
  } catch (err) {
    throw mapFsError(err, "工作区不存在")
  }
  const candidate = isAbsolute(requested.trim()) ? resolve(requested.trim()) : resolve(root, requested.trim())
  if (candidate === root || !insideRoot(root, candidate)) {
    throw httpError("路径越出工作区", 403)
  }
  let real
  try {
    real = await realpath(candidate)
  } catch (err) {
    throw mapFsError(err, "文件不存在")
  }
  const rel = relative(root, real)
  if (!rel || !insideRoot(root, real)) {
    throw httpError("路径越出工作区", 403)
  }
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  let fh
  try {
    fh = await open(real, openFlags)
  } catch (err) {
    if (err?.code === "ELOOP") throw httpError("路径越出工作区", 403)
    throw mapFsError(err, "文件不存在")
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw httpError("不是文件", 400)
    return {
      fh,
      st,
      abs: real,
      rel: rel.split("\\").join("/"),
      name: real.slice(real.lastIndexOf(sep) + 1),
    }
  } catch (err) {
    await fh.close().catch(() => {})
    throw err
  }
}

/** 异步解析并从同一打开句柄读取文件（消除 resolve→read 间的 TOCTOU 与大文件 OOM，不阻塞事件循环）。 */
export async function readWorkspaceFileAsync(cwd, requested) {
  const opened = await openWorkspaceFileAsync(cwd, requested)
  try {
    if (opened.st.size > MAX_WORKSPACE_FILE_BYTES) throw httpError("文件过大", 413)
    const chunks = []
    let total = 0
    const buf = Buffer.allocUnsafe(Math.min(Math.max(opened.st.size, 4096), 256 * 1024))
    for (;;) {
      const { bytesRead } = await opened.fh.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MAX_WORKSPACE_FILE_BYTES) throw httpError("文件过大", 413)
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)))
    }
    return {
      abs: opened.abs,
      rel: opened.rel,
      size: total,
      name: opened.name,
      body: Buffer.concat(chunks, total),
    }
  } finally {
    await opened.fh.close().catch(() => {})
  }
}

/** 读取工作区文件元信息与强/一致性 ETag，供 HEAD 与 Range 预检。 */
export async function statWorkspaceFileAsync(cwd, requested, maxFileBytes = MAX_RANGE_FILE_BYTES) {
  const opened = await openWorkspaceFileAsync(cwd, requested)
  try {
    if (opened.st.size > maxFileBytes) throw httpError("文件过大", 413)
    return {
      abs: opened.abs,
      rel: opened.rel,
      size: opened.st.size,
      mtimeMs: opened.st.mtimeMs,
      etag: buildWorkspaceFileEtag(opened.st),
      name: opened.name,
    }
  } finally {
    await opened.fh.close().catch(() => {})
  }
}

/** 解析单段 HTTP Byte Range（拒绝多段逗号 Range 与空文件越界）。 */
export function parseByteRangeHeader(rawHeader, totalSize) {
  if (typeof rawHeader !== "string" || !Number.isSafeInteger(totalSize) || totalSize < 0) return null
  const m = rawHeader.trim().match(/^bytes\s*=\s*(.+)$/i)
  if (!m) return null
  const spec = m[1].trim()
  if (!spec || spec.includes(",")) return null
  if (totalSize === 0) return null
  const bounds = spec.match(/^(\d*)-(\d*)$/)
  if (!bounds) return null
  const [, startStr, endStr] = bounds
  let start
  let end
  if (startStr !== "" && endStr !== "") {
    start = Number(startStr)
    end = Number(endStr)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= totalSize) return null
    end = Math.min(end, totalSize - 1)
  } else if (startStr !== "") {
    start = Number(startStr)
    if (!Number.isSafeInteger(start) || start >= totalSize) return null
    end = totalSize - 1
  } else if (endStr !== "") {
    const suffix = Number(endStr)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, totalSize - suffix)
    end = totalSize - 1
  } else {
    return null
  }
  return { start, end }
}

/** 按字节区间读取工作区文件分片（单次最多返回 maxChunkBytes，复用同一打开句柄防 TOCTOU）。 */
export async function readWorkspaceFileRangeAsync(
  cwd,
  requested,
  { start, end, maxFileBytes = MAX_RANGE_FILE_BYTES, maxChunkBytes = MAX_RANGE_CHUNK_BYTES } = {},
) {
  const opened = await openWorkspaceFileAsync(cwd, requested)
  try {
    const total = opened.st.size
    if (total > maxFileBytes) throw httpError("文件过大", 413)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) {
      const err = httpError("请求范围无效", 416)
      err.total = total
      throw err
    }
    const clampedEnd = Math.min(end, total - 1, start + maxChunkBytes - 1)
    const targetLen = clampedEnd - start + 1
    const buf = Buffer.allocUnsafe(targetLen)
    let offset = 0
    while (offset < targetLen) {
      const { bytesRead } = await opened.fh.read(buf, offset, targetLen - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset === 0) {
      const err = httpError("请求范围无效", 416)
      err.total = total
      throw err
    }
    const chunk = offset === targetLen ? buf : buf.subarray(0, offset)
    return {
      abs: opened.abs,
      rel: opened.rel,
      name: opened.name,
      size: total,
      mtimeMs: opened.st.mtimeMs,
      etag: buildWorkspaceFileEtag(opened.st),
      start,
      end: start + chunk.length - 1,
      chunk,
    }
  } finally {
    await opened.fh.close().catch(() => {})
  }
}

/**
 * 列出会话 cwd 沙箱内的一层目录（手机文件树按层懒加载）。
 * - requested 为空 / "." 即工作区根；越界（含经符号链接越界）403，不存在 404，不是目录 400。
 * - 条目：目录在前、同类按名称码元序；最多 MAX_WORKSPACE_DIR_ENTRIES 条，超出置 truncated。
 * - 符号链接：目标仍在工作区内时按目标类型给出并带 link: true；越界或断链为 type "symlink" + outside: true，不可进入。
 */
export function listWorkspaceDir(cwd, requested) {
  if (typeof cwd !== "string" || !cwd.trim()) throw httpError("缺少工作区", 400)
  let root
  try {
    root = realpathSync(resolve(cwd.trim()))
  } catch (err) {
    throw mapFsError(err, "工作区不存在")
  }
  const raw = typeof requested === "string" ? requested.trim() : ""
  const candidate = raw === "" || raw === "." ? root : (isAbsolute(raw) ? resolve(raw) : resolve(root, raw))
  if (!insideRoot(root, candidate)) throw httpError("路径越出工作区", 403)
  let real
  try {
    real = realpathSync(candidate)
  } catch (err) {
    throw mapFsError(err, "目录不存在")
  }
  if (!insideRoot(root, real)) throw httpError("路径越出工作区", 403)
  let rootStat
  try {
    rootStat = statSync(real)
  } catch (err) {
    throw mapFsError(err, "目录不存在")
  }
  if (!rootStat.isDirectory()) throw httpError("不是目录", 400)

  const dirents = readdirSync(real, { withFileTypes: true })
  const dirs = []
  const nonDirs = []
  for (const d of dirents) {
    const abs = resolve(real, d.name)
    if (d.isDirectory()) {
      dirs.push({ name: d.name, type: "dir" })
      continue
    }
    if (d.isSymbolicLink()) {
      let target = null
      try { target = realpathSync(abs) } catch { target = null }
      if (!target || !insideRoot(root, target)) {
        nonDirs.push({ name: d.name, type: "symlink", outside: true })
        continue
      }
      try {
        const st = statSync(target)
        const described = { name: d.name, link: true, ...describeStat(st) }
        if (described.type === "dir") dirs.push(described)
        else nonDirs.push(described)
      } catch {
        nonDirs.push({ name: d.name, type: "other" })
      }
      continue
    }
    nonDirs.push({ name: d.name, _dirent: d, _abs: abs })
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  dirs.sort(byName)
  nonDirs.sort(byName)
  const total = dirs.length + nonDirs.length
  const kept = []
  for (const d of dirs) {
    if (kept.length >= MAX_WORKSPACE_DIR_ENTRIES) break
    kept.push(d)
  }
  for (const item of nonDirs) {
    if (kept.length >= MAX_WORKSPACE_DIR_ENTRIES) break
    if (!item._abs) {
      kept.push(item)
      continue
    }
    try {
      kept.push({ name: item.name, ...describeStat(lstatSync(item._abs)) })
    } catch {
      kept.push({ name: item.name, type: "other" })
    }
  }
  const rel = relative(root, real).split("\\").join("/")
  return {
    path: rel,
    total,
    truncated: total > MAX_WORKSPACE_DIR_ENTRIES,
    entries: kept,
  }
}

/** 异步目录列表：避免大目录同步 stat 阻塞事件循环，并先按目录/名称排序截断后再对保留的文件执行 lstat。 */
export async function listWorkspaceDirAsync(cwd, requested) {
  if (typeof cwd !== "string" || !cwd.trim()) throw httpError("缺少工作区", 400)
  let root
  try {
    root = await realpath(resolve(cwd.trim()))
  } catch (err) {
    throw mapFsError(err, "工作区不存在")
  }
  const raw = typeof requested === "string" ? requested.trim() : ""
  const candidate = raw === "" || raw === "." ? root : (isAbsolute(raw) ? resolve(raw) : resolve(root, raw))
  if (!insideRoot(root, candidate)) throw httpError("路径越出工作区", 403)
  let real
  try {
    real = await realpath(candidate)
  } catch (err) {
    throw mapFsError(err, "目录不存在")
  }
  if (!insideRoot(root, real)) throw httpError("路径越出工作区", 403)
  let rootStat
  try {
    rootStat = await stat(real)
  } catch (err) {
    throw mapFsError(err, "目录不存在")
  }
  if (!rootStat.isDirectory()) throw httpError("不是目录", 400)

  const dirents = await readdir(real, { withFileTypes: true })
  const dirs = []
  const nonDirs = []
  const symlinks = []
  for (const d of dirents) {
    if (d.isDirectory()) dirs.push({ name: d.name, type: "dir" })
    else if (d.isSymbolicLink()) symlinks.push(d)
    else nonDirs.push({ name: d.name, _abs: resolve(real, d.name) })
  }
  if (symlinks.length > 0) {
    let cursor = 0
    const worker = async () => {
      while (cursor < symlinks.length) {
        const d = symlinks[cursor++]
        const abs = resolve(real, d.name)
        let target = null
        try { target = await realpath(abs) } catch { target = null }
        if (!target || !insideRoot(root, target)) {
          nonDirs.push({ name: d.name, type: "symlink", outside: true })
          continue
        }
        try {
          const st = await stat(target)
          const described = { name: d.name, link: true, ...describeStat(st) }
          if (described.type === "dir") dirs.push(described)
          else nonDirs.push(described)
        } catch {
          nonDirs.push({ name: d.name, type: "other" })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, symlinks.length) }, () => worker()))
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  dirs.sort(byName)
  nonDirs.sort(byName)
  const total = dirs.length + nonDirs.length
  const keptDirs = dirs.slice(0, MAX_WORKSPACE_DIR_ENTRIES)
  const remain = MAX_WORKSPACE_DIR_ENTRIES - keptDirs.length
  const keptNonDirs = nonDirs.slice(0, Math.max(0, remain))
  if (keptNonDirs.length > 0) {
    let cursor = 0
    const worker = async () => {
      while (cursor < keptNonDirs.length) {
        const idx = cursor++
        const item = keptNonDirs[idx]
        if (!item._abs) continue
        try {
          keptNonDirs[idx] = { name: item.name, ...describeStat(await lstat(item._abs)) }
        } catch {
          keptNonDirs[idx] = { name: item.name, type: "other" }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, keptNonDirs.length) }, () => worker()))
  }
  const rel = relative(root, real).split("\\").join("/")
  return {
    path: rel,
    total,
    truncated: total > MAX_WORKSPACE_DIR_ENTRIES,
    entries: [...keptDirs, ...keptNonDirs],
  }
}

function describeStat(st) {
  if (st.isDirectory()) return { type: "dir" }
  if (st.isFile()) return { type: "file", size: st.size, mtimeMs: Math.trunc(st.mtimeMs) }
  return { type: "other" }
}

const MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  // Office 文档交给手机上的查看器时不认 application/octet-stream：按 OOXML / ODF / 老格式给准确类型。
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  zip: "application/zip",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
}

export function mimeFromName(name) {
  const ext = String(name ?? "").split(".").pop()?.toLowerCase()
  if (!ext || !Object.prototype.hasOwnProperty.call(MIME_TYPES, ext)) return "application/octet-stream"
  return MIME_TYPES[ext]
}
