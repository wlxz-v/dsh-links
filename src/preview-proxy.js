/**
 * 开发服务器预览代理。
 *
 * 只拨 127.0.0.1。端口必须先在回环面板批准。手机 API 不能批准。
 * 不记录路径、查询串和正文，只给批准记录加访问计数。
 */
import { request as httpRequest } from "node:http"
import { randomBytes } from "node:crypto"

export const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000
export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024
export const PREVIEW_MAX_REQUEST_BYTES = 16 * 1024 * 1024
export const PREVIEW_IDLE_MS = 60_000
export const PREVIEW_BLACKLIST = Object.freeze([22, 3306, 5432, 6379, 11211, 27017, 9200])
const EXTRA_BLOCKED_PORTS = [
  25, 135, 139, 445, 587, 2375, 2376, 2379, 3389, 5900, 5984, 6443, 9222, 9229, 10250, 15672,
]

const BLACKLIST = new Set([...PREVIEW_BLACKLIST, ...EXTRA_BLOCKED_PORTS])
const WS_UPGRADE_RESPONSE_HEADERS = new Set([
  "upgrade",
  "connection",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
])
const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "authorization",
  "cookie",
  "set-cookie",
  "x-dsh-link-token",
  "referer",
  "referrer",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "host",
])

export function previewPortProblem(port, { pluginPort, hostPort } = {}) {
  const n = typeof port === "number" ? port : Number(String(port ?? "").trim())
  const read = (value) => (typeof value === "function" ? value() : value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return "端口无效"
  if (BLACKLIST.has(n)) return "这个端口不能预览"
  // pluginPort 可能是 getter：端口顺延后真实端口变了，仍要挡住预览到它自己。
  if (pluginPort != null && n === Number(read(pluginPort))) return "不能预览插件自己的端口"
  if (hostPort != null && n === Number(read(hostPort))) return "不能预览 Host 自己的端口"
  return null
}

export function previewLabelProblem(label) {
  if (typeof label !== "string") return "请填写名称"
  const text = label.trim()
  if (!text) return "请填写名称"
  if (text.length > 80) return "名称太长"
  if (/[\u0000-\u001f]/.test(text)) return "名称无效"
  return null
}

/** 拨号用。主机名不是 127.0.0.1 就失败，避免请求头把代理带到别的地址。 */
export function previewLookup(hostname, options, callback) {
  const cb = typeof options === "function" ? options : callback
  const opts = typeof options === "function" ? {} : (options ?? {})
  if (hostname !== "127.0.0.1") {
    const err = new Error("preview dial is loopback only")
    err.code = "ENOTLOOPBACK"
    cb(err)
    return
  }
  if (opts.all) cb(null, [{ address: "127.0.0.1", family: 4 }])
  else cb(null, "127.0.0.1", 4)
}

export function matchPreviewPath(url) {
  const raw = String(url ?? "")
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null
  let parsed
  try {
    parsed = new URL(raw || "/", "http://127.0.0.1")
  } catch {
    return null
  }
  const match = /^\/dsh-link\/mobile\/preview\/([^/]+)(\/.*)?$/.exec(parsed.pathname)
  if (!match) return null
  let previewId = match[1]
  try {
    previewId = decodeURIComponent(previewId)
  } catch {
    return null
  }
  if (!/^[a-f0-9]{24}$/.test(previewId)) return null
  const rest = match[2] && match[2].startsWith("/") ? match[2] : "/"
  return { previewId, path: rest + parsed.search }
}

function headerList(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function headerLookup(headers, lowerName) {
  if (!headers || typeof headers !== "object") return undefined
  if (Object.prototype.hasOwnProperty.call(headers, lowerName)) return headers[lowerName]
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerName) return v
  }
  return undefined
}

export function stripHopByHop(headers) {
  const named = new Set()
  for (const value of headerList(headerLookup(headers, "connection"))) {
    for (const part of String(value).split(",")) {
      const name = part.trim().toLowerCase()
      if (name) named.add(name)
    }
  }
  const out = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase()
    if (DROP_HEADERS.has(lower) || named.has(lower)) continue
    out[lower] = value
  }
  return out
}

