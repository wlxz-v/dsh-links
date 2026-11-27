/**
 * HTTP JSON 响应编码（zstd/br/gzip）、弱 ETag / 304 条件响应与回环同源守卫。
 */
import { createHash } from "node:crypto"
import { brotliCompressSync, constants as zlibConstants, gzipSync, zstdCompressSync } from "node:zlib"

const JSON_COMPRESS_MIN_BYTES = 1024
// 服务端优先顺序：zstd（最快、压缩率好）> br（浏览器最爱）> gzip（App/老客户端）。
const JSON_ENCODING_ORDER = ["zstd", "br", "gzip"]

/** 解析 Accept-Encoding，返回 coding → q 的映射（同名取第一个出现的 q）。 */
function parseAcceptEncoding(value) {
  const out = new Map()
  const raw = String(value ?? "").trim()
  if (!raw) return out
  const parts = raw.split(",")
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim().toLowerCase()
    if (!part) continue
    const semi = part.indexOf(";")
    if (semi === -1) {
      if (!out.has(part)) out.set(part, 1)
      continue
    }
    const name = part.slice(0, semi).trim()
    if (!name) continue
    let q = 1
    const params = part.slice(semi + 1).split(";")
    for (let j = 0; j < params.length; j++) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(params[j])
      if (match) q = Number(match[1])
    }
    if (!out.has(name)) out.set(name, q)
  }
  return out
}

/**
 * JSON 响应用哪种编码：>=1KB 才压（小于这个体积压缩后反而更大，且含 token 的配对响应
 * 都远小于 1KB）；按 q 值在服务端支持的 coding 里挑一个，全被 q=0 拒掉就返回 null。
 * 导出给测试用：协商逻辑单独可测，不必起服务器。
 */
export function negotiateJsonEncoding(acceptEncoding, bodyLength) {
  if (!(bodyLength >= JSON_COMPRESS_MIN_BYTES)) return null
  const accepted = parseAcceptEncoding(acceptEncoding)
  if (accepted.size === 0) return null
  const supported = JSON_ENCODING_ORDER.filter((coding) => {
    if (coding === "zstd" && typeof zstdCompressSync !== "function") return false
    return true
  })
  let bestCoding = null
  let bestQ = 0
  for (const coding of supported) {
    const q = accepted.has(coding) ? accepted.get(coding) : accepted.get("*")
    if (!Number.isFinite(q) || q <= 0) continue
    if (q > bestQ) {
      bestQ = q
      bestCoding = coding
    }
  }
  return bestCoding
}

function compressJson(body, coding) {
  if (coding === "zstd") return zstdCompressSync(body, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } })
  if (coding === "br") return brotliCompressSync(body, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  })
  if (coding === "gzip") return gzipSync(body, { level: 6 })
  return body
}

/**
 * 弱 ETag：按「协商编码名 + 原始 JSON 字节」算。
 * 同一进程内 compressJson(body, coding) 对固定 (body, coding) 确定性一致，
 * 因此先按明文算 ETag 即可保证不同编码表示的 ETag 互不相同，
 * 且在命中 304 时完全省掉主线程同步 gzip/br/zstd 压缩。
 */
export function jsonEtag(coding, body) {
  const hash = createHash("sha1")
    .update(String(coding ?? "identity"))
    .update("\u0000")
    .update(body)
    .digest("base64url")
    .slice(0, 22)
  return `W/"${hash}"`
}

/** If-None-Match 用弱比较（RFC 9110 §13.1.2）：`W/` 前缀忽略，逗号分隔，`*` 都算命中。 */
export function ifNoneMatchHit(header, etag) {
  const raw = String(header ?? "").trim()
  if (!raw || !etag) return false
  if (raw === "*") return true
  const want = String(etag).replace(/^W\//, "")
  return raw.split(",").some((part) => part.trim().replace(/^W\//, "") === want)
}

export function headerVal(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return typeof value === "string" ? value : undefined
}

export function json(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), "utf8")
  const coding = negotiateJsonEncoding(headerVal(res.req?.headers, "accept-encoding") ?? "", body.length)
  const method = res.req?.method
  const isSafeMethod = !method || method === "GET" || method === "HEAD"
  const cacheControl = String(extraHeaders?.["cache-control"] ?? extraHeaders?.["Cache-Control"] ?? "").toLowerCase()
  const etag = isSafeMethod && code === 200 && body.length > 0 && !cacheControl.includes("no-store")
    ? jsonEtag(coding, body)
    : null
  const baseHeaders = {
    "content-type": "application/json; charset=utf-8",
    // 不再发 connection: close：远程每条连接都是一次 WSS + 会合 + 内层 TLS，
    // 必须让 App 的连接池复用（RFC §4.2）。空闲上限见 createHttpsServer 之后的 keepAliveTimeout。
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    // 响应体随 Accept-Encoding 变化，Vary 必须一直在（否则中间缓存会把 gzip 体发给不支持的人）。
    vary: "accept-encoding",
    ...(etag ? { etag } : {}),
  }
  if (etag && ifNoneMatchHit(headerVal(res.req?.headers, "if-none-match"), etag)) {
    // 304 命中直接返回，不执行同步压缩，也不带 content-length / content-encoding。
    res.writeHead(304, { ...baseHeaders, ...extraHeaders })
    res.end()
    return
  }
  const encoded = coding ? compressJson(body, coding) : body
  const headers = {
    ...baseHeaders,
    "content-length": String(encoded.length),
    ...(coding ? { "content-encoding": coding } : {}),
    ...extraHeaders,
  }
  res.writeHead(code, headers)
  res.end(method === "HEAD" ? undefined : encoded)
}

export const ADMIN_NO_STORE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  vary: "accept-encoding, origin, sec-fetch-site",
})

