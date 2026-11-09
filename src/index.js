/**
 * dsh-links — 服务端面（host face）
 *
 * 一个插件完成"手机端使用 dsh"：
 *   1. 在主 web 服务上注册 /dsh-link/* 路由（仅回环同源），给网页界面提供二维码与配对管理；
 *   2. 在 0.0.0.0:<port> 起一个带 token 校验的手机 API（只服务 App：health / pair / mobile/*）；
 *   3. 配对采用一次性 6 位配对码（默认 10 分钟有效）。默认扫码即批准；
 *      开启「配对需本机确认」后，token 先发、API 要等面板点批准才放行。
 */
import { createAwaitingInput } from "./awaiting-input.js"
import { createServer as createHttpsServer } from "node:https"
import { createServer as createNetServer } from "node:net"
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir, hostname, networkInterfaces } from "node:os"
import { randomBytes } from "node:crypto"
import { brotliCompressSync, constants as zlibConstants, gzipSync, zstdCompressSync } from "node:zlib"
import z from "@deepseek-ai/schemastery"
import QRCode from "qrcode"

import { createPreviewService, rejectUpgrade, matchPreviewPath } from "./preview-proxy.js"
import { createPreviewDetector, publicDetections, refreshPreviewDetections, DETECT_HISTORY_MESSAGES } from "./preview-detect.js"
import { workspaceChangesService } from "./workspace-changes.js"
import { resolveSessionLogPath, sessionDirFor } from "./session-log-path.js"

import {
  consumePairingCode, ensurePairingCode, ensureTokenKey, findDeviceByToken, hmacDeviceToken, hydratePairing,
  persistablePairing, randomToken, readDeviceToken, revokeDevice, verifyPairingCode,
} from "./auth.js"
import { loadOrCreateTls } from "./tls.js"
import { assessForCursor, loadEventsAfter, sseBacklogExceeded, writeCatchup } from "./stream-cursor.js"
import { flushSeedQueue, startMuxQuestionBridge } from "./question-bridge.js"
import { bindLocalRpcRuntime, callLocalRpc, unbindLocalRpcRuntime } from "./local-rpc.js"
import { approveQueuedWorkspace, createWorkspaceApprovalQueue, rejectQueuedWorkspace } from "./workspace-approval.js"
import { validateSessionCreateWorkspace } from "./workspace-path.js"
import {
  DEVICE_MUTATION_REVOKED,
  DeviceMutationGate,
  runAuthorizedDeviceMutation,
} from "./device-mutation-gate.js"
import {
  PLUGIN_PROTOCOL,
  parseClientCaps,
  pluginCapabilities,
  subscribedDeviceIds,
} from "./protocol-caps.js"

import {
  APPROVAL_OFFLINE_GRACE_MS,
  APPROVAL_OUTCOMES,
  APPROVAL_TIMEOUT_MS,
  canDeviceHandle,
  createRequestRegistry,
  desktopApprovalDecided,
  mapApprovalUiStatus,
  requestBelongsToSession,
} from "./request-lifecycle.js"
import { createRemoteRuntime } from "./remote/runtime.js"
import { oneLine, toolCallDetail } from "./approval-detail.js"

import { applyMobileSessionSafety, handleMobileApi } from "./mobile-api.js"
import { hostDiagnosticsSource, runDiagnostics } from "./diagnostics.js"
import { deriveStoppedReason } from "./mobile-session-activity.js"
import { createHostEventHub, handleHostEvents } from "./host-events.js"

export const name = "dsh-links"
export const inject = ["webServer", "typertGateway"]

export const Config = z.object({
  /** 手机接入代理端口（0.0.0.0） */
  port: z.natural().min(1).max(65535).default(18640),
  /** 额外可访问地址（如 frp 公网地址），会一并写进二维码供手机按可达性选择 */
  extraUrls: z.array(z.string()).default([]),
  /** 配对自动批准（个人使用默认开启）。关闭后改为面板待确认，而不是直接拒绝配对。 */
  autoApprove: z.boolean().default(true),
  /** 配对码有效期（秒） */
  pairingTtlSeconds: z.natural().default(600),
  /** 状态目录（默认 ~/.dsh/dsh-links） */
  stateDir: z.string().default(""),
  /** 请求日志（排查用） */
  debug: z.boolean().default(false),
  /** SSE 事件轮询间隔（毫秒，最低 100），默认 1000 */
  eventPollIntervalMs: z.natural().min(100).default(1000),
  /** 重连补发最大历史条数（session.history maxMessages，按消息边界计数） */
  reconnectHistoryLimit: z.natural().default(50),
  /**
   * 是否允许手机把会话权限切换为 danger-full-access（手机端「完全访问」）。
   * 默认关闭：手机只能选 read-only / workspace-write；danger 请求被拒绝而不是降级。
   * 只在宿主配置显式开启时才放行。
   */
  allowMobileDangerFullAccess: z.boolean().default(false),
})

/** 手机 danger-full-access 是否被宿主显式放行（默认 false：拒绝而不是静默降级）。 */
function mobileDangerFullAccessAllowed(config) {
  return config?.allowMobileDangerFullAccess === true
}

/** App 实际会写的 settings.update 键路径（反查 AppSettingsStore / SettingsActivity）。未知 ns/键一律拒绝。 */
const SETTINGS_WRITE_ALLOWLIST = {
  "agent-presets": ["default"],
  permission: ["defaultPreset"],
  locale: ["preference"],
  "ui-theme": ["preference"],
  "ui-conversation": ["busyEnter"],
  "agent-default-model": ["provider", "model", "reasoningEffort"],
}

const DEFAULT_STATE_DIR = join(homedir(), ".dsh", "dsh-links")
const LEGACY_STATE_DIRS = [
  join(homedir(), ".dsh", "dsh-deepharness"),
  join(homedir(), ".dsh", "dshlinks"),
]