export function forwardPreviewHeaders(headers, port, { websocket = false } = {}) {
  const out = stripHopByHop(headers)
  out.host = `localhost:${port}`
  if (headerLookup(headers, "origin")) out.origin = `http://localhost:${port}`
  if (!websocket) return out
  out.connection = "Upgrade"
  out.upgrade = "websocket"
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const val = headerLookup(headers, name)
    if (val != null) out[name] = val
  }
  return out
}

function createRegistry() {
  const byPreview = new Map()
  const byDevice = new Map()
  return {
    register(previewId, abortFn, deviceId = null) {
      let pSet = byPreview.get(previewId)
      if (!pSet) {
        pSet = new Set()
        byPreview.set(previewId, pSet)
      }
      pSet.add(abortFn)
      let dSet = null
      if (deviceId) {
        dSet = byDevice.get(deviceId)
        if (!dSet) {
          dSet = new Set()
          byDevice.set(deviceId, dSet)
        }
        dSet.add(abortFn)
      }
      let removed = false
      return () => {
        if (removed) return
        removed = true
        pSet.delete(abortFn)
        if (pSet.size === 0) byPreview.delete(previewId)
        if (dSet) {
          dSet.delete(abortFn)
          if (dSet.size === 0) byDevice.delete(deviceId)
        }
      }
    },
    disconnect(previewId) {
      const set = byPreview.get(previewId)
      if (!set) return
      for (const abortFn of [...set]) {
        try { abortFn() } catch {}
      }
      byPreview.delete(previewId)
    },
    disconnectDevice(deviceId) {
      const set = byDevice.get(deviceId)
      if (!set) return
      for (const abortFn of [...set]) {
        try { abortFn() } catch {}
      }
      byDevice.delete(deviceId)
    },
    stop() {
      for (const id of [...byPreview.keys()]) this.disconnect(id)
      byDevice.clear()
    },
  }
}

function publicPreview(item) {
  return {
    previewId: item.previewId,
    label: item.label,
    port: item.port,
    expiresAt: item.expiresAt,
  }
}

function panelPreview(item) {
  return { ...publicPreview(item), hits: item.hits ?? 0 }
}