export function isLoopbackHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

/**
 * 对齐 dsh-client-connection isTrustedApiRequest（trustedHosts 为空，只认回环）。
 * Host/Origin 之外必须校验 TCP 对端地址，防止伪造 Host: 127.0.0.1 绕过围栏。
 */
export function isLoopbackAddress(addr) {
  if (!addr) return false
  const a = String(addr).replace(/^::ffff:/i, "").toLowerCase()
  return a === "127.0.0.1" || a === "::1" || a === "localhost"
}

/** 安全解码 URI 路径段，非法百分号编码返回 null 而不是抛 URIError。 */
export function safeDecodeUriComponent(raw) {
  try {
    return decodeURIComponent(String(raw ?? ""))
  } catch {
    return null
  }
}

function hasDuplicateHeader(rawHeaders, name) {
  if (!Array.isArray(rawHeaders)) return false
  const target = name.toLowerCase()
  let count = 0
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i] ?? "").toLowerCase() === target) {
      count += 1
      if (count > 1) return true
    }
  }
  return false
}

export function requireLoopbackSameOrigin(req, res, { expectedPort } = {}) {
  const remote = req.socket?.remoteAddress ?? req.connection?.remoteAddress
  if (!isLoopbackAddress(remote)) {
    json(res, 403, { error: "forbidden" })
    return false
  }
  if (hasDuplicateHeader(req.rawHeaders, "host") || Array.isArray(req.headers?.host)) {
    json(res, 403, { error: "forbidden" })
    return false
  }
  const host = headerVal(req.headers, "host")
  if (!host || /\s/.test(host)) {
    json(res, 403, { error: "forbidden" })
    return false
  }
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    json(res, 403, { error: "forbidden" })
    return false
  }
  if (hostUrl.username || hostUrl.password || hostUrl.pathname !== "/" || !isLoopbackHostname(hostUrl.hostname)) {
    json(res, 403, { error: "forbidden" })
    return false
  }
  const targetPort = Number.isInteger(expectedPort) && expectedPort > 0
    ? expectedPort
    : (Number.isInteger(req.socket?.localPort) && req.socket.localPort > 0 ? req.socket.localPort : null)
  if (targetPort !== null) {
    const hostPort = hostUrl.port ? Number(hostUrl.port) : (req.socket?.encrypted ? 443 : 80)
    if (!Number.isInteger(hostPort) || hostPort !== targetPort) {
      json(res, 403, { error: "forbidden" })
      return false
    }
  }
  if (Array.isArray(req.headers?.["sec-fetch-site"])) {
    json(res, 403, { error: "forbidden" })
    return false
  }
  const fetchSite = headerVal(req.headers, "sec-fetch-site")
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    json(res, 403, { error: "forbidden" })
    return false
  }
  if (Array.isArray(req.headers?.origin)) {
    json(res, 403, { error: "forbidden" })
    return false
  }
  const origin = headerVal(req.headers, "origin")
  if (origin !== undefined) {
    try {
      const originUrl = new URL(origin)
      if ((originUrl.protocol !== "http:" && originUrl.protocol !== "https:") || originUrl.username || originUrl.password || originUrl.host !== hostUrl.host) {
        json(res, 403, { error: "forbidden" })
        return false
      }
    } catch {
      json(res, 403, { error: "forbidden" })
      return false
    }
  }
  return true
}

/** 状态变更请求：强制 JSON media type（触发 CORS 预检）+ 拒绝跨站 Origin。 */
export function requireJsonWrite(req, res) {
  const fetchSite = headerVal(req.headers, "sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    json(res, 403, { error: "forbidden" })
    return false
  }
  const origin = headerVal(req.headers, "origin")
  const host = headerVal(req.headers, "host")
  if (origin) {
    if (!host) {
      json(res, 403, { error: "forbidden" })
      return false
    }
    try {
      const expectedHost = new URL(`http://${host}`).host
      if (new URL(origin).host !== expectedHost) {
        json(res, 403, { error: "forbidden" })
        return false
      }
    } catch {
      json(res, 403, { error: "forbidden" })
      return false
    }
  }
  const ct = (headerVal(req.headers, "content-type") ?? "").toLowerCase()
  if (ct !== "application/json" && !ct.startsWith("application/json;")) {
    json(res, 415, { error: "content-type must be application/json" })
    return false
  }
  return true
}