/** 一次性迁移：旧状态目录 → ~/.dsh/dsh-links，已配对设备免重扫。 */
function ensureStateDir(config) {
  const dir = config.stateDir?.trim() || DEFAULT_STATE_DIR
  if (!config.stateDir?.trim()) {
    const newState = join(dir, "state.json")
    if (!existsSync(newState)) {
      for (const legacyDir of LEGACY_STATE_DIRS) {
        const legacyState = join(legacyDir, "state.json")
        if (!existsSync(legacyState)) continue
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        try {
          cpSync(legacyDir, dir, { recursive: true })
        } catch {
          writeFileSync(newState, readFileSync(legacyState), { mode: 0o600 })
        }
        break
      }
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch {}
  return dir
}

function statePathOf(config) {
  return join(ensureStateDir(config), "state.json")
}

function loadState(file) {
  if (!existsSync(file)) return {}
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch (err) {
    throw new Error(`dsh-links: 无法读取 state.json: ${err?.message ?? err}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`dsh-links: state.json 已损坏，拒绝静默清空已配对设备 (${file})`)
  }
}

function saveState(file, state) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch {}
  const persist = {
    ...state,
    pairing: persistablePairing(state.pairing),
  }
  delete persist.pairingRate
  delete persist.pairingRates
  delete persist.pairingGlobal
  delete persist.pairingChallenge
  const data = JSON.stringify(persist, null, 2)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch {}
}

function now() {
  return Date.now()
}

/**
 * 设备是经哪条路配对的：`lan` / `remote`（DLP/1 远程首配）/ `relay`（DLR/1 时代的独立云端设备，
 * 该中继已下线，只剩标签供面板提示「旧远程配对」）。旧记录没有 via 时，用设备名里的云端后缀兜底。
 * 这是展示用的历史事实；远程能力看的是 remoteHandle，不是 via。
 */
function normalizeDeviceVia(device) {
  if (device?.via === "relay") return "relay"
  if (device?.via === "remote") return "remote"
  if (device?.via === "lan") return "lan"
  const name = String(device?.name ?? "")
  if (name.endsWith("·云") || name.includes(" · 云端")) return "relay"
  return "lan"
}

const REMOTE_PAIRED_FROM = "远程（经中继）"

function displayRemoteAddress(addr) {
  return String(addr ?? "").replace(/^::ffff:/i, "") || ""
}

export function publicDevice(device) {
  const pending = device.status === "pending"
  return {
    deviceId: device.deviceId,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    via: normalizeDeviceVia(device),
    // 只暴露「有没有远程能力」，不输出 remoteHandle（RFC §6.2）
    remote: Boolean(device.remoteHandle),
    status: pending ? "pending" : "active",
    // replace 配对（见 handlePair）进 pending 时告诉面板/手机：批准将吊销同名旧设备。
    replacing: pending && Array.isArray(device.replaces) && device.replaces.length > 0,
    pendingExpiresAt: pending ? (device.pendingExpiresAt ?? null) : null,
    pairedFrom: pending ? displayRemoteAddress(device.pairedFrom) : "",
  }
}

function pairRequireConfirm(config, state) {
  if (typeof state.pairRequireConfirm === "boolean") return state.pairRequireConfirm
  return config.autoApprove === false
}

function isDevicePending(device) {
  return device?.status === "pending"
}

function isPrivateV4Host(host) {
  if (host.startsWith("192.168.") || host.startsWith("10.")) return true
  const m = /^172\.(\d+)\./.exec(host)
  if (!m) return false
  const n = Number(m[1])
  return n >= 16 && n <= 31
}

/** 100.64.0.0/10，以及 Tailscale IPv6 `fd7a:115c:a1e0::/48`。 */
function isTailnetHost(host) {
  const raw = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (raw.startsWith("fd7a:115c:a1e0:")) return true
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(raw)
  if (!m) return false
  const second = Number(m[1])
  return second <= 255 && second >= 64 && second <= 127
}

/**
 * 探一个能监听的端口：从 start 起试 attempts 个，全被占用返回 null。
 * 用临时 net 服务器探测而不是在 https.Server 上反复 listen —— 失败的 listen 会留下
 * closing 状态的句柄，进程退出时踩 libuv 断言（uv_async.c 的 !(handle->flags & UV_HANDLE_CLOSING)）。
 */
export async function findFreeListenPort(start, attempts) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = start + offset
    if (candidate > 65535) return null
    const free = await new Promise((resolve) => {
      const probe = createNetServer()
      let settled = false
      const done = (value) => { if (!settled) { settled = true; resolve(value) } }
      probe.once("error", () => { probe.removeAllListeners(); done(false) })
      probe.listen(candidate, "0.0.0.0", () => probe.close(() => done(true)))
    })
    if (free) return candidate
  }
  return null
}

function listenExposure(config, infos, port = config.port) {
  const listen = { address: "0.0.0.0", port }
  const networks = (infos ?? [])
    .filter((item) => item?.label)
    .map((item) => ({ label: item.label, category: item.category, url: item.url }))
  const extras = (config.extraUrls ?? []).length > 0
  // tailnet 不是公网：只有 category "other" 才算不可信地址。
  const publicNets = networks.filter((n) => n.category === "other")
  if (publicNets.length || extras) {
    const warning = extras
      ? `已配置 extraUrls，${listen.address}:${listen.port} 可能经隧道或公网地址暴露。当前监听 ${listen.address}:${listen.port}。`
      : `检测到非私有网卡地址。当前监听 ${listen.address}:${listen.port}，请确认这些网段可信。`
    return { listen, networks, level: "untrusted", warning }
  }
  const labels = networks.map((n) => n.label).filter(Boolean)
  const hint = labels.length
    ? `当前监听 ${listen.address}:${listen.port}，局域网可达 ${labels.join("、")}。勿把 ${listen.port} 暴露到公网。`
    : `当前监听 ${listen.address}:${listen.port}。未发现可用局域网地址。`
  return { listen, networks, level: "lan", warning: null, hint }
}

/** extraUrls 只接受 https；http 一律升为 https。非法项丢弃。 */
function requireHttpsUrl(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`
  const https = withScheme.replace(/^http:\/\//i, "https://")
  try {
    const u = new URL(https)
    if (u.protocol !== "https:") return null
    return https
  } catch {
    return null
  }
}

export function classifyUrl(url) {
  try {
    const host = new URL(url).hostname
    if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") return "loopback"
    if (isTailnetHost(host)) return "tailnet"
    if (isPrivateV4Host(host)) return "private"
    return "other"
  } catch {
    return "unknown"
  }
}

/**
 * 手机永远连不上的 IPv4 网段：
 *   - 198.18.0.0/15 是基准测试网段（Clash TUN 等虚拟网卡常用），
 *   - 169.254.0.0/16 是链路本地地址（WiFi 没连上时系统自分配，手机不可达）。
 * 这类地址进二维码只会让 App 白探一次，还可能抢到「推荐」位。
 */
export function isUnreachableIPv4(address) {
  const parts = String(address ?? "").trim().split(".")
  if (parts.length !== 4) return false
  const [a, b, c, d] = parts.map(Number)
  if (![a, b, c, d].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 169 && b === 254) return true
  return false
}

/** 私网优先级：家用 192.168 最高，10 / 172.16-31 次之，其余（tailnet、公网）最低。 */
export function lanPreference(address) {
  const [a, b] = String(address ?? "").split(".").map(Number)
  if (a === 192 && b === 168) return 3
  if (a === 10) return 2
  if (a === 172 && b >= 16 && b <= 31) return 2
  return 1
}

/**
 * 把地址列表收成二维码用的 urls 和面板用的 infos。
 * 排序与推荐位都按「手机可达性」定：不可达网段直接丢掉（见 isUnreachableIPv4），
 * 优先级高的排前面，同一优先级保持系统枚举顺序；推荐的仍是第一个私网地址，
 * tailnet 留在列表里当第二候选，不抢推荐位。
 */
export function lanInfosForAddresses(addresses, port) {
  const candidates = (addresses ?? [])
    .filter((address) => address && !isUnreachableIPv4(address))
    .map((address, index) => ({ address: String(address), index }))
  // 稳定排序：只比优先级，同分按原始顺序，避免面板地址每次刷新都跳位。
  candidates.sort(
    (left, right) => lanPreference(right.address) - lanPreference(left.address) || left.index - right.index,
  )
  const urls = []
  const urlInfos = []
  const seen = new Set()
  for (const { address } of candidates) {
    const fullUrl = `https://${address}:${port}`
    if (seen.has(fullUrl)) continue
    seen.add(fullUrl)
    urls.push(fullUrl)
    urlInfos.push({ url: fullUrl, label: address, category: classifyUrl(fullUrl), isRecommended: false })
  }
  if (urlInfos.length > 0) {
    const firstPrivate = urlInfos.find((u) => u.category === "private") ?? urlInfos[0]
    firstPrivate.isRecommended = true
  }
  return { urls, infos: urlInfos }
}

function lanUrls(config, port = config.port) {
  const addresses = []
  let ifaces = {}
  try {
    ifaces = networkInterfaces() ?? {}
  } catch {
    ifaces = {}
  }
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface && iface.family === "IPv4" && !iface.internal) addresses.push(iface.address)
    }
  }
  const built = lanInfosForAddresses(addresses, port)
  for (const extra of config.extraUrls ?? []) {
    const httpsUrl = requireHttpsUrl(extra)
    if (!httpsUrl || built.urls.includes(httpsUrl)) continue
    built.urls.push(httpsUrl)
    built.infos.push({ url: httpsUrl, label: httpsUrl, category: "extra", isRecommended: false })
  }
  return built
}

/**
 * @param port 实际监听的端口。config.port 被占用而顺延时，这里与 config.port 不同，
 *   二维码与面板都必须用实际端口，否则手机会连一个没人听的端口。
 */
function pairInfo(config, state, certFingerprint, port = config.port) {
  const lan = lanUrls(config, port)
  const info = {
    v: 1,
    type: "dsh-link",
    deviceId: state.deviceId,
    name: hostname(),
    port,
    urls: lan.urls,
    infos: lan.infos,
    pairingCode: ensurePairingCode(state, config.pairingTtlSeconds),
    certFingerprint,
  }
  info.requireConfirm = pairRequireConfirm(config, state)
  info.exposure = listenExposure(config, lan.infos, port)
  // 时效戳（主机时钟，Unix 毫秒）：App 扫码后可判断码是否已过期/陈旧，
  // 把「旧截图、面板未刷新」这一类 401 消灭在提交之前。
  info.issuedAt = Date.now()
  info.expiresAt = state.pairing?.expiresAt ?? null
  return info
}

const JSON_COMPRESS_MIN_BYTES = 1024
// 服务端优先顺序：zstd（最快、压缩率好）> br（浏览器最爱）> gzip（App/老客户端）。
const JSON_ENCODING_ORDER = ["zstd", "br", "gzip"]

/** 解析 Accept-Encoding，返回 coding → q 的映射（同名取第一个出现的 q）。 */
function parseAcceptEncoding(value) {
  const out = new Map()
  for (const part of String(value ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";")
    if (!name) continue
    let q = 1
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param)
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
  for (const coding of supported) {
    const q = accepted.get(coding) ?? accepted.get("*")
    if (q === undefined || q <= 0) continue
    return coding
  }
  return null
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

export function json(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), "utf8")
  // S3/F3：大于 1KB 的 JSON 响应按 Accept-Encoding 压缩（会话列表约 113KB → gzip 约 15KB）。
  // 实测（node 24，zlib）：13.3KB 的会话列表样本 gzip 673B、br 423B、zstd 533B；
  // 真机上 App 现在才真正吃到压缩（见 apps/android 的 MobileApi.request() 去掉
  // 手写 identity 的改动），浏览器面板则可以用 br/zstd 再省一截。
  // SSE 与文件下载不走这里（见下方注释与 mobile-api 的文件流），保持不动。
  // 安全：这些响应里没有「攻击者可控输入 + 密钥」同时出现的情况，BREACH 类攻击不适用；
  // 含 token 的配对响应小于 1KB，不会被压缩。
  const coding = negotiateJsonEncoding(headerVal(res.req?.headers, "accept-encoding") ?? "", body.length)
  const encoded = coding ? compressJson(body, coding) : body
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(encoded.length),
    // 不再发 connection: close：远程每条连接都是一次 WSS + 会合 + 内层 TLS，
    // 必须让 App 的连接池复用（RFC §4.2）。空闲上限见 createHttpsServer 之后的 keepAliveTimeout。
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    // 响应体随 Accept-Encoding 变化，Vary 必须一直在（否则中间缓存会把 gzip 体发给不支持的人）。
    vary: "accept-encoding",
    ...(coding ? { "content-encoding": coding } : {}),
    ...extraHeaders,
  }
  res.writeHead(code, headers)
  res.end(encoded)
}

function headerVal(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return typeof value === "string" ? value : undefined
}

function isLoopbackHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "::1") return true
  const parts = host.split(".")
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 对齐 dsh-client-connection isTrustedApiRequest（trustedHosts 为空，只认回环）。
 * Host/Origin 之外必须校验 TCP 对端地址，防止伪造 Host: 127.0.0.1 绕过围栏。
 */
function isLoopbackAddress(addr) {
  if (!addr) return false
  const a = String(addr).replace(/^::ffff:/i, "").toLowerCase()
  return a === "127.0.0.1" || a === "::1" || a === "localhost"
}

function requireLoopbackSameOrigin(req, res) {
  const remote = req.socket?.remoteAddress ?? req.connection?.remoteAddress
  if (!isLoopbackAddress(remote)) {
    json(res, 403, { error: "forbidden" })
    return false
  }
  const host = headerVal(req.headers, "host")
  if (!host) {
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
  if (!isLoopbackHostname(hostUrl.hostname)) {
    json(res, 403, { error: "forbidden" })
    return false
  }
  if (headerVal(req.headers, "sec-fetch-site") === "cross-site") {
    json(res, 403, { error: "forbidden" })
    return false
  }
  const origin = headerVal(req.headers, "origin")
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) {
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
  if (headerVal(req.headers, "sec-fetch-site") === "cross-site") {
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
      if (new URL(origin).host !== host) {
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

/** 回环面板的 JSON POST。响应已写出时返回 null。 */
async function readLoopbackPost(req, res) {
  if (!requireLoopbackSameOrigin(req, res)) return null
  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" })
    return null
  }
  if (!requireJsonWrite(req, res)) return null
  return readJson(req, res)
}

/** 手机端 permission.defaultPreset 的安全取值；danger 需宿主显式开启。 */
const SAFE_PERMISSION_PRESETS = new Set(["read-only", "workspace-write"])

export function filterSettingsPatch(ns, patch, config) {
  const allowed = Object.prototype.hasOwnProperty.call(SETTINGS_WRITE_ALLOWLIST, ns)
    ? SETTINGS_WRITE_ALLOWLIST[ns]
    : undefined
  if (!allowed) return { error: "该设置命名空间不允许从手机端写入" }
  const keys = Object.keys(patch)
  if (keys.length === 0) return { error: "patch 为空" }
  const unknown = keys.filter((k) => !allowed.includes(k))
  if (unknown.length > 0) return { error: "包含不允许写入的键" }
  // 值校验：permission.defaultPreset 只接受安全预设；danger-full-access 需宿主开启配置。
  if (ns === "permission" && Object.prototype.hasOwnProperty.call(patch, "defaultPreset")) {
    const value = patch.defaultPreset
    if (typeof value !== "string" || !SAFE_PERMISSION_PRESETS.has(value)) {
      if (value === "danger-full-access" && !mobileDangerFullAccessAllowed(config)) {
        return { error: "danger-full-access 已被宿主禁用；请先在宿主开启 allowMobileDangerFullAccess" }
      }
      return { error: "defaultPreset 取值不允许" }
    }
  }
  return { ok: true }
}

export { validateSessionCreateWorkspace }

class HttpBodyError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const PROMPT_BODY_LIMIT = 16 * 1024 * 1024
const PROMPT_IMAGE_DATA_LIMIT = 4 * 1024 * 1024
const PROMPT_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (err) => {
      if (done) return
      done = true
      reject(err)
    }
    req.on("data", (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        fail(new HttpBodyError(413, "payload too large"))
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      if (done) return
      if (size === 0) return fail(new HttpBodyError(400, "empty body"))
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        fail(new HttpBodyError(400, "invalid json"))
      }
    })
    req.on("error", () => fail(new HttpBodyError(400, "invalid json")))
  })
}

async function readJson(req, res, limit) {
  try {
    return await readBody(req, limit)
  } catch (err) {
    json(res, err.status ?? 400, { error: err.message || "invalid body" })
    return null
  }
}

function authorize(req, state, stateFile) {
  const token = readDeviceToken(req.headers)
  if (!token) return null
  const { device, legacy } = findDeviceByToken(state, token)
  if (!device) return null
  if (legacy) {
    // 旧版裸 SHA-256 哈希命中：用原始 token 重算 HMAC 落盘，下次走新格式
    device.tokenHash = hmacDeviceToken(state, token)
    saveState(stateFile, state)
  }
  return device
}

function touchDevice(state, device, file) {
  if (now() - (device.lastSeenAt ?? 0) > 60_000) {
    device.lastSeenAt = now()
    saveState(file, state)
  }
}

/**
 * 二维码只编码客户端真正解析的字段。
 *
 * 面板用的 `exposure`（网卡告警文案）和 `infos`（地址标签）没有任何客户端读，
 * 但它们把载荷从 ~300 字符推到 800+，模块数从 69 涨到 113 —— 码密到手机扫不出来
 * （App 解成乱码后就报「不是 dsh 连接二维码」）。面板自己走 /dsh-link/pair-info
 * 拿完整对象，不受影响。
 */
