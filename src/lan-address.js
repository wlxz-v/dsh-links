/**
 * 局域网/Tailscale 地址分类、可达性排序与监听端口顺延探测。
 */
import { createServer as createNetServer } from "node:net"
import { networkInterfaces } from "node:os"

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
      probe.listen({ port: candidate, host: "0.0.0.0", exclusive: true }, () => probe.close(() => done(true)))
    })
    if (free) return candidate
  }
  return null
}

export function listenExposure(config, infos, port = config.port) {
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

export function lanUrls(config, port = config.port) {
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