export function rejectUpgrade(socket, code, message) {
  const body = JSON.stringify({ error: message })
  const reason = code === 401 ? "Unauthorized" : code === 403 ? "Forbidden" : code === 404 ? "Not Found" : "Error"
  const payload = `HTTP/1.1 ${code} ${reason}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
  try {
    socket.end(payload)
  } catch {
    try { socket.destroy() } catch {}
    return
  }
  const timer = setTimeout(() => {
    try { socket.destroy() } catch {}
  }, 1_000)
  timer.unref?.()
  socket.once?.("close", () => clearTimeout(timer))
}

function writeJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  })
  res.end(body)
}

/**
 * @param {{ state: object, save: () => void, pluginPort: number, hostPort: number, logger?: { info?: Function }, now?: () => number, idleMs?: number, maxBytes?: number, requestImpl?: Function }} options
 */
export function createPreviewService(options) {
  const {
    state,
    save,
    pluginPort,
    hostPort,
    logger,
    now = () => Date.now(),
    idleMs = PREVIEW_IDLE_MS,
    maxBytes = PREVIEW_MAX_BYTES,
    requestImpl = httpRequest,
  } = options
  if (!Array.isArray(state.previews)) state.previews = []
  const registry = createRegistry()
  const guards = { pluginPort, hostPort }

  function sweep(at = now()) {
    const expired = []
    const next = []
    for (const item of state.previews) {
      if (item && Number(item.expiresAt) > at) next.push(item)
      else if (item?.previewId) expired.push(item.previewId)
    }
    const changed = next.length !== state.previews.length
    state.previews = next
    for (const id of expired) registry.disconnect(id)
    if (changed) save()
  }

  function find(previewId, at = now()) {
    sweep(at)
    return state.previews.find((item) => item.previewId === previewId) ?? null
  }

  function refusePort(port) {
    return previewPortProblem(port, guards)
  }

  function armExpiry(item, onExpire) {
    const remain = Number(item.expiresAt) - now()
    const timer = setTimeout(() => {
      try { onExpire() } catch {}
    }, Math.max(0, remain))
    timer.unref?.()
    return () => clearTimeout(timer)
  }

  function openUpstream(item, method, path, headers) {
    return requestImpl({
      host: "127.0.0.1",
      port: item.port,
      family: 4,
      lookup: previewLookup,
      method,
      path,
      headers,
      agent: false,
      timeout: idleMs,
    })
  }

  return {
    listPublic() {
      sweep()
      return state.previews.map(publicPreview)
    },
    listPanel() {
      sweep()
      return state.previews.map(panelPreview)
    },
    approve({ port, label }) {
      const portError = refusePort(port)
      if (portError) return { status: 400, body: { error: portError } }
      const labelError = previewLabelProblem(label)
      if (labelError) return { status: 400, body: { error: labelError } }
      const n = Number(port)
      const text = label.trim()
      sweep()
      const at = now()
      let item = state.previews.find((row) => row.port === n)
      if (!item) {
        item = {
          previewId: randomBytes(12).toString("hex"),
          port: n,
          label: text,
          approvedAt: at,
          expiresAt: at + PREVIEW_TTL_MS,
          hits: 0,
        }
        state.previews.push(item)
      } else {
        item.label = text
        item.approvedAt = at
        item.expiresAt = at + PREVIEW_TTL_MS
      }
      save()
      logger?.info?.(`dsh-links: preview approve port=${n}`)
      return { status: 200, body: { ok: true, preview: panelPreview(item) } }
    },
    revoke(previewId) {
      const id = String(previewId ?? "").trim()
      const index = state.previews.findIndex((item) => item.previewId === id)
      if (index < 0) return { status: 404, body: { error: "预览不存在" } }
      const [item] = state.previews.splice(index, 1)
      registry.disconnect(id)
      save()
      logger?.info?.(`dsh-links: preview revoke port=${item.port}`)
      return { status: 200, body: { ok: true } }
    },
    handleHttp(req, res, deviceId = null) {
      if (req.method === "CONNECT") {
        writeJson(res, 405, { error: "method not allowed" })
        return true
      }
      const matched = matchPreviewPath(req.url)
      if (!matched) return false
      const item = find(matched.previewId)
      if (!item) {
        writeJson(res, 404, { error: "预览不存在或已过期" })
        return true
      }
      const blocked = refusePort(item.port)
      if (blocked) {
        writeJson(res, 403, { error: blocked })
        return true
      }
      const reqContentLen = Number(headerLookup(req.headers, "content-length"))
      if (Number.isFinite(reqContentLen) && reqContentLen > PREVIEW_MAX_REQUEST_BYTES) {
        writeJson(res, 413, { error: "请求体过大" })
        return true
      }
      item.hits = (item.hits ?? 0) + 1
      const headers = forwardPreviewHeaders(req.headers, item.port)
      const upstream = openUpstream(item, req.method, matched.path, headers)
      let upRes = null
      let sent = 0
      let uploaded = 0
      let finished = false
      let unregister = () => {}
      let clearExpiry = () => {}
      const cleanup = () => {
        clearExpiry()
        unregister()
        res.off?.("close", onResClose)
        res.off?.("finish", onResFinish)
      }
      const closeUpstream = () => {
        if (finished) return
        finished = true
        cleanup()
        try { upRes?.destroy() } catch {}
        try { upstream.destroy() } catch {}
      }
      const abortRequest = () => {
        closeUpstream()
        if (!res.writableEnded) {
          try { res.destroy() } catch {}
        }
      }
      const onResFinish = () => cleanup()
      const onResClose = () => {
        if (!res.writableEnded) closeUpstream()
        else cleanup()
      }
      unregister = registry.register(item.previewId, abortRequest, deviceId)
      clearExpiry = armExpiry(item, abortRequest)
      res.once?.("finish", onResFinish)
      res.once?.("close", onResClose)
      const fail = (code, error) => {
        if (finished) return
        finished = true
        cleanup()
        try { upRes?.destroy() } catch {}
        try { upstream.destroy() } catch {}
        if (!res.headersSent) writeJson(res, code, { error })
        else if (!res.writableEnded) {
          try { res.end() } catch {}
        }
      }
      upstream.on("timeout", () => fail(504, "预览空闲超时"))
      upstream.on("error", () => fail(502, "预览端口没有响应"))
      upstream.on("response", (up) => {
        if (finished) {
          try { up.destroy() } catch {}
          return
        }
        upRes = up
        const out = stripHopByHop(up.headers)
        const rawLen = out["content-length"]
        if (rawLen != null) {
          const declared = Number(rawLen)
          if (!Number.isInteger(declared) || declared < 0 || declared > maxBytes) delete out["content-length"]
        }
        if (!res.headersSent) res.writeHead(up.statusCode ?? 502, out)
        up.on("data", (chunk) => {
          if (finished || res.writableEnded) return
          const room = maxBytes - sent
          if (room <= 0) {
            closeUpstream()
            if (!res.writableEnded) res.end()
            return
          }
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
          sent += slice.length
          const ok = res.write(slice)
          if (sent >= maxBytes) {
            closeUpstream()
            if (!res.writableEnded) res.end()
            return
          }
          if (ok === false) {
            up.pause()
            res.once("drain", () => {
              if (!finished && !res.writableEnded) up.resume()
            })
          }
        })
        up.on("end", () => {
          closeUpstream()
          if (!res.writableEnded) res.end()
        })
        up.on("error", () => fail(502, "预览端口没有响应"))
      })
      req.on("data", (chunk) => {
        if (finished) return
        uploaded += chunk.length
        if (uploaded > PREVIEW_MAX_REQUEST_BYTES) {
          req.unpipe?.(upstream)
          fail(413, "请求体过大")
        }
      })
      req.on("aborted", () => closeUpstream())
      req.on("error", () => closeUpstream())
      req.pipe(upstream)
      return true
    },
    handleUpgrade(req, socket, head, deviceId = null) {
      const matched = matchPreviewPath(req.url)
      if (!matched) {
        rejectUpgrade(socket, 404, "not found")
        return
      }
      const item = find(matched.previewId)
      if (!item) {
        rejectUpgrade(socket, 404, "not found")
        return
      }
      if (refusePort(item.port)) {
        rejectUpgrade(socket, 403, "forbidden")
        return
      }
      item.hits = (item.hits ?? 0) + 1
      const headers = forwardPreviewHeaders(req.headers, item.port, { websocket: true })
      const upstream = openUpstream(item, "GET", matched.path, headers)
      let upgraded = false
      let upSock = null
      let unregister = () => {}
      let clearExpiry = () => {}
      const cleanup = () => {
        clearExpiry()
        unregister()
      }
      const teardown = () => {
        cleanup()
        try { socket.destroy() } catch {}
        try { upSock?.destroy() } catch {}
        try { upstream.destroy() } catch {}
      }
      unregister = registry.register(item.previewId, teardown, deviceId)
      clearExpiry = armExpiry(item, teardown)
      const fail = () => {
        if (upgraded) return
        cleanup()
        if (!socket.destroyed) rejectUpgrade(socket, 502, "bad gateway")
        try { upstream.destroy() } catch {}
      }
      upstream.on("error", fail)
      upstream.on("timeout", fail)
      upstream.on("response", (up) => {
        up.resume()
        fail()
      })
      upstream.on("upgrade", (upRes, upSocket, upHead) => {
        if (socket.destroyed) {
          try { upSocket.destroy() } catch {}
          cleanup()
          return
        }
        if (upRes.statusCode !== 101) {
          try { upSocket.destroy() } catch {}
          fail()
          return
        }
        upgraded = true
        upSock = upSocket
        upstream.removeListener("error", fail)
        upstream.removeListener("timeout", fail)
        const lines = ["HTTP/1.1 101 Switching Protocols"]
        for (const [key, value] of Object.entries(upRes.headers ?? {})) {
          const lower = key.toLowerCase()
          if (!WS_UPGRADE_RESPONSE_HEADERS.has(lower)) continue
          for (const piece of headerList(value)) {
            const text = String(piece)
            if (/[\r\n\0]/.test(text)) continue
            lines.push(`${lower}: ${text}`)
          }
        }
        try {
          socket.write(`${lines.join("\r\n")}\r\n\r\n`)
          if (upHead?.length) socket.write(upHead)
          if (head?.length) upSocket.write(head)
        } catch {
          teardown()
          return
        }
        socket.setTimeout(idleMs, teardown)
        upSocket.setTimeout(idleMs, teardown)
        upSocket.pipe(socket)
        socket.pipe(upSocket)
        socket.once("close", teardown)
        upSocket.once("close", teardown)
        socket.on("error", teardown)
        upSocket.on("error", teardown)
      })
      upstream.end()
    },
    disconnectDevice(deviceId) {
      registry.disconnectDevice(deviceId)
    },
    stop() {
      registry.stop()
    },
  }
}