export function qrPayload(info) {
  const out = {
    v: info.v,
    type: info.type,
    name: info.name,
    pairingCode: info.pairingCode,
    urls: info.urls,
    certFingerprint: info.certFingerprint,
  }
  // 远程已就绪时才有（RFC §5.2）；旧 App 不认识 remote 键，按 urls 走局域网配对
  if (info.remote) out.remote = info.remote
  if (info.requireConfirm !== undefined) out.requireConfirm = info.requireConfirm
  if (typeof info.issuedAt === "number") out.issuedAt = info.issuedAt
  if (typeof info.expiresAt === "number") out.expiresAt = info.expiresAt
  return out
}

/**
 * @param remote 二维码里的 remote（含 bootstrap 种子）或 null。只在这里出现：
 *   面板的 pair-info JSON 不带种子，种子只随二维码图片离开本机。
 */
async function qrPng(res, config, state, certFingerprint, remote, port = config.port) {
  try {
    // 720px：面板底托 CSS 尺寸见 src/panel.js 的 .dl-qr，点击放大后约 360 CSS px
    // （Retina 720 物理 px）—— 源码分辨率不低于两者，才不会被浏览器补糊。
    const info = pairInfo(config, state, certFingerprint, port)
    if (remote) info.remote = remote
    const payload = qrPayload(info)
    const buf = await QRCode.toBuffer(JSON.stringify(payload), { type: "png", margin: 2, width: 720 })
    // 二维码里带配对码与证书指纹：不能缓存，也不能让浏览器把它当别的类型渲染；
    // 与 json() 的敏感响应保持同一组头（参考 lrxG/dsh-app 的 no-store + no-referrer 约定）。
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    })
    res.end(buf)
  } catch (err) {
    console.error(`dsh-links: qr.png: ${err?.message ?? err}`)
    json(res, 500, { error: "failed to render qr" })
  }
}

const PAIR_REQUEST_CACHE_MAX = 256
const PAIR_REQUEST_CACHE_TTL_MS = 15 * 60 * 1000

function rememberPairRequest(rt, requestId, fingerprint, body) {
  if (!requestId) return
  const cache = rt.pairingRequests
  cache.set(requestId, { fingerprint, body, expiresAt: Date.now() + PAIR_REQUEST_CACHE_TTL_MS })
  while (cache.size > PAIR_REQUEST_CACHE_MAX) cache.delete(cache.keys().next().value)
}

function cachedPairRequest(rt, requestId, fingerprint) {
  if (!requestId) return null
  const cache = rt.pairingRequests
  const hit = cache.get(requestId)
  if (!hit) return null
  if (Date.now() >= hit.expiresAt) {
    cache.delete(requestId)
    return null
  }
  if (hit.fingerprint !== fingerprint) return { conflict: true }
  return hit.body
}

/**
 * 这条连接是不是 Agent 经中继接进来的（RFC §6.1）。
 * 只在对端是回环地址时查来源表：局域网手机的 remotePort 可能恰好撞上表里某个本地端口。
 * 授权从不依赖「对端是回环」本身，远程来源也要各自再过 token / 路径限制。
 */
function requestOrigin(rt, req) {
  const agent = rt.remote?.agent
  if (!agent) return null
  const socket = req.socket ?? req.connection
  if (!isLoopbackAddress(socket?.remoteAddress)) return null
  return agent.originOf(socket?.remotePort) ?? null
}

async function handlePair(req, res, config, state, stateFile, rt, logger, origin = null) {
  if (!requireJsonWrite(req, res)) return
  const body = await readJson(req, res)
  if (!body) return
  sweepExpiredPending(state, stateFile, rt)
  const code = String(body.code ?? "").trim()
  const deviceName = (String(body.deviceName ?? "手机").trim().slice(0, 32) || "手机")
  // 来源只看 Agent 的来源标签；请求体里的 via 是旧 App 的自报，不参与任何判断（RFC §6.1 第 3 条）
  const bootstrapOrigin = origin?.kind === "bootstrap" ? origin : null
  const via = bootstrapOrigin ? "remote" : "lan"
  const suppliedRequestId = String(body.requestId ?? "").trim()
  if (suppliedRequestId && !/^[A-Za-z0-9._:-]{8,128}$/.test(suppliedRequestId)) {
    return json(res, 400, { error: "requestId 无效" })
  }
  // App reuses this identifier when LAN fails after the request may have
  // reached the host. The fingerprint intentionally excludes the route: the
  // same logical pair may retry through the relay (RFC §6.3). Legacy clients
  // without the field deliberately do not enter the replay cache, preserving
  // one-time pairing semantics for older clients.
  const requestFingerprint = `${code}\n${deviceName}`
  const requestId = suppliedRequestId
  const cached = cachedPairRequest(rt, requestId, requestFingerprint)
  if (cached?.conflict) return json(res, 409, { error: "requestId 已用于另一配对请求" })
  if (cached) return json(res, 200, cached)
  // 局域网按对端 IP 隔离限流；远程首配没有真实 IP，按 bootstrapId 分桶（RFC §6.1 第 4 条），
  // 再叠加 per-challenge / global 预算兜底。
  const clientKey = bootstrapOrigin
    ? `remote::${bootstrapOrigin.bootstrapId}`
    : `lan::${String(req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? "unknown")}`
  const ver = verifyPairingCode(state, code, clientKey)
  if (!ver.ok) {
    // pairingRates 仅内存；勿写入 state.json
    const throttled = /频繁|失效|稍后再试/.test(ver.error ?? "")
    json(res, throttled ? 429 : 401, { error: ver.error })
    return
  }
  // 同名设备默认拒绝静默替换：结构化 409 告知冲突对象，由 App 显式带
  // replace: true 重发才进入替换流程（409 不消费配对码，同一张码可直接重试）。
  // 不做自动改名/自动顶替：持码者不该能在电脑端不知情时换掉现有设备。
  const replace = body.replace === true
  const sameName = (state.devices ?? []).filter((d) => d.name === deviceName)
  if (sameName.length && !replace) {
    const first = sameName[0]
    json(res, 409, {
      error: "已存在同名设备，请先吊销旧设备或更换名称",
      code: "SAME_NAME",
      existing: {
        deviceId: first.deviceId,
        name: first.name,
        status: isDevicePending(first) ? "pending" : "active",
      },
    })
    return
  }
  const token = randomToken(24)
  const deviceId = `dev-${randomToken(8)}`
  // 远程首配一律进本机确认，不受开关影响：截图里的码 5 分钟内全球可用（RFC §6.3）
  const requireConfirm = pairRequireConfirm(config, state) || Boolean(bootstrapOrigin)
  // 替换的落点由 requireConfirm 决定：无确认闸门时持码即等同授权，立即吊销
  // 同名旧设备；有闸门时旧设备保持在线、新设备进 pending，批准的那一刻才替换
  // （拒绝/超时不伤旧设备），替换动作始终被现有确认闸门覆盖。
  // 摘除与新设备写入全同步且共用末尾一次 saveState：verify→consume 临界区不被
  // await 打断（一张码原子配一台），崩溃时也不会留下“旧已删、新未入”的中间态。
  const replacedIds = []
  const replacedDevices = []
  if (sameName.length && replace && !requireConfirm) {
    for (const old of sameName) {
      old[DEVICE_REVOKING] = true
      replacedIds.push(old.deviceId)
      replacedDevices.push(old)
    }
    state.devices = (state.devices ?? []).filter((d) => !replacedIds.includes(d.deviceId))
    for (const old of replacedDevices) dropDevice(state, rt, old)
  }
  const device = {
    deviceId,
    name: deviceName,
    tokenHash: hmacDeviceToken(state, token),
    createdAt: now(),
    lastSeenAt: now(),
    via,
  }
  if (requireConfirm) {
    // token 仍发给 App（旧客户端可存），但 API 在面板批准前一律 403。
    device.status = "pending"
    device.pendingExpiresAt = Date.now() + config.pairingTtlSeconds * 1000
    device.pairedFrom = bootstrapOrigin
      ? REMOTE_PAIRED_FROM
      : displayRemoteAddress(req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? "")
    if (sameName.length && replace) device.replaces = sameName.map((d) => d.deviceId)
  }
  // pending 设备同样拿 handle：纯远程首配的手机要经 kind=device 等到批准结果（RFC §6.3）
  rt.remote?.issueForNewDevice(device)
  state.devices = state.devices ?? []
  state.devices.push(device)
  consumePairingCode(state) // 配对码一次性：成功后立即失效
  // 与配对码同一临界区消费 bootstrap：同一张码的远程首配也只成功一次
  if (bootstrapOrigin) rt.remote?.bootstrap.consume(Buffer.from(bootstrapOrigin.bootstrapId, "base64url"))
  saveState(stateFile, state)
  // 同 revokeDeviceEntry 的线性化边界：被替换设备的在途操作排空后才确认应答。
  for (const old of replacedDevices) await rt.deviceMutations.drain(old.deviceId)
  if (replacedIds.length) {
    logger?.info(
      `dsh-links: device replace device=${replacedIds.map((id) => String(id).slice(0, 8)).join(",")} new=${deviceId.slice(0, 8)}`,
    )
  }
  const remote = rt.remote?.deviceRemote(device) ?? null
  const result = {
    ok: true,
    token,
    deviceId,
    name: deviceName,
    urls: lanUrls(config, (rt.boundPort ?? (() => config.port))()).urls,
    pending: requireConfirm,
    pendingExpiresAt: requireConfirm ? device.pendingExpiresAt : undefined,
    ...(replacedIds.length ? { replacedDeviceIds: replacedIds } : {}),
    ...(device.replaces ? { replacing: true } : {}),
    ...(remote ? { remote } : {}),
  }
  rememberPairRequest(rt, requestId, requestFingerprint, result)
  json(res, 200, result)
}

/** 会话日志正文：`.zstd` 是逐帧追加的容器，必须逐帧解完；未压缩的 jsonl 直接读文本。 */

/**
 * 从会话存储文件（jsonl.zstd）读取 reasoning 块，按块首事件 seq 索引
 * （RPC 投影会剥掉父会话的思考内容，文件是补全源）。
 * 返回 Map<seq, { seq, time, text }>；连续 reasoning block-end 合并为一个
 * 块（与投影的事件侧分组规则一致），id 以首个 block-end 的 seq 为键。
 */

/**
 * 向本机 dsh /api 发 RPC 统一走 ./local-rpc.js 的 callLocalRpc：
 * 方法闭集在该模块的 RPC_METHOD_ALLOWLIST 锁定并有单测覆盖。
 */

// ---------- SSE 实时推送（/dsh-link/mobile/sessions/:id/stream） ----------
// 数据流：DSH 产生事件 → 写入 JSONL → 插件轮询 session.history RPC（增量 seq）→
// SSE emit → App 订阅 → Compose state 更新。轮询间隔可配，空闲会话用文件大小跳过 RPC。
const MAX_SSE_GLOBAL = 64
const MAX_SSE_PER_DEVICE = 8

function createRuntime(config) {
  const requests = createRequestRegistry()
  return {
    sessionStreams: new Map(),
    sessionFiles: new Map(),
    inflightPolls: new Set(),
    // 单飞期间又被要求补洞的会话：轮询结束后立刻再跑一次
    pendingPolls: new Set(),
    // sessionId → { at, timer }，给 mux 补洞请求限流
    gapPolls: new Map(),
    pendingApprovals: requests.pendingApprovals,
    pendingQuestions: requests.pendingQuestions,
    reasoningCache: new Map(),
    // sessionId+updatedAt → { activity } / { lastResult }：首页「当前步骤」「结果一句话」的推导缓存
    sessionActivityCache: new Map(),
    deviceRequests: new Map(),
    pairingRequests: new Map(),
    deviceMutations: new DeviceMutationGate(),
    workspaceApprovals: createWorkspaceApprovalQueue({
      ttlMs: (config?.pairingTtlSeconds ?? 600) * 1000,
    }),
    requests,
    // sessionId → 未结束的审批 / 澄清问题数（含交给电脑端的），首页「等待确认」用
    awaiting: createAwaitingInput(),
  }
}

