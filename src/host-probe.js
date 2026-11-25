/**
 * 宿主能力探针（B1）。
 *
 * 插件的每个手机端入口都对应一个 DSH Remote（定时任务、模型、设置…）。DSH 升级时这些
 * Remote 会被改名或合并（0.2.x 就把 `schedule/update` + `schedule/delete` 并成了
 * `schedule/edit`），插件侧没有可读的「宿主都提供了哪些 Remote」的注册表，只能按版本号猜
 * ——而版本号在 link: 挂载、旧 Host、rc 版本上给不出可信答案。
 *
 * 所以这里改成「实测能力」：启动后、以及每 5 分钟，用最小代价调一次每个入口依赖的 Remote，
 * 失败时按错误码区分「方法不存在」和「这次没调通」。结论交给 App 隐藏/保留入口，
 * 手机上不会出现点了必然 400 的按钮。
 *
 * 探测只发只读调用；唯一需要写的方法（schedule.edit）用一条必然 not-found 的删除请求，
 * 宿主返回 not-found 说明方法在、只是没有这条记录，不会真的删掉任何东西。
 */
import { isMissingRemoteError } from "./mobile-session-control.js"

/** 单次探测超时。宿主卡住时不能把整轮探测拖到分钟级。 */
export const PROBE_TIMEOUT_MS = 3_000
/** 探测结论缓存时长。 */
export const PROBE_TTL_MS = 5 * 60 * 1000
/** 并发探测数。宿主 RPC 是进程内调用，4 个并发足够又不至于把事件循环占满。 */
export const PROBE_CONCURRENCY = 4

/**
 * 探测表。id 是插件的点号方法名（与 RPC_METHOD_ALLOWLIST 同名，日志和诊断里可直接对照）。
 * `params` 必须是白名单方法的合法参数，否则探测本身会因为参数错而失败。
 */
export const HOST_PROBES = Object.freeze([
  { id: "schedule.catalog", params: {} },
  // 写方法：拿一个不可能存在的 id 删除。方法缺失 → 判 missing；not-found → 判 supported。
  { id: "schedule.edit", params: { id: "probe-missing", action: "delete" } },
  { id: "agentPreset.list", params: {} },
  { id: "settings.describe", params: {} },
  { id: "llm.listProviders", params: {} },
  { id: "credentials.describe", params: { refs: [] } },
  { id: "workspace.list", params: {} },
])

const SUPPORTED = "supported"
const MISSING = "missing"
const UNKNOWN = "unknown"

const TRANSPORT_ERROR_CODES = new Set([
  "TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EPIPE",
  "ABORT_ERR",
  "aborted",
  "gateway/unauthorized",
  "gateway/disposed",
  "gateway/peer-disposed",
])

function isTransientProbeError(error) {
  const code = typeof error?.code === "string" ? error.code : ""
  if (TRANSPORT_ERROR_CODES.has(code)) return true
  if (code.startsWith("http/5")) return true
  const msg = String(error?.message ?? "")
  return /timed out|aborted|ECONNREFUSED|ECONNRESET|peer[- ]disposed/i.test(msg)
}

function withTimeout(promise, timeoutMs, activeTimers, controller) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller?.abort() } catch {}
      const error = new Error("probe timeout")
      error.code = "TIMEOUT"
      reject(error)
    }, timeoutMs)
    timer.unref?.()
    activeTimers.add(timer)
  })
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer)
    activeTimers.delete(timer)
  })
}

/**
 * @param {object} options
 * @param {(method: string, params: object) => Promise<unknown>} options.call 调本机 RPC（callLocalRpc）
 * @param {number} [options.ttlMs]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.concurrency]
 * @param {() => number} [options.now]
 * @param {Array<{ id: string, params: object }>} [options.probes]
 */
export function createHostProbe({
  call,
  ttlMs = PROBE_TTL_MS,
  timeoutMs = PROBE_TIMEOUT_MS,
  concurrency = PROBE_CONCURRENCY,
  now = () => Date.now(),
  probes = HOST_PROBES,
} = {}) {
  if (typeof call !== "function") throw new TypeError("createHostProbe requires call(method, params)")

  const table = Array.isArray(probes) ? probes.filter((probe) => probe && typeof probe.id === "string") : []
  const status = new Map(table.map((probe) => [probe.id, UNKNOWN]))
  const activeTimers = new Set()
  const activeControllers = new Set()
  let checkedAt = 0
  let hasChecked = false
  let inflight = null
  let disposed = false

  async function probeOne(probe) {
    const controller = new AbortController()
    activeControllers.add(controller)
    try {
      await withTimeout(
        Promise.resolve().then(() => call(probe.id, probe.params ?? {}, { signal: controller.signal })),
        timeoutMs,
        activeTimers,
        controller,
      )
      return SUPPORTED
    } catch (error) {
      // 只有「方法不存在」才算宿主不支持；传输/鉴权/超时算 unknown；业务错误（not-found / 参数校验）说明方法在。
      if (isMissingRemoteError(error)) return MISSING
      if (isTransientProbeError(error)) return UNKNOWN
      return SUPPORTED
    } finally {
      activeControllers.delete(controller)
    }
  }

  async function run() {
    const queue = [...table]
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
      for (;;) {
        if (disposed) return
        const probe = queue.shift()
        if (!probe) return
        const result = await probeOne(probe)
        if (disposed) return
        status.set(probe.id, result)
      }
    })
    await Promise.all(workers)
    if (disposed) return snapshot()
    checkedAt = now()
    hasChecked = true
    return snapshot()
  }

  /** 探测一次；并发调用共用同一轮，避免诊断页面被连点打爆。 */
  function refresh({ force = false } = {}) {
    if (disposed) return Promise.resolve(snapshot())
    if (inflight) return inflight
    if (!force && hasChecked && now() - checkedAt < ttlMs) return Promise.resolve(snapshot())
    inflight = run().finally(() => {
      inflight = null
    })
    return inflight
  }

  /** 只在过期时补一次（诊断/配对面板调用，不阻塞响应）。 */
  function ensure() {
    void refresh().catch(() => {})
  }

  function snapshot() {
    const supported = []
    const missing = []
    const unknown = []
    for (const probe of table) {
      const value = status.get(probe.id) ?? UNKNOWN
      if (value === SUPPORTED) supported.push(probe.id)
      else if (value === MISSING) missing.push(probe.id)
      else unknown.push(probe.id)
    }
    return {
      checkedAt,
      v: 1,
      total: table.length,
      supported,
      missing,
      unknown,
    }
  }

  /** 给 pluginCapabilities 的形状：只报缺口，别把整张表塞进每个帧。 */
  function capabilities() {
    const view = snapshot()
    return {
      v: 1,
      checkedAt: view.checkedAt,
      missing: view.missing,
      unknown: view.unknown,
    }
  }

  function stop() {
    disposed = true
    inflight = null
    for (const timer of activeTimers) clearTimeout(timer)
    activeTimers.clear()
    for (const controller of activeControllers) {
      try { controller.abort() } catch {}
    }
    activeControllers.clear()
  }

  return { refresh, ensure, snapshot, capabilities, stop }
}