/**
 * 双端审批：手机端此刻是否可能收到审批——任一会话有 SSE 订阅，或后台监视的主机事件流还在。
 * 只看「有没有」不看具体设备：审批的候选设备在 rec.eligibleDeviceIds 里另算。
 */
export function hasLiveMobileDevice(rt, hostSubscriberCount = 0) {
  if (Number(hostSubscriberCount) > 0) return true
  for (const writers of rt?.sessionStreams?.values() ?? []) {
    if ((writers?.size ?? 0) > 0) return true
  }
  return false
}

function sseCounts(rt) {
  let global = 0
  const perDevice = new Map()
  for (const writers of rt.sessionStreams.values()) {
    for (const conn of writers) {
      global++
      perDevice.set(conn.deviceId, (perDevice.get(conn.deviceId) ?? 0) + 1)
    }
  }
  return { global, perDevice }
}

function closeSseForDevice(rt, deviceId) {
  for (const [sessionId, writers] of [...rt.sessionStreams]) {
    for (const conn of [...writers]) {
      if (conn.deviceId !== deviceId) continue
      writers.delete(conn)
      try { conn.res.destroy() } catch {}
    }
    rt.requests.removeEligible(sessionId, deviceId)
    if (writers.size === 0) {
      const anyEligible = rt.requests.pendingForSession(sessionId).some((rec) => rec.eligibleDeviceIds.size > 0)
      dropSession(rt, sessionId, { immediate: !anyEligible })
    } else afterWritersChanged(rt, sessionId)
  }
}

function trackDeviceRequest(rt, deviceId, req, res) {
  let requests = rt.deviceRequests.get(deviceId)
  if (!requests) {
    requests = new Set()
    rt.deviceRequests.set(deviceId, requests)
  }
  const record = { req, res }
  requests.add(record)
  const done = () => {
    requests.delete(record)
    if (requests.size === 0) rt.deviceRequests.delete(deviceId)
  }
  req.once?.("aborted", done)
  res.once?.("finish", done)
  res.once?.("close", done)
  return done
}

function closeRequestsForDevice(rt, deviceId, exceptReq) {
  const requests = rt.deviceRequests.get(deviceId)
  if (!requests) return
  for (const record of [...requests]) {
    if (record.req === exceptReq) continue
    requests.delete(record)
    try { record.req.destroy() } catch {}
    try { record.res.destroy() } catch {}
  }
  if (requests.size === 0) rt.deviceRequests.delete(deviceId)
}

const DEVICE_REVOKING = Symbol("deviceRevoking")

export function isDeviceAuthorized(state, device) {
  if (!device?.deviceId) return false
  const current = (state.devices ?? []).find((item) => item === device || item.deviceId === device.deviceId)
  return Boolean(current && !current[DEVICE_REVOKING])
}

/** 设备是否对该会话存在活跃 SSE 订阅（审批只能由正在操作该会话的设备处理）。 */
export function isDeviceSubscribedToSession(rt, sessionId, deviceId) {
  const writers = rt.sessionStreams.get(sessionId)
  if (!writers || writers.size === 0) return false
  for (const conn of writers) {
    if (conn && conn.deviceId === deviceId) return true
  }
  return false
}

export async function readAuthorizedJson(req, res, state, device, limit) {
  const body = await readJson(req, res, limit)
  if (!body) return null
  if (!isDeviceAuthorized(state, device)) {
    if (!res.headersSent) json(res, 401, { error: "设备已被吊销" })
    return null
  }
  return body
}

export function runMobileDeviceMutation(rt, state, device, operation) {
  return runAuthorizedDeviceMutation(
    rt.deviceMutations,
    device.deviceId,
    () => isDeviceAuthorized(state, device),
    operation,
  )
}

export function mobileMutationWasRevoked(value) {
  return value === DEVICE_MUTATION_REVOKED
}

export function respondDeviceRevoked(res) {
  return json(res, 401, { error: "设备已被吊销" })
}

function afterWritersChanged(rt, sessionId, { immediate = false } = {}) {
  const writers = rt.sessionStreams.get(sessionId)
  if (writers && writers.size > 0) {
    rt.requests.clearGrace(sessionId)
    for (const conn of writers) rt.requests.addEligible(sessionId, conn.deviceId)
    return
  }
  const pending = rt.requests.pendingForSession(sessionId)
  const anyEligible = pending.some((rec) => rec.eligibleDeviceIds.size > 0)
  if (immediate || pending.length === 0 || !anyEligible) {
    rt.requests.settleSession(sessionId)
    return
  }
  rt.requests.scheduleGrace(sessionId, () => {
    const current = rt.sessionStreams.get(sessionId)
    if (current && current.size > 0) return
    rt.requests.settleSession(sessionId)
  })
}

function settleOrphanApprovals(rt) {
  for (const sessionId of new Set([
    ...[...rt.pendingApprovals.values()].map((rec) => rec.sessionId),
    ...[...rt.pendingQuestions.values()].map((rec) => rec.sessionId),
  ].filter(Boolean))) {
    afterWritersChanged(rt, sessionId)
  }
}

async function sessionFilePath(targetPort, sessionId, rt) {
  const cached = rt.sessionFiles.get(sessionId)
  if (cached?.missingUntil && Date.now() < cached.missingUntil) return null
  if (cached?.path) return cached.path
  try {
    const list = await callLocalRpc(targetPort, "session.list", {})
    const row = (list.items ?? []).find((s) => s.sessionId === sessionId)
    const cwd = row?.cwd
    if (!cwd) {
      rt.sessionFiles.set(sessionId, { missingUntil: Date.now() + 10_000 })
      return null
    }
    const p = resolveSessionLogPath(sessionDirFor(cwd, sessionId))
    if (!p) {
      rt.sessionFiles.set(sessionId, { missingUntil: Date.now() + 10_000 })
      return null
    }
    const prev = cached?.path
    rt.sessionFiles.set(sessionId, {
      path: p,
      lastSize: prev === p ? cached?.lastSize : undefined,
      lastMtime: prev === p ? cached?.lastMtime : undefined,
    })
    return p
  } catch {
    return null
  }
}

function dropSession(rt, sessionId, { immediate = false } = {}) {
  rt.sessionStreams.delete(sessionId)
  rt.sessionFiles.delete(sessionId)
  rt.pendingPolls.delete(sessionId)
  const gap = rt.gapPolls.get(sessionId)
  if (gap?.timer) clearTimeout(gap.timer)
  rt.gapPolls.delete(sessionId)
  afterWritersChanged(rt, sessionId, { immediate })
}

function writeSse(writers, frame) {
  for (const conn of [...writers]) {
    try {
      const ok = conn.res.write(frame)
      try { conn.res.flush?.() } catch {}
      if (ok === false && sseBacklogExceeded(conn.res)) {
        writers.delete(conn)
        try { conn.res.destroy() } catch {}
      }
    } catch {
      writers.delete(conn)
      try { conn.res.destroy() } catch {}
    }
  }
}

/** mux 补洞的最小间隔：正常只在订阅初期抖一下，限流是为了防住 seq 空洞补不平时的 RPC 打转。 */
const GAP_POLL_MIN_INTERVAL_MS = 200

/**
 * mux 发现 seq 空洞时请求一次强制轮询。首次立刻跑，其余排一个尾随定时器，
 * 保证「不打转」的同时也「不丢最后一次修复请求」。
 */
function requestGapPoll(sessionId, targetPort, rt) {
  const rec = rt.gapPolls.get(sessionId)
  if (rec?.timer) return
  const wait = Math.max(0, GAP_POLL_MIN_INTERVAL_MS - (Date.now() - (rec?.at ?? 0)))
  if (wait === 0) {
    rt.gapPolls.set(sessionId, { at: Date.now(), timer: null })
    pollSession(sessionId, targetPort, rt, true)
    return
  }
  const timer = setTimeout(() => {
    rt.gapPolls.set(sessionId, { at: Date.now(), timer: null })
    pollSession(sessionId, targetPort, rt, true)
  }, wait)
  timer.unref?.()
  rt.gapPolls.set(sessionId, { at: rec?.at ?? 0, timer })
}

/**
 * 拉取并补发落后事件。force=true 用于补洞：跳过"文件未变化"短路，
 * 因为 mux 推送的事件可能还没落盘，此时 size/mtime 与上次完全一致。
 */
async function pollSession(sessionId, targetPort, rt, force = false) {
  const writers = rt.sessionStreams.get(sessionId)
  if (!writers || writers.size === 0) return
  if (rt.inflightPolls.has(sessionId)) {
    if (force) rt.pendingPolls.add(sessionId)
    return
  }
  rt.inflightPolls.add(sessionId)
  try {
    const filePath = await sessionFilePath(targetPort, sessionId, rt)
    if (!filePath && !force) return
    let st = null
    if (filePath) {
      try {
        st = statSync(filePath)
      } catch {
        if (!force) return
      }
    }
    const info = rt.sessionFiles.get(sessionId)
    if (!force && info && st && info.lastSize === st.size && info.lastMtime === st.mtimeMs) return
    const minCursor = Math.min(...[...writers].map((c) => c.lastSeq))
    const batch = await loadEventsAfter(minCursor, (payload) =>
      callLocalRpc(targetPort, "session.history", { sessionId, ...payload }),
    )
    for (const conn of [...writers]) {
      writeCatchup(writers, conn, assessForCursor(conn.lastSeq, batch), sessionId, (id) => requestGapPoll(id, targetPort, rt))
    }
    if (info && st) {
      info.lastSize = st.size
      info.lastMtime = st.mtimeMs
    }
  } catch {
    // RPC 失败/会话消失：静默跳过，下个周期重试
  } finally {
    rt.inflightPolls.delete(sessionId)
    if (rt.pendingPolls.delete(sessionId)) {
      pollSession(sessionId, targetPort, rt, true)
    }
  }
}

async function handleStreamRoute(sessionId, res, targetPort, config, req, rt, device) {
  try {
    const list = await callLocalRpc(targetPort, "session.list", {})
    if (!(list.items ?? []).some((s) => s.sessionId === sessionId)) {
      return json(res, 404, { error: "session not found" })
    }
  } catch {
    return json(res, 502, { error: "session lookup failed" })
  }
  const counts = sseCounts(rt)
  if (counts.global >= MAX_SSE_GLOBAL || (counts.perDevice.get(device.deviceId) ?? 0) >= MAX_SSE_PER_DEVICE) {
    return json(res, 429, { error: "too many streams" })
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.flushHeaders?.()
  try { res.socket?.setNoDelay?.(true) } catch {}
  let writers = rt.sessionStreams.get(sessionId)
  if (!writers) {
    writers = new Set()
    rt.sessionStreams.set(sessionId, writers)
  }
  const afterRaw = Number(new URL(req?.url ?? "/", "http://x").searchParams.get("afterSeq") ?? 0)
  const caps = parseClientCaps(new URL(req?.url ?? "/", "http://x").searchParams.get("caps"))
  const conn = {
    res,
    lastSeq: Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0,
    deviceId: device.deviceId,
    // 补历史完成前不接受 mux 直推，避免与补发交错乱序
    seeded: false,
    missedWhileSeeding: false,
    seedQueue: [],
    seedOverflow: false,
    caps,
    lastResyncAt: 0,
  }
  writers.add(conn)
  rt.requests.addEligible(sessionId, device.deviceId)
  rt.requests.clearGrace(sessionId)
  res.write(`event: ready\ndata: ${JSON.stringify({
    resumeSeq: conn.lastSeq,
    protocol: PLUGIN_PROTOCOL,
    capabilities: pluginCapabilities({ changes: Boolean(workspaceChangesService(rt.workspaceChanges)) }),
  })}\n\n`)
  try { res.flush?.() } catch {}
  ;(async () => {
    try {
      const batch = await loadEventsAfter(conn.lastSeq, (payload) =>
        callLocalRpc(targetPort, "session.history", {
          sessionId,
          ...payload,
          maxMessages: payload.maxMessages ?? config.reconnectHistoryLimit,
        }),
      )
      writeCatchup(writers, conn, assessForCursor(conn.lastSeq, batch), sessionId, (id) => requestGapPoll(id, targetPort, rt))
    } catch {} finally {
      conn.seeded = true
      flushSeedQueue(conn, sessionId, (id) => requestGapPoll(id, targetPort, rt))
      // 补历史期间 mux 到的事件没人接，立刻补一次洞
      if (conn.missedWhileSeeding) pollSession(sessionId, targetPort, rt, true)
    }
  })()
  res.on("close", () => {
    const set = rt.sessionStreams.get(sessionId)
    set?.delete(conn)
    if (set && set.size === 0) dropSession(rt, sessionId)
    else afterWritersChanged(rt, sessionId)
  })
}

function dropDevice(state, rt, device, exceptReq) {
  revokeDevice(null, device.deviceId)
  closeSseForDevice(rt, device.deviceId)
  closeRequestsForDevice(rt, device.deviceId, exceptReq)
  rt.workspaceApprovals.dropDevice(device.deviceId)
  // 远程流一并关掉（RFC §6.5）：设备记录已删，新 client_open 会得到 UNKNOWN_KEY
  rt.remote?.agent?.dropDevice(device.deviceId)
}

export async function revokeDeviceEntry(state, stateFile, rt, { name, deviceId }, exceptReq) {
  const targetName = String(name ?? "").trim()
  const targetId = String(deviceId ?? "").trim()
  if (!targetName && !targetId) return { status: 400, body: { error: "缺少设备名或 deviceId" } }
  const target = (state.devices ?? []).find((d) => d.name === targetName || d.deviceId === targetId)
  if (!target) return { status: 404, body: { error: "设备不存在" } }
  if (target[DEVICE_REVOKING]) return { status: 409, body: { error: "设备正在吊销" } }
  target[DEVICE_REVOKING] = true
  state.devices = (state.devices ?? []).filter((d) => d.deviceId !== target.deviceId)
  dropDevice(state, rt, target, exceptReq)
  // Linearization boundary: operations already registered finish before this
  // revocation is acknowledged; removal above prevents any new operation.
  await rt.deviceMutations.drain(target.deviceId)
  saveState(stateFile, state)
  return { status: 200, body: { ok: true, removed: 1, deviceId: target.deviceId } }
}

async function revokeAllDevices(state, stateFile, rt) {
  const devices = [...(state.devices ?? [])]
  for (const device of devices) device[DEVICE_REVOKING] = true
  state.devices = []
  for (const device of devices) dropDevice(state, rt, device)
  // As with single-device revocation, success means all earlier registered
  // mutations are settled and no later mutation can be admitted.
  await Promise.all(devices.map((device) => rt.deviceMutations.drain(device.deviceId)))
  saveState(stateFile, state)
  return { status: 200, body: { ok: true, removed: devices.length } }
}

function sweepExpiredPending(state, stateFile, rt) {
  const nowMs = Date.now()
  const kept = []
  const expired = []
  for (const device of state.devices ?? []) {
    if (isDevicePending(device) && nowMs >= (device.pendingExpiresAt ?? 0)) expired.push(device)
    else kept.push(device)
  }
  if (!expired.length) return
  state.devices = kept
  for (const device of expired) dropDevice(state, rt, device)
  saveState(stateFile, state)
}

async function activatePendingDevice(state, stateFile, rt, deviceId) {
  const id = String(deviceId ?? "").trim()
  if (!id) return { status: 400, body: { error: "缺少 deviceId" } }
  const target = (state.devices ?? []).find((d) => d.deviceId === id)
  if (!target) return { status: 404, body: { error: "设备不存在" } }
  if (!isDevicePending(target)) return { status: 409, body: { error: "设备无需确认" } }
  if (Date.now() >= (target.pendingExpiresAt ?? 0)) {
    return { status: 404, body: { error: "待确认已过期，请重新配对" } }
  }
  // 批准即执行替换：摘除旧设备、放行新设备、单次落盘全同步（并发重复批准
  // 会同步命中「设备无需确认」409），之后排空旧设备在途操作才确认应答。
  // 拒绝或 pending 超时走 drop/revoke，不触碰 replaces 列表，旧设备原样保留。
  const replacedIds = []
  for (const oldId of target.replaces ?? []) {
    if (oldId === target.deviceId) continue
    const old = (state.devices ?? []).find((d) => d.deviceId === oldId)
    if (!old || old[DEVICE_REVOKING]) continue
    old[DEVICE_REVOKING] = true
    state.devices = (state.devices ?? []).filter((d) => d.deviceId !== oldId)
    dropDevice(state, rt, old)
    replacedIds.push(oldId)
  }
  delete target.status
  delete target.pendingExpiresAt
  delete target.pairedFrom
  delete target.replaces
  saveState(stateFile, state)
  for (const oldId of replacedIds) await rt.deviceMutations.drain(oldId)
  return {
    status: 200,
    body: {
      ok: true,
      deviceId: target.deviceId,
      name: target.name,
      ...(replacedIds.length ? { replacedDeviceIds: replacedIds } : {}),
    },
  }
}

/**
 * Return the session list together with the Web workspace archive set.
 * DSH keeps archived logs in session.list so they can be restored; the mobile
 * client needs the set in the same bootstrap response to filter before select.
 */

const PANEL_ONLY_PATHS = new Set([
  "/dsh-link/pair-info",
  "/dsh-link/qr.png",
  "/dsh-link/revoke",
  "/dsh-link/revoke-all",
  "/dsh-link/pair-approve",
  "/dsh-link/pair-settings",
  "/dsh-link/devices",
  "/dsh-link/remote-status",
  "/dsh-link/remote-enable",
  "/dsh-link/remote-disable",
  "/dsh-link/remote-test",
  "/dsh-link/remote-reset-identity",
  "/dsh-link/workspace-approvals",
  "/dsh-link/workspace-approve",
  "/dsh-link/workspace-reject",
  "/dsh-link/diagnostics",
  "/dsh-link/previews",
  "/dsh-link/previews/revoke",
])

function sessionEvents(session) {
  if (typeof session?.snapshotEvents === "function") {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {}
  }
  return Array.isArray(session?.events) ? session.events : []
}

function findApprovalId(req) {
  const events = sessionEvents(req?.agent?.session)
  const decided = new Set()
  // 无 callId 的 waterfall 请求（如沙箱升级审批）没有可关联字段，
  // 回退绑定最近一条未决 approval/asked：它就是本次请求对应的卡。
  let latestUndecidedWithCallId = null
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === "approval/decided") decided.add(event.data?.id)
    else if (event?.type === "approval/asked") {
      if (decided.has(event.data?.id)) continue
      if ((req.callId ?? null) !== (event.data?.callId ?? null)) {
        if ((req.callId ?? null) === null && latestUndecidedWithCallId === null && event.data?.callId != null) {
          latestUndecidedWithCallId = event.data.id
        }
        continue
      }
      return event.data.id
    }
  }
  if ((req.callId ?? null) === null && latestUndecidedWithCallId) return latestUndecidedWithCallId
  return req?.id ?? req?.approvalId ?? req?.payload?.id ?? null
}

export function apply(ctx, config) {
  const rt = createRuntime(config)
  // 端口顺延：config.port（默认 18640）被占用时按 +1 试到 +8，实际监听端口记在 portState。
  // 二维码、面板、插件端口守卫都读 boundPort()——必须是「实际」端口，否则手机会连到没人听的端口。
  const PORT_LISTEN_ATTEMPTS = 8
  const portState = { value: config.port, shifted: false }
  const boundPort = () => portState.value
  // 模块级的 handlePair() 不在这个作用域里，靠 rt 拿到「实际」端口（配对响应里的 urls 必须带它）。
  rt.boundPort = boundPort
  // 可选服务：旧 Host 没有 workspaceChanges，不能进 inject（会阻止插件加载），按请求取。
  rt.workspaceChanges = () => ctx.get("workspaceChanges")
  const web = ctx.get("webServer")
  const gateway = ctx.get("typertGateway") ?? ctx.typertGateway
  // 0.2.x 网关要求每次调用都携带 Peer（prepareInvocation → assertPeerLive(request.peer)）；
  // 缺 peer 时 in-process RPC 全部 TypeError，host.rpc 检查即报 HOST_RPC_FAILED。
  // 诊断埋点：把 peer 建立结果暴露给 /dsh-link/diagnostics（detail 只收布尔/短枚举）。
  const gatewayPeerState = { connection: false, createPeer: false, peer: false, aborted: false, error: "", recreated: 0, transport: "" }
  let gatewayPeer = null
  const dropGatewayPeer = () => {
    const dead = gatewayPeer
    gatewayPeer = null
    if (!dead) return
    try { Promise.resolve(dead.dispose?.()).catch(() => {}) } catch {}
  }
  const ensureGatewayPeer = () => {
    // peer 是长连接身份：宿主热重载 / 会话 dispose 后旧 peer 会被 abort。
    // 只看「有没有」会一直拿着一个 aborted 的 peer，所有 RPC 都变成 gateway/peer-disposed，
    // 只能重启客户端才能恢复——所以每次取用时顺手检查并重建。
    if (gatewayPeer) {
      if (!gatewayPeer.signal?.aborted) return gatewayPeer
      gatewayPeerState.aborted = true
      dropGatewayPeer()
    }
    try {
      // 注意：apply() 期间 connection 服务可能尚未 active（ctx.get 对非 active 的 provider 返回 undefined），
      // 所以首次调用失败是正常的——必须在每次请求时惰性重试，不能只在 apply() 里建一次。
      const connection = ctx.get("connection")
      gatewayPeerState.connection = Boolean(connection)
      gatewayPeerState.createPeer = typeof connection?.createPeer === "function"
      if (gatewayPeerState.createPeer) {
        gatewayPeer = connection.createPeer({ principal: { kind: "owner" } })
        gatewayPeerState.peer = Boolean(gatewayPeer)
        gatewayPeerState.aborted = Boolean(gatewayPeer?.signal?.aborted)
        gatewayPeerState.error = ""
      } else {
        gatewayPeerState.error = connection ? "no-createPeer" : "no-connection"
      }
    } catch (err) {
      gatewayPeerState.error = "create-failed"
      try { ctx.logger.warn(`dsh-links: createPeer failed: ${String(err?.message ?? err)}`) } catch {}
    }
    return gatewayPeer
  }
  if (gateway && typeof gateway.invoke === "function") {
    // connection 是按需取的可选服务（不进 inject）：旧 Host 没有它时退化为不带 peer 的旧行为。
    ensureGatewayPeer()
    const withPeer = (request) => {
      const peer = ensureGatewayPeer()
      return peer ? { ...request, peer } : request
    }
    const isPeerDisposed = (error) => {
      const code = typeof error?.code === "string" ? error.code : ""
      return code === "gateway/peer-disposed" || /peer[- ]disposed/i.test(String(error?.message ?? ""))
    }
    // peer 在调用途中被 dispose（宿主重启某个 provider）时，重建一次再重试；只重试一次。
    const withPeerRetry = async (call) => {
      try {
        return await call()
      } catch (error) {
        if (!isPeerDisposed(error) || !gatewayPeer) throw error
        dropGatewayPeer()
        gatewayPeerState.recreated += 1
        try { ctx.logger.warn("dsh-links: gateway peer 已失效，重建后重试一次") } catch {}
        return await call()
      }
    }
    bindLocalRpcRuntime({
      // transport 只用于诊断：确认手机 API 走的是进程内 gateway（有 peer），
      // 还是退化后的 HTTP /api（无 peer，需要浏览器会话，通常直接 401）。
      invoke: (request) => {
        gatewayPeerState.transport = "gateway"
        return withPeerRetry(() => gateway.invoke(withPeer(request)))
      },
      stream: typeof gateway.stream === "function" ? (request) => {
        gatewayPeerState.transport = "gateway"
        return withPeerRetry(() => gateway.stream(withPeer(request)))
      } : undefined,
    })
  }
  const targetPort = web.port
  const stateFile = statePathOf(config)
  const state = loadState(stateFile)
  hydratePairing(state)
  if (!state.deviceId) state.deviceId = `dsh-${randomBytes(8).toString("hex")}`
  if (!state.devices) state.devices = []
  if (!state.pairing) state.pairing = {}
  ensureTokenKey(state)
  const tlsHolder = { fingerprint: "", cert: "" }
  // 旧版设备（无 deviceId）一次性迁移：自动补发，手机无需重新配对（token 不变）
  let migrated = false
  for (const d of state.devices) {
    if (!d.deviceId) {
      d.deviceId = `dev-${randomToken(8)}`
      migrated = true
    }
    const via = normalizeDeviceVia(d)
    if (d.via !== via) {
      d.via = via
      migrated = true
    }
  }
  // DLR/1 中继（Control + 8443/8444）已整体下线：遗留的路由密钥与接入凭据不再有用，
  // 留着只是多一份落盘秘密。设备记录不动（旧云端设备在面板上标「旧远程配对」，由用户决定吊销）。
  if (state.relay) {
    delete state.relay
    ctx.logger.info("dsh-links: 旧版中继（DLR/1）已下线，已清除遗留接入配置")
  }
  saveState(stateFile, state)
  sweepExpiredPending(state, stateFile, rt)
  if (migrated) ctx.logger.info("dsh-links: 已为旧设备补发 deviceId")

  const fp = () => tlsHolder.fingerprint
  // 启动就绪状态：TLS 异步加载/生成完成且 HTTPS 端口真正 listen 之后才允许
  // pair-info / qr.png 返回可扫码内容，避免冷启动窗口吐出 certFingerprint 为空的
  // 配对信息。未就绪返回面板与冒烟脚本可识别的 503；失败后保持不可用，不假就绪。
  const readiness = { phase: "starting", error: "" }
  const proxyPending = (res) =>
    json(res, 503, { error: "proxy_not_ready", phase: readiness.phase }, { "retry-after": "1" })
  // ---------- 远程连接（DLP/1）：Agent 只向外连中继，验证过手机才接本机端口 ----------
  const remote = createRemoteRuntime({
    state,
    save: () => saveState(stateFile, state),
    pluginPort: boundPort,
    isLocalReady: () => readiness.phase === "ready",
    isRevoking: (device) => Boolean(device[DEVICE_REVOKING]),
    currentPairing: () => ({
      code: ensurePairingCode(state, config.pairingTtlSeconds),
      expiresAt: state.pairing?.expiresAt,
    }),
    logger: ctx.logger,
  })
  rt.remote = remote
  const previews = createPreviewService({
    state,
    save: () => saveState(stateFile, state),
    pluginPort: boundPort,
    hostPort: targetPort,
    logger: ctx.logger,
  })
  rt.previewDetect = createPreviewDetector({
    pluginPort: boundPort,
    hostPort: targetPort,
  })
  async function currentDetections() {
    const rows = await refreshPreviewDetections({
      detector: rt.previewDetect,
      listSessions: async () => {
        const [sessions, workspace] = await Promise.all([
          callLocalRpc(targetPort, "session.list", {}),
          callLocalRpc(targetPort, "workspace.list", {}),
        ])
        return {
          items: sessions?.items ?? [],
          archivedSessionIds: workspace?.archivedSessionIds ?? [],
        }
      },
      history: (sessionId) => callLocalRpc(targetPort, "session.history", {
        sessionId,
        maxMessages: DETECT_HISTORY_MESSAGES,
      }),
    })
    return publicDetections(rows, previews.listPublic().map((item) => item.port))
  }

  // 诊断只读：workspace.list 已在白名单里。证书 PEM 留在 tlsHolder，不进入返回值。
  function diagnosticsSource(device) {
    // 诊断读的是 gatewayPeerState 快照；启动早期 connection 服务还没 active，
    // 快照会长期停在 peerError:"no-connection"，让面板看起来像网关坏了。
    // 这里先重试一次（惰性、无副作用），保证 detail 反映「现在」而不是 apply 那一刻。
    try {
      ensureGatewayPeer()
    } catch {}
    let sessions = false
    try {
      const service = ctx.get("sessions")
      sessions = Boolean(service && typeof service.get === "function")
    } catch {
      sessions = false
    }
    let listenHosts = []
    try {
      for (const list of Object.values(networkInterfaces() ?? {})) {
        for (const iface of list ?? []) {
          if (iface?.address) listenHosts.push(iface.address)
        }
      }
    } catch {
      listenHosts = null
    }
    const view = remote.status()
    return hostDiagnosticsSource({
      rpc: (method, params) => callLocalRpc(targetPort, method, params ?? {}),
      services: {
        workspaceChanges: Boolean(workspaceChangesService(rt.workspaceChanges)),
        typertGateway: Boolean(gateway && typeof gateway.invoke === "function"),
        sessions,
        peerDebug: { ...gatewayPeerState },
      },
      certPem: tlsHolder.cert,
      fingerprint: tlsHolder.fingerprint,
      devices: state.devices,
      device,
      listenHosts,
      // 双端审批排障：手机端到底连着没有。hostEvents 是后台事件流的订阅者数，
      // sessions 是正在看某个会话的手机数量（只报会话 id 前缀，不泄露内容）。
      streams: {
        hostEvents: hostEvents.subscriberCount,
        sessions: [...rt.sessionStreams.entries()]
          .map(([id, writers]) => ({ id: String(id), viewers: writers?.size ?? 0 }))
          .filter((item) => item.viewers > 0)
          .slice(0, 8),
      },
      remote: {
        enabled: Boolean(view.enabled),
        state: view.state,
        error: view.error,
        replaced: Boolean(view.replaced),
      },
    })
  }

  const mobileApiDeps = {
    json,
    requireJsonWrite,
    readAuthorizedJson,
    validateSessionCreateWorkspace,
    runMobileDeviceMutation,
    mobileMutationWasRevoked,
    respondDeviceRevoked,
    isDeviceAuthorized,
    isDeviceSubscribedToSession,
    revokeDeviceEntry,
    filterSettingsPatch,
    publicDevice,
    remoteForDevice: remote.forDevice,
    diagnosticsSource: (device) => diagnosticsSource(device),
    applyNewSessionSafety: async (sessionId) => {
      const sessions = ctx.get("sessions")
      const session = typeof sessions?.get === "function" ? await sessions.get(sessionId) : undefined
      applyMobileSessionSafety(session)
    },
  }

  const disposers = [
    web.register({
      kind: "exact",
      path: "/dsh-link/pair-info",
      handler: (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (readiness.phase !== "ready") return proxyPending(res)
        sweepExpiredPending(state, stateFile, rt)
        // 面板只需要远程的状态与地址（决定码下方的文案）；bootstrap 种子只随二维码图片出去
        const view = remote.status()
        json(res, 200, { ...pairInfo(config, state, fp(), boundPort()), remoteStatus: { state: view.state, host: view.host } })
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/qr.png",
      handler: (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (readiness.phase !== "ready") return proxyPending(res)
        return qrPng(res, config, state, fp(), remote.qrPayload(), boundPort())
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/revoke",
      handler: async (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (!requireJsonWrite(req, res)) return
        const body = await readJson(req, res)
  if (!body) return
        const targetName = String(body.name ?? "").trim()
        const targetId = String(body.deviceId ?? "").trim()
        if (!targetName && !targetId) return json(res, 400, { error: "缺少设备名或 deviceId" })
        const result = await revokeDeviceEntry(state, stateFile, rt, { name: targetName, deviceId: targetId })
        if (result.status === 200) {
          ctx.logger.info(`dsh-links: device revoke device=${String(result.body?.deviceId ?? targetId).slice(0, 8)}`)
        }
        json(res, result.status, result.body)
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/revoke-all",
      handler: async (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (!requireJsonWrite(req, res)) return
        const body = await readJson(req, res)
        if (!body) return
        const result = await revokeAllDevices(state, stateFile, rt)
        if (result.status === 200) {
          ctx.logger.info(`dsh-links: device revoke-all removed=${result.body?.removed ?? 0}`)
        }
        json(res, result.status, result.body)
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/pair-approve",
      handler: async (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (!requireJsonWrite(req, res)) return
        const body = await readJson(req, res)
        if (!body) return
        sweepExpiredPending(state, stateFile, rt)
        const result = await activatePendingDevice(state, stateFile, rt, body.deviceId)
        if (result.status === 200 && result.body?.replacedDeviceIds?.length) {
          ctx.logger.info(
            `dsh-links: device replace approve device=${String(result.body.deviceId).slice(0, 8)} replaced=${result.body.replacedDeviceIds.map((x) => String(x).slice(0, 8)).join(",")}`,
          )
        }
        json(res, result.status, result.body)
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/workspace-approvals",
      handler: (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" })
        json(res, 200, { approvals: rt.workspaceApprovals.list() })
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/workspace-approve",
      handler: async (req, res) => {
        const body = await readLoopbackPost(req, res)
        if (!body) return
        const result = await approveQueuedWorkspace(rt.workspaceApprovals, body.requestId, (path) =>
          callLocalRpc(targetPort, "workspace.create", { path }))
        if (result.deviceId) {
          ctx.logger.info(`dsh-links: workspace approve device=${String(result.deviceId).slice(0, 8)}`)
        } else if (result.error) {
          ctx.logger.warn(`dsh-links: workspace approve: ${result.error?.message ?? result.error}`)
        }
        json(res, result.status, result.body)
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/workspace-reject",
      handler: async (req, res) => {
        const body = await readLoopbackPost(req, res)
        if (!body) return
        const result = rejectQueuedWorkspace(rt.workspaceApprovals, body.requestId)
        if (result.status === 200) {
          ctx.logger.info(`dsh-links: workspace reject request=${String(body.requestId).trim().slice(0, 8)}`)
        }
        json(res, result.status, result.body)
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/pair-settings",
      handler: async (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (!requireJsonWrite(req, res)) return
        const body = await readJson(req, res)
        if (!body) return
        if (typeof body.requireConfirm !== "boolean") {
          return json(res, 400, { error: "缺少 requireConfirm" })
        }
        // 只改此后新配对的默认行为；已排队的 pending 必须逐台批准/拒绝/到期，避免误关开关放行攻击者。
        state.pairRequireConfirm = body.requireConfirm
        saveState(stateFile, state)
        json(res, 200, { ok: true, requireConfirm: pairRequireConfirm(config, state) })
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/diagnostics",
      handler: async (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" })
        if (readiness.phase !== "ready") return proxyPending(res)
        const report = await runDiagnostics(diagnosticsSource(null), { scope: "panel" })
        ctx.logger.info(`dsh-links: diagnostics scope=panel ${report.checks.map((item) => `${item.id}=${item.status}`).join(" ")}`)
        json(res, 200, report)
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/previews",
      handler: async (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        if (req.method === "GET") {
          let detected = []
          let detectedError
          try {
            detected = await currentDetections()
          } catch (err) {
            // 探测失败不要静默成空列表：面板会以为「没有在跑的开发服务器」。
            detectedError = String(err?.code ?? err?.message ?? "error").slice(0, 40)
            try { ctx.logger.warn(`dsh-links: preview detection failed: ${detectedError}`) } catch {}
          }
          return json(res, 200, { previews: previews.listPanel(), detected, ...(detectedError ? { detectedError } : {}) })
        }
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" })
        const body = await readLoopbackPost(req, res)
        if (!body) return
        const result = previews.approve({ port: body.port, label: body.label })
        json(res, result.status, result.body)
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/previews/revoke",
      handler: async (req, res) => {
        const body = await readLoopbackPost(req, res)
        if (!body) return
        const result = previews.revoke(body.previewId)
        json(res, result.status, result.body)
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/devices",
      handler: (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        sweepExpiredPending(state, stateFile, rt)
        json(res, 200, {
          devices: state.devices.map(publicDevice),
        })
      },
    }),
    // ---------- 远程连接面板 API（RFC §6.6；全部回环同源，且在 PANEL_ONLY_PATHS 里对 18640 隐藏） ----------
    web.register({
      kind: "exact",
      path: "/dsh-link/remote-status",
      handler: (req, res) => {
        if (!requireLoopbackSameOrigin(req, res)) return
        json(res, 200, remote.status())
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/remote-enable",
      handler: async (req, res) => {
        const body = await readLoopbackPost(req, res)
        if (!body) return
        let view
        try {
          view = await remote.enable({ endpoint: body.endpoint, outerPin: body.outerPin })
        } catch (err) {
          if (err instanceof TypeError) return json(res, 400, { error: err.message })
          throw err
        }
        json(res, 200, { ok: view.state === "ready", ...view })
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/remote-disable",
      handler: async (req, res) => {
        const body = await readLoopbackPost(req, res)
        if (!body) return
        json(res, 200, { ok: true, ...(await remote.disable()) })
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/remote-test",
      handler: async (req, res) => {
        const body = await readLoopbackPost(req, res)
        if (!body) return
        const agent = remote.agent
        if (!agent || agent.status !== "ready") return json(res, 409, { error: "远程连接还没就绪" })
        json(res, 200, await agent.selfTest({ certFingerprint: fp() }))
      },
    }),
    web.register({
      kind: "exact",
      path: "/dsh-link/remote-reset-identity",
      handler: async (req, res) => {
        const body = await readLoopbackPost(req, res)
        if (!body) return
        // 危险操作：所有手机的远程凭据立即作废，需面板二次确认后显式带 confirm
        if (body.confirm !== true) return json(res, 400, { error: "缺少确认" })
        const view = await remote.resetIdentity()
        if (!view) return json(res, 409, { error: "远程连接从未启用" })
        json(res, 200, { ok: true, ...view })
      },
    }),
  ]

  /**
   * 接管 approval/request waterfall（dsh 内部 API：事件名是「approval/request」，
   * 签名是 (req, next)，不是元事件 "waterfall"）。无手机 SSE 时必须 next()，
   * 否则会把桌面审批一并挂死。
   *
   * 必须 prepend 注册：DSH 的 api-remotes 也监听这个 waterfall，把审批转给电脑网页，
   * 且只有网页回答「交给下一个」才会 next()。它先于插件注册，排在前面时插件永远轮不到
   * （0.1.5-rc.3 / 0.1.7-alpha.1 上「钩子不触发」的真因）。排到最前后：手机正在订阅该会话
   * 就由手机接管，否则 next() 原样交回网页。user-questions/request 同理。
   */
  ctx.on("approval/request", (req, next) => rt.awaiting.track(req?.agent?.session?.id, () => {
    if (req?.signal?.aborted === true) return Promise.resolve("cancelled")
    const sessionId = req?.agent?.session?.id
    const writers = sessionId ? rt.sessionStreams.get(sessionId) : null
    const id = findApprovalId(req)
    if (!id) {
      ctx.logger.info(`dsh-links: approval/request passthrough（无法解析审批 id）session=${String(sessionId ?? "?").slice(0, 8)} callId=${req?.callId ?? "无"} reqId=${req?.id ?? "无"} tool=${req?.toolName ?? req?.name ?? "?"}`)
      return next()
    }
    // 双端审批：总是先建手机端记录，再把请求交给电脑端——两边各弹各的，谁先答用谁。
    // 不能按「手机此刻是否连着」决定要不要接管：电脑端开着会话、手机只是没订阅时，
    // 整体交回电脑端会让手机端完全看不到这条待办（真实使用中就是这么漏的）。
    const hostSubscribers = hostEvents.subscriberCount
    const liveMobile = Boolean(writers?.size) || hasLiveMobileDevice(rt, hostSubscribers)
    ctx.logger.info(`dsh-links: approval/request 双端接管 session=${String(sessionId).slice(0, 8)} id=${String(id).slice(0, 24)} callId=${req?.callId ?? "无"} tool=${req?.toolName ?? req?.name ?? "?"} 手机订阅=${writers?.size ?? 0} 后台流=${hostSubscribers} 手机在线=${liveMobile ? "是" : "否"}`)
    return new Promise((resolve) => {
      const eligible = subscribedDeviceIds(writers)
      // 没在看这个会话的手机也要能作答：后台通知点开会话后按 deviceId 认人。
      for (const device of state.devices ?? []) {
        if (device?.deviceId) eligible.add(device.deviceId)
      }
      const rec = {
        id,
        sessionId,
        type: "approval",
        createdAt: Date.now(),
        deadlineAt: Date.now() + APPROVAL_TIMEOUT_MS,
        eligibleDeviceIds: eligible,
        settled: false,
        callId: req?.callId ?? null,
        toolName: req?.toolName ?? req?.name ?? req?.payload?.toolName ?? null,
        reason: typeof req?.reason === "string" && req.reason.trim() ? req.reason.trim().slice(0, 400) : null,
        signal: req?.signal,
        settle: (outcome) => resolve(APPROVAL_OUTCOMES.has(outcome) ? outcome : "unavailable"),
      }
      rec.onAbort = () => rt.requests.finishApproval(rec, "cancelled")
      rec.timer = setTimeout(() => rt.requests.finishApproval(rec, "unavailable"), APPROVAL_TIMEOUT_MS)
      rec.timer?.unref?.()
      rt.requests.addApproval(rec)
      req.signal?.addEventListener("abort", rec.onAbort, { once: true })
      // 电脑端：api-remotes 把这个 waterfall 转给网页。它给出明确答复就用它的；
      // 没有应答者 / 网页没接这个会话 / 抛错，都继续等手机端。
      Promise.resolve()
        .then(() => next())
        .then((outcome) => {
          if (rec.settled) return
          if (!desktopApprovalDecided(outcome)) {
            ctx.logger.info(`dsh-links: 电脑端未定案（${String(outcome)}），继续等手机端 session=${String(sessionId).slice(0, 8)}`)
            // 手机端没连着时，别把这一轮卡满 5 分钟：电脑端都说没人应答了，
            // 再给手机端一段重连窗口，等不到就按无人应答结束。
            if (!liveMobile && !rec.graceTimer) {
              rec.graceTimer = setTimeout(() => {
                ctx.logger.info(`dsh-links: 手机端 ${Math.round(APPROVAL_OFFLINE_GRACE_MS / 1000)} 秒内未接入，审批按无人应答结束 session=${String(sessionId).slice(0, 8)}`)
                rt.requests.finishApproval(rec, "unavailable")
              }, APPROVAL_OFFLINE_GRACE_MS)
              rec.graceTimer?.unref?.()
            }
            return
          }
          ctx.logger.info(`dsh-links: 审批由电脑端定案 ${outcome} session=${String(sessionId).slice(0, 8)}`)
          rt.requests.finishApproval(rec, outcome)
        }, (error) => {
          ctx.logger.warn(`dsh-links: 电脑端审批通道异常：${String(error?.code ?? error?.message ?? error)} session=${String(sessionId).slice(0, 8)}`)
        })
      // 审批要显示「这次到底要做什么」：approval/request 只给 toolName/callId/reason，
      // 参数在紧邻的 tool/call 事件里。补一次，失败就只显示工具名，不影响审批本身。
      if (req?.callId) {
        const callId = String(req.callId)
        Promise.resolve()
          .then(() => callLocalRpc(targetPort, "session.history", { sessionId, maxMessages: 24 }))
          .then((history) => {
            const call = (history?.events ?? []).find((item) =>
              item?.event?.type === "tool/call" && String(item.event.data?.callId ?? "") === callId)
            const detail = toolCallDetail(rec.toolName, call?.event?.data?.arguments)
            if (!detail) return
            rec.detail = detail
            rec.headline = oneLine(detail)
          }, () => {})
      }
    })
  }), { prepend: true })

  /**
   * 0.1.2 起澄清卡走 `user-questions/request` waterfall，不再经 /api/events.mux。
   * 有手机 SSE 时由插件代答；否则 next() 把问题交给网页 UI。
   */
  ctx.on("user-questions/request", (req, next) => rt.awaiting.track(req?.agent?.session?.id, () => {
    if (req?.signal?.aborted === true) return next()
    const sessionId = req?.agent?.session?.id
    const writers = sessionId ? rt.sessionStreams.get(sessionId) : null
    if (!writers || writers.size === 0) return next()
    const questions = req.questions ?? []
    const targets = questions.length > 1
      ? [...writers].filter((conn) => conn.caps?.multiQuestion)
      : [...writers]
    if (targets.length === 0) return next()
    const rpcId = "q-" + randomBytes(12).toString("hex")
    return new Promise((resolve, reject) => {
      const rec = {
        id: rpcId,
        sessionId,
        type: "question",
        createdAt: Date.now(),
        deadlineAt: Date.now() + APPROVAL_TIMEOUT_MS,
        eligibleDeviceIds: subscribedDeviceIds(targets),
        settled: false,
        questions,
        signal: req?.signal,
        settle: (answer) => {
          if (answer && Array.isArray(answer.answers)) resolve(answer)
          else Promise.resolve().then(() => next()).then(resolve, reject)
        },
      }
      rec.onAbort = () => rt.requests.finishQuestion(rec, null)
      rec.timer = setTimeout(() => rt.requests.finishQuestion(rec, null), APPROVAL_TIMEOUT_MS)
      rec.timer?.unref?.()
      rt.requests.addQuestion(rec)
      req.signal?.addEventListener("abort", rec.onAbort, { once: true })
      const body = JSON.stringify({ rpcId, sessionId, questions })
      writeSse(new Set(targets), `event: question\ndata: ${body}\n\n`)
      ctx.logger.info(`dsh-links: question → mobile session=${String(sessionId).slice(0, 8)} rpc=${rpcId.slice(0, 8)}`)
    })
  }), { prepend: true })

  // ---------- 手机接入代理（0.0.0.0:<port> HTTPS）：仅 health / pair / mobile/* ----------
  const hostEvents = createHostEventHub({
    listSessions: async () => {
      const list = await callLocalRpc(targetPort, "session.list", {})
      const approvals = new Map()
      const questions = new Set()
      for (const rec of rt.requests.pendingApprovals.values()) {
        if (!rec?.sessionId || approvals.has(rec.sessionId)) continue
        approvals.set(rec.sessionId, { id: rec.id, toolName: rec.toolName ?? "", detail: rec.detail ?? "" })
      }
      for (const rec of rt.requests.pendingQuestions.values()) {
        if (rec?.sessionId) questions.add(rec.sessionId)
      }
      return (list?.items ?? []).map((item) => {
        const approval = approvals.get(item?.sessionId)
        return {
          sessionId: item?.sessionId,
          title: item?.projections?.values?.title,
          origin: item?.origin,
          running: Boolean(item?.running),
          pendingApproval: Boolean(approval),
          // 双端审批：让 App 后台通知能带上审批 id 和工具名，直接给「允许一次 / 拒绝」。
          pendingApprovalId: approval?.id ?? null,
          pendingApprovalToolName: approval?.toolName ?? null,
          // 通知栏也要能看见「在跑什么命令」，否则只能盲批。
          pendingApprovalDetail: approval?.detail ? String(approval.detail).slice(0, 600) : null,
          pendingQuestion: questions.has(item?.sessionId),
          awaitingInput: Boolean(rt.awaiting?.has(item?.sessionId)),
        }
      })
    },
    terminalReason: async (sessionId) => {
      const history = await callLocalRpc(targetPort, "session.history", { sessionId, maxMessages: 8 })
      return deriveStoppedReason(history?.events)
    },
  })
  const requestHandler = async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://x").pathname
      // 经中继进来的连接先按来源收窄（RFC §6.1 第 5、6 条，§6.6 selftest）
      const origin = requestOrigin(rt, req)
      if (origin?.selftest) return json(res, 403, { error: "forbidden" })
      if (origin?.kind === "bootstrap") {
        // 首配凭据只能用来配对
        if (pathname === "/dsh-link/pair" && req.method === "POST") {
          return handlePair(req, res, config, state, stateFile, rt, ctx.logger, origin)
        }
        return json(res, 403, { error: "forbidden" })
      }
      if (pathname === "/dsh-link/health" && req.method === "GET") {
        return json(res, 200, { ok: true })
      }
      if (pathname === "/dsh-link/pair" && req.method === "POST") {
        // 已配对设备的远程会合凭据不是配对凭据；远程首配走 kind=bootstrap
        if (origin) return json(res, 403, { error: "forbidden" })
        return handlePair(req, res, config, state, stateFile, rt, ctx.logger)
      }
      if (PANEL_ONLY_PATHS.has(pathname)) {
        return json(res, 404, { error: "not found" })
      }
      const device = authorize(req, state, stateFile)
      if (config.debug) {
        ctx.logger.info(`dsh-links: ${req.method} ${pathname} → ${device ? `device:${device.deviceId}` : "denied"}`)
      }
      if (!device) {
        return json(res, 401, { error: "缺少或无效的连接 token" })
      }
      // 会合密钥与 token 必须属于同一台设备：防止拿 A 的远程凭据承载 B 的 token
      if (origin && origin.deviceId !== device.deviceId) {
        return json(res, 403, { error: "forbidden" })
      }
      sweepExpiredPending(state, stateFile, rt)
      if (!isDeviceAuthorized(state, device)) {
        return json(res, 401, { error: "缺少或无效的连接 token" })
      }
      if (isDevicePending(device)) {
        return json(res, 403, { error: "设备待主机确认", pending: true })
      }
      trackDeviceRequest(rt, device.deviceId, req, res)
      touchDevice(state, device, stateFile)
      if (pathname.startsWith("/dsh-link/mobile/")) {
        const permissionMatch = pathname.match(/^\/dsh-link\/mobile\/sessions\/([^/]+)\/permission$/)
        if (req.method === "POST" && permissionMatch) {
          if (!requireJsonWrite(req, res)) return
          const sessionId = decodeURIComponent(permissionMatch[1])
          const body = await readAuthorizedJson(req, res, state, device)
          if (!body) return
          // 与审批请求同规则：只有正在查看该会话（活跃 SSE 订阅）的设备才能改权限。
          if (!isDeviceSubscribedToSession(rt, sessionId, device.deviceId)) {
            return json(res, 403, { error: "仅正在查看该会话的设备可修改权限" })
          }
          const preset = String(body.preset ?? "").trim()
          const PRESET_SPECS = {
            "read-only": { sandbox: "read-only", approval: "ask" },
            "workspace-write": { sandbox: "workspace-write", approval: "ask" },
            "danger-full-access": { sandbox: "danger-full-access", approval: "never" }, // dsh: never=需审批的操作自动拒绝；是否符合「Full access」需真机核对
          }
          const spec = Object.prototype.hasOwnProperty.call(PRESET_SPECS, preset) ? PRESET_SPECS[preset] : undefined
          if (!spec) return json(res, 400, { error: "preset 无效" })
          // 手机 danger-full-access 默认关闭：拒绝而不是静默降级。
          if (preset === "danger-full-access" && !mobileDangerFullAccessAllowed(config)) {
            return json(res, 403, { error: "danger-full-access 已被宿主禁用；请先在宿主开启 allowMobileDangerFullAccess" })
          }
          try {
            const sessions = ctx.get("sessions")
            const session = typeof sessions?.get === "function" ? await sessions.get(sessionId) : undefined
            const result = await runMobileDeviceMutation(rt, state, device, () => {
              if (!session) return { missing: true }
              session.append("permission/preset", { preset })
              session.append("approval/policy", { policy: spec.approval })
              session.append("sandbox/mode", { mode: spec.sandbox })
              return { missing: false }
            })
            if (mobileMutationWasRevoked(result)) return respondDeviceRevoked(res)
            if (result.missing) return json(res, 404, { error: "会话不存在" })
            ctx.logger.info(`dsh-links: permission preset → ${preset} session=${String(sessionId).slice(0, 8)} device=${String(device.deviceId).slice(0, 8)}`)
            return json(res, 200, { ok: true, preset, approval: spec.approval, sandbox: spec.sandbox })
          } catch (err) {
            ctx.logger.warn(`dsh-links: permission update: ${err?.message ?? err}`)
            return json(res, 500, { error: "permission update failed" })
          }
        }
        if (req.method === "GET" && pathname === "/dsh-link/mobile/events") {
          return handleHostEvents(req, res, hostEvents)
        }
        if (req.method === "GET" && pathname === "/dsh-link/mobile/previews") {
          return json(res, 200, { previews: previews.listPublic() })
        }
        if (req.method === "GET" && pathname === "/dsh-link/mobile/preview-detections") {
          let detections = []
          try { detections = await currentDetections() } catch { detections = [] }
          return json(res, 200, { detections })
        }
        if (previews.handleHttp(req, res)) return
        const streamMatch = pathname.match(/^\/dsh-link\/mobile\/sessions\/([^/]+)\/stream$/)
        if (req.method === "GET" && streamMatch) {
          return handleStreamRoute(decodeURIComponent(streamMatch[1]), res, targetPort, config, req, rt, device)
        }
        return handleMobileApi(req, res, targetPort, state, stateFile, device, pathname, rt, config, ctx.logger, mobileApiDeps)
      }
      return json(res, 404, { error: "not found" })
    } catch (err) {
      ctx.logger.warn(`dsh-links: proxy request error: ${err?.message ?? err}`)
      if (!res.headersSent) json(res, 500, { error: "proxy error" })
      else res.destroy()
    }
  }

  let proxy
  let pollTimer
  let keepAliveTimer
  let muxBridge = null
  const ready = loadOrCreateTls(ensureStateDir(config)).then(async (tls) => {
    tlsHolder.fingerprint = tls.fingerprint
    tlsHolder.cert = tls.cert
    proxy = createHttpsServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" }, requestHandler)
    proxy.on("error", (err) => {
      ctx.logger.warn(`dsh-links: proxy error: ${err?.message ?? err}`)
    })
    proxy.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {})
      if (!matchPreviewPath(req.url)) {
        rejectUpgrade(socket, 404, "not found")
        return
      }
      const origin = requestOrigin(rt, req)
      if (origin?.selftest || origin?.kind === "bootstrap") {
        rejectUpgrade(socket, 403, "forbidden")
        return
      }
      const device = authorize(req, state, stateFile)
      if (!device || (origin && origin.deviceId !== device.deviceId) || !isDeviceAuthorized(state, device) || isDevicePending(device)) {
        rejectUpgrade(socket, 401, "unauthorized")
        return
      }
      touchDevice(state, device, stateFile)
      previews.handleUpgrade(req, socket, head)
    })
    // 远程每条连接都是一次 WSS + 会合 + 内层 TLS，必须让 App 的连接池复用（RFC §4.2）。
    // 服务端空闲上限要长于 App 远程连接池的 keepAlive（50 秒），由客户端先放手，避免竞态。
    proxy.keepAliveTimeout = 65_000
    proxy.headersTimeout = 66_000
    pollTimer = setInterval(() => {
      for (const sessionId of rt.sessionStreams.keys()) {
        if ((rt.sessionStreams.get(sessionId)?.size ?? 0) > 0) {
          pollSession(sessionId, targetPort, rt)
        }
      }
    }, config.eventPollIntervalMs)
    keepAliveTimer = setInterval(() => {
      for (const [sessionId, writers] of rt.sessionStreams) {
        writeSse(writers, ": keepalive\n\n")
        if (writers.size === 0) dropSession(rt, sessionId)
      }
    }, 15_000)
    // 端口顺延：默认端口（或配置端口）被占（另一个 DSH 实例、崩溃残留、别的软件抢了 18640）时
    // 按 +1 试到 PORT_LISTEN_ATTEMPTS 个，抢到哪个就记进 portState。
    // 二维码/面板/RPC 守卫读的都是 boundPort()，所以 App 拿到的一直是真实端口；
    // 只有连续 attempts 个都占用才算启动失败（此时 readiness.phase="failed"，与原先一致）。
    const candidatePort = await findFreeListenPort(config.port, PORT_LISTEN_ATTEMPTS)
    if (candidatePort == null) {
      const err = new Error(
        `listen EADDRINUSE: 端口 ${config.port}–${config.port + PORT_LISTEN_ATTEMPTS - 1} 都被占用`,
      )
      err.code = "EADDRINUSE"
      throw err
    }
    if (candidatePort !== config.port) {
      ctx.logger.warn(`dsh-links: 端口 ${config.port} 已被占用，改用 ${candidatePort}`)
    }
    portState.value = candidatePort
    portState.shifted = candidatePort !== config.port
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        proxy.removeListener("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        proxy.removeListener("error", onError)
        resolve()
      }
      proxy.once("error", onError)
      proxy.once("listening", onListening)
      proxy.listen(candidatePort, "0.0.0.0")
    })
    {
      const bound = proxy.address()?.port ?? candidatePort
      portState.value = bound
      portState.shifted = bound !== config.port
      const shiftedHint = portState.shifted ? `（配置端口 ${config.port} 被占用，已顺延）` : ""
      ctx.logger.info(
        `dsh-links: 手机接入代理已启动，https 端口 ${bound}${shiftedHint}（指纹 ${tls.fingerprint.slice(0, 12)}…）`,
      )
      for (const u of lanUrls(config, bound).urls) ctx.logger.info(`dsh-links: 可访问地址 ${u}`)
      remote.start().catch(() => {})
      muxBridge = startMuxQuestionBridge({
        targetPort,
        rt,
        logger: ctx.logger,
        requestPoll: (sessionId) => requestGapPoll(sessionId, targetPort, rt),
      })
    }
    return tls
  }).then((tls) => {
    // 只有 listen 成功才算就绪；仅证书生成完成还不够。
    readiness.phase = "ready"
    return tls
  }).catch((err) => {
    readiness.phase = "failed"
    readiness.error = String(err?.message ?? err)
    ctx.logger.warn(`dsh-links: 手机接入代理启动失败（${readiness.error}），配对面板保持不可用`)
    throw err
  })
  // 宿主未必 await 该 promise：挂 no-op catch 避免 unhandled rejection；宿主自行处理 ready 不受影响。
  ready.catch(() => {})

  ctx.effect(
    () => () => {
      readiness.phase = "stopped"
      for (const dispose of disposers) dispose()
      if (pollTimer) clearInterval(pollTimer)
      if (keepAliveTimer) clearInterval(keepAliveTimer)
      try { hostEvents.stop() } catch {}
      try { previews.stop() } catch {}
      try { muxBridge?.stop() } catch {}
      muxBridge = null
      remote.stop()
      for (const writers of rt.sessionStreams.values()) {
        for (const conn of writers) {
          try { conn.res.end() } catch {}
        }
      }
      rt.sessionStreams.clear()
      rt.sessionFiles.clear()
      rt.inflightPolls.clear()
      rt.pendingPolls.clear()
      for (const gap of rt.gapPolls.values()) {
        if (gap.timer) clearTimeout(gap.timer)
      }
      rt.gapPolls.clear()
      rt.reasoningCache.clear()
      rt.sessionActivityCache.clear()
      rt.requests.disposeAll("cancelled")
      unbindLocalRpcRuntime()
      if (gatewayPeer) { try { Promise.resolve(gatewayPeer.dispose()).catch(() => {}) } catch {} }
      try { proxy?.closeAllConnections?.() } catch {}
      try { proxy?.close() } catch {}
    },
    "dsh-links: proxy + routes",
  )

  return ready
}
