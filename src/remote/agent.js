/**
 * DLP/1 插件侧 Agent（RFC §5.4、§5.5、§6.1、§6.7、§10.3）。
 *
 * - 控制连接：hello → host_register → registered；按 registered.ping 发 ping；断线按 §6.7 退避重连。
 * - open：严格按 §5.5 的顺序验证，任一步失败只回 reject，**绝不 dial 本地端口**。
 * - 通过后开一条数据连接发 host_accept，收到 ready 才连 127.0.0.1:<pluginPort>；
 *   本地 socket connect 时、转发任何字节之前登记来源标签（§6.1），关闭时删除。
 *
 * 目标地址只来自构造参数 pluginPort：代码里不存在从任何消息读取目标地址的路径（§13.1）。
 * 日志只记事件与错误码，不记 route、公钥、handle、nonce、MAC、种子或数据（§11 第 5 条）。
 */
import { EventEmitter } from "node:events"
import { createHash, randomBytes } from "node:crypto"
import net from "node:net"
import tls from "node:tls"
import WebSocket, { createWebSocketStream } from "ws"
import {
  acceptTranscript, b64u, clientMac, clientTranscript, deviceRelayKey, hostPublicKey,
  privateKeyFromSeed, registerTranscript, routeId as deriveRouteId, safeEqual, signHost, unb64u,
} from "./crypto.js"
import { NonceCache } from "./bootstrap.js"
import {
  ACCEPT_READY_TIMEOUT_MS, BOOTSTRAP_MAX_STREAMS, CHALLENGE_BYTES, CLOCK_SKEW_SEC, CLOSE, DATA_CHUNK_BYTES,
  DEVICE_MAX_STREAMS, DLP_VERSION, FIRST_MESSAGE_TIMEOUT_MS, HOST_MAX_STREAMS, KEY_BYTES, MAC_BYTES,
  MAX_DATA_MESSAGE_BYTES, NONCE_BYTES, RECONNECT_BASE_MS, RECONNECT_JITTER, RECONNECT_MAX_MS,
  RECONNECT_STABLE_MS, REJECT, REPLACED_BACKOFF_MS, ROUTE_BYTES, SID_BYTES, WRITE_TIMEOUT_MS,
  encodeControl, parseControlFrame, safeCode,
} from "./wire.js"

const SELFTEST_TTL_MS = 60_000
const WATCHDOG_INTERVAL_MS = 5_000
const LOCAL_FLUSH_TIMEOUT_MS = 5_000

function safeCloseWs(ws, code = CLOSE.NORMAL) {
  if (!ws) return
  try {
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
    else if (ws.readyState === WebSocket.OPEN) ws.close(code)
  } catch {}
}

function safeSendWs(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(payload, () => {})
    return true
  } catch {
    return false
  }
}

export class RemoteAgent extends EventEmitter {
  #endpoint
  #outerPin
  #hostKeySeed
  #hostPrivKey
  #keySeed
  #hostPub
  #routeId
  #pluginPort
  #lookupDevice
  #bootstrap
  #isLocalReady
  #logger
  #now
  #timers
  #random
  #nonces

  #status = "off"
  /** 控制连接最近一次失败的原因（面板用）；注册成功即清空。只含错误码或简短原因，不含秘密。 */
  #lastError = ""
  #stopped = true
  #ctrl = null
  #ctrlHandshakeTimer = null
  #lastPongAt = 0
  #registeredAt = 0
  #attempt = 0
  #reconnectTimer = null
  #pingTimer = null
  #startWaiter = null
  #startPromise = null
  /** sid(b64u) → 流记录；含正在 accept 的（它们也占并发名额） */
  #streams = new Map()
  /** 本地 socket 的 localPort → 来源标签（§6.1） */
  #origins = new Map()
  /** handle(b64u) → { handle, expiresAtMs }，支持并发自检不互踩 */
  #selftests = new Map()

  constructor({
    endpoint,
    outerPin = "",
    hostKeySeed,
    keySeed,
    pluginPort,
    lookupDevice,
    bootstrap,
    isLocalReady,
    logger,
    allowInsecureWs = false,
    now = () => Date.now(),
    // 以下仅供测试注入（不是协议的一部分）
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
    random = Math.random,
    nonceCache = new NonceCache(),
  }) {
    super()
    const url = new URL(endpoint)
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && allowInsecureWs)) {
      throw new TypeError("DLP endpoint must use wss://")
    }
    if (typeof outerPin !== "string" || (outerPin !== "" && !/^[0-9a-f]{64}$/.test(outerPin))) {
      throw new TypeError("outerPin must be empty or 64 lowercase hex characters")
    }
    if (!Buffer.isBuffer(keySeed) || keySeed.length !== 32) throw new TypeError("keySeed must be 32 bytes")
    if (typeof pluginPort !== "function" && (!Number.isInteger(pluginPort) || pluginPort < 1 || pluginPort > 65535)) {
      throw new TypeError("invalid pluginPort")
    }
    if (typeof lookupDevice !== "function" || typeof isLocalReady !== "function") throw new TypeError("missing callbacks")
    if (!bootstrap || typeof bootstrap.lookup !== "function") throw new TypeError("missing bootstrap table")
    this.#endpoint = url.toString()
    this.#outerPin = outerPin
    this.#hostKeySeed = Buffer.from(hostKeySeed)
    this.#hostPrivKey = privateKeyFromSeed(this.#hostKeySeed)
    this.#hostPub = hostPublicKey(this.#hostKeySeed)
    this.#routeId = deriveRouteId(this.#hostPub)
    this.#keySeed = Buffer.from(keySeed)
    this.#pluginPort = typeof pluginPort === "function" ? pluginPort : () => pluginPort
    this.#lookupDevice = lookupDevice
    this.#bootstrap = bootstrap
    this.#isLocalReady = isLocalReady
    this.#logger = logger ?? { info() {}, warn() {} }
    this.#now = now
    this.#timers = timers
    this.#random = random
    this.#nonces = nonceCache
  }

  get status() {
    return this.#status
  }

  get routeId() {
    return Buffer.from(this.#routeId)
  }

  get lastError() {
    return this.#lastError
  }

  /** 来源标签（§6.1）；插件以 req.socket.remotePort 查询。 */
  originOf(localPort) {
    const tag = this.#origins.get(localPort)
    return tag ? { ...tag } : undefined
  }

  start() {
    if (!this.#stopped) return this.#startPromise
    this.#stopped = false
    this.#attempt = 0
    this.#startPromise = new Promise((resolve, reject) => {
      this.#startWaiter = { resolve, reject }
    })
    // 调用方不 await 时也不要冒出未处理的拒绝
    this.#startPromise.catch(() => {})
    this.#connectControl()
    return this.#startPromise
  }

  async stop() {
    this.#stopped = true
    this.#clearTimer("reconnect")
    this.#clearControlHandshake()
    this.#clearPing()
    this.#selftests.clear()
    this.#settleStart(new Error("remote agent stopped"))
    const closing = []
    if (this.#ctrl) closing.push(closeAndWait(this.#ctrl, CLOSE.NORMAL))
    this.#ctrl = null
    for (const rec of [...this.#streams.values()]) {
      if (rec.ws) closing.push(closeAndWait(rec.ws, CLOSE.NORMAL))
      this.#finishStream(rec)
    }
    await Promise.all(closing)
    this.#setStatus("off")
  }

  /** 吊销联动（§6.5）：关闭该设备全部流（含正在 accept 的），返回关闭数量。 */
  dropDevice(deviceId) {
    let count = 0
    for (const rec of [...this.#streams.values()]) {
      if (rec.tag.deviceId !== deviceId) continue
      count++
      safeCloseWs(rec.ws, CLOSE.NORMAL)
      this.#finishStream(rec)
    }
    return count
  }

  /**
   * 面板自检（§6.6）：以临时 relayHandle 充当 kind=device 客户端经 Relay 打开一条流，
   * 钉扎本机证书完成内层 TLS 握手后关闭。selftest 来源在插件侧一律 403。
   */
  async selfTest({ certFingerprint }) {
    const pin = String(certFingerprint ?? "").replace(/:/g, "").toLowerCase()
    const result = { ok: false, failedStage: "outer", outerMs: null, rendezvousMs: null, innerTlsMs: null }
    if (this.#status !== "ready") return result
    const handle = randomBytes(KEY_BYTES)
    const handleKey = b64u(handle)
    this.#selftests.set(handleKey, { handle, expiresAtMs: this.#now() + SELFTEST_TTL_MS })
    const started = Date.now()
    let ws
    let innerSocket
    try {
      ws = this.#newSocket()
      await waitForHello(ws)
      result.outerMs = Date.now() - started
      result.failedStage = "rendezvous"
      const ts = Math.floor(this.#now() / 1000)
      const nonce = randomBytes(NONCE_BYTES)
      const transcript = clientTranscript({ route: this.#routeId, kind: "device", key: handle, ts, nonce })
      const mac = clientMac(deviceRelayKey(this.#keySeed, handle), transcript)
      if (!safeSendWs(ws, encodeControl({ t: "client_open", v: DLP_VERSION, route: b64u(this.#routeId), kind: "device", key: handleKey, ts, nonce: b64u(nonce), mac: b64u(mac) }))) {
        throw new Error("failed to send client_open")
      }
      await waitForControl(ws, "ready", ACCEPT_READY_TIMEOUT_MS)
      result.rendezvousMs = Date.now() - started - result.outerMs
      result.failedStage = "inner"
      const innerStarted = Date.now()
      const duplex = createWebSocketStream(ws, { highWaterMark: DATA_CHUNK_BYTES })
      duplex.on("error", () => {})
      const inner = tls.connect({ socket: duplex, rejectUnauthorized: false, servername: "" })
      innerSocket = inner
      await new Promise((resolve, reject) => {
        // 隧道可能在握手完成前被关掉而不报 error：没有超时与 close 兜底时，面板请求会一直挂着
        const timer = setTimeout(() => reject(new Error("inner TLS timed out")), ACCEPT_READY_TIMEOUT_MS)
        timer.unref?.()
        inner.once("secureConnect", () => {
          clearTimeout(timer)
          const raw = inner.getPeerCertificate()?.raw
          if (!raw) return reject(new Error("missing inner peer certificate"))
          const fp = createHash("sha256").update(raw).digest("hex")
          if (fp === pin) resolve()
          else reject(new Error("inner certificate mismatch"))
        })
        inner.once("error", (err) => { clearTimeout(timer); reject(err) })
        inner.once("close", () => { clearTimeout(timer); reject(new Error("tunnel closed during inner TLS")) })
      })
      result.innerTlsMs = Date.now() - innerStarted
      result.ok = true
      result.failedStage = null
    } catch {
      // 失败阶段已记在 result.failedStage
    } finally {
      this.#selftests.delete(handleKey)
      innerSocket?.destroy()
      safeCloseWs(ws, CLOSE.NORMAL)
    }
    return result
  }

  // ─── 控制连接 ────────────────────────────────────────────────────────────

  #connectControl() {
    if (this.#stopped) return
    this.#setStatus("connecting")
    const ws = this.#newSocket()
    this.#ctrl = ws
    let registered = false
    let sentRegister = false
    this.#clearControlHandshake()
    this.#ctrlHandshakeTimer = setTimeout(() => {
      this.#ctrlHandshakeTimer = null
      if (this.#ctrl === ws && !registered) {
        this.#lastError = "TIMEOUT"
        this.#logger.warn("dlp-agent: control registration timed out")
        try { ws.terminate() } catch {}
      }
    }, ACCEPT_READY_TIMEOUT_MS)
    this.#ctrlHandshakeTimer?.unref?.()
    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? null : parseControlFrame(data)
      if (!msg || typeof msg.t !== "string") {
        safeCloseWs(ws, CLOSE.PROTOCOL_ERROR)
        return
      }
      if (msg.t === "hello" && !sentRegister) {
        const ch = decodeField(msg.ch, CHALLENGE_BYTES)
        if (msg.v !== DLP_VERSION || !ch) {
          safeCloseWs(ws, CLOSE.PROTOCOL_ERROR)
          return
        }
        sentRegister = true
        const sig = signHost(this.#hostPrivKey, registerTranscript(ch, this.#hostPub))
        safeSendWs(ws, encodeControl({ t: "host_register", v: DLP_VERSION, pub: b64u(this.#hostPub), sig: b64u(sig) }))
      } else if (msg.t === "registered" && sentRegister && !registered) {
        const route = decodeField(msg.route, ROUTE_BYTES)
        // Relay 给出的 route 必须与本机推导一致，否则不是我们注册成功的那条
        if (!route || !route.equals(this.#routeId)) {
          safeCloseWs(ws, CLOSE.PROTOCOL_ERROR)
          return
        }
        registered = true
        this.#clearControlHandshake()
        this.#lastError = ""
        this.#registeredAt = this.#now()
        this.#lastPongAt = this.#registeredAt
        this.#startPing(ws, Number.isSafeInteger(msg.ping) && msg.ping > 0 ? msg.ping : 20)
        this.#logger.info("dlp-agent: registered")
        this.#setStatus("ready")
        this.#settleStart(null)
      } else if (msg.t === "open" && registered) {
        this.#handleOpen(msg)
      } else if (msg.t === "pong" && registered) {
        this.#lastPongAt = this.#now()
      } else if (msg.t === "error") {
        this.#lastError = safeCode(msg.code)
        this.#logger.warn(`dlp-agent: relay error code=${this.#lastError}`)
      } else {
        safeCloseWs(ws, CLOSE.PROTOCOL_ERROR)
      }
    })
    ws.on("error", (err) => {
      if (this.#ctrl === ws) this.#lastError = describeSocketError(err)
    })
    ws.on("close", (code) => this.#onControlClose(ws, code, registered))
  }

  #onControlClose(ws, code, registered) {
    if (this.#ctrl !== ws) return
    this.#ctrl = null
    this.#clearControlHandshake()
    this.#clearPing()
    if (this.#stopped) return
    if (code === CLOSE.AUTH_FAILED || code === CLOSE.UNSUPPORTED_VERSION) {
      // 签名或版本不被接受：重连不会变好，停下等人处理（§6.7）
      this.#lastError = code === CLOSE.AUTH_FAILED ? "AUTH_FAILED" : "UNSUPPORTED_VERSION"
      this.#logger.warn(`dlp-agent: registration refused code=${code}`)
      this.#stopped = true
      this.#setStatus("error")
      this.#settleStart(new Error(`relay refused registration (${code})`))
      return
    }
    if (registered && this.#now() - this.#registeredAt >= RECONNECT_STABLE_MS) this.#attempt = 0
    let delay
    if (code === CLOSE.REPLACED) {
      // 同一身份在别处连上了（常见于多个 profile 共用 state）：至少 60 秒后再试，避免两边互相顶替
      this.emit("replaced")
      this.#logger.warn("dlp-agent: replaced by another connection with the same host key")
      delay = REPLACED_BACKOFF_MS * (1 + this.#random() * RECONNECT_JITTER)
    } else {
      const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#attempt)
      delay = Math.min(RECONNECT_MAX_MS, base * (1 + (this.#random() * 2 - 1) * RECONNECT_JITTER))
      this.#attempt++
    }
    this.#setStatus("connecting")
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null
      this.#connectControl()
    }, delay)
    this.#reconnectTimer?.unref?.()
  }

  #clearControlHandshake() {
    if (this.#ctrlHandshakeTimer) {
      clearTimeout(this.#ctrlHandshakeTimer)
      this.#ctrlHandshakeTimer = null
    }
  }

  #startPing(ws, seconds) {
    this.#clearPing()
    const pongDeadlineMs = (seconds * 2 + 5) * 1000
    this.#pingTimer = this.#timers.setInterval(() => {
      if (this.#ctrl !== ws || ws.readyState !== WebSocket.OPEN) return
      if (this.#now() - this.#lastPongAt > pongDeadlineMs) {
        this.#lastError = "TIMEOUT"
        this.#logger.warn("dlp-agent: control ping/pong timed out")
        try { ws.terminate() } catch {}
        return
      }
      safeSendWs(ws, encodeControl({ t: "ping" }))
    }, seconds * 1000)
    this.#pingTimer?.unref?.()
  }

  #clearPing() {
    if (this.#pingTimer) this.#timers.clearInterval(this.#pingTimer)
    this.#pingTimer = null
  }

  #clearTimer(which) {
    if (which === "reconnect" && this.#reconnectTimer) {
      this.#timers.clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  #settleStart(error) {
    const waiter = this.#startWaiter
    this.#startWaiter = null
    if (!waiter) return
    if (error) waiter.reject(error)
    else waiter.resolve()
  }

  #setStatus(status) {
    if (this.#status === status) return
    this.#status = status
    this.emit("status", status)
  }

  // ─── open：§5.5 验证 ─────────────────────────────────────────────────────

  #handleOpen(msg) {
    const sid = decodeField(msg.sid, SID_BYTES)
    if (!sid) {
      // 连 sid 都无法解析就无法回 reject；这是 Relay 的协议违规
      safeCloseWs(this.#ctrl, CLOSE.PROTOCOL_ERROR)
      return
    }
    const sidText = b64u(sid)
    if (this.#streams.has(sidText)) {
      // 重复 sid 属于中继协议违规：绝不覆盖活跃流，否则旧流脱管且吊销失效
      safeCloseWs(this.#ctrl, CLOSE.PROTOCOL_ERROR)
      return
    }
    const verdict = this.#verifyOpen(msg.req)
    if (verdict.code) {
      const reject = { t: "reject", sid: sidText, code: verdict.code }
      if (verdict.hostNow !== undefined) reject.hostNow = verdict.hostNow
      safeSendWs(this.#ctrl, encodeControl(reject))
      this.#logger.info(`dlp-agent: open rejected code=${verdict.code}`)
      return
    }
    const rec = {
      sid,
      sidText,
      tag: { ...verdict.tag, sid: sidText },
      limitKey: verdict.limitKey,
      ws: null,
      wsStream: null,
      local: null,
      localPort: null,
      done: false,
      opened: false,
      watchdog: null,
      readyTimer: null,
      flushTimer: null,
    }
    this.#streams.set(sidText, rec)
    this.#acceptStream(rec)
  }

  /** @returns {{ code: string, hostNow?: number } | { code: null, tag: object, limitKey: string }} */
  #verifyOpen(req) {
    // 1. 格式
    const fields = parseClientOpen(req)
    // RFC §5.5（v2.2 定稿）：格式错误回 BAD_MAC，route 不符回 UNKNOWN_KEY，不新增错误码。
    if (!fields) return { code: REJECT.BAD_MAC }
    // 2. route
    if (!fields.route.equals(this.#routeId)) return { code: REJECT.UNKNOWN_KEY }
    // 3. 时间
    const nowSec = Math.floor(this.#now() / 1000)
    if (Math.abs(fields.ts - nowSec) > CLOCK_SKEW_SEC) return { code: REJECT.CLOCK_SKEW, hostNow: nowSec }
    // 4. 取 key
    let key
    let tag
    let limitKey
    let limit
    if (fields.kind === "device") {
      const device = this.#findDevice(fields.key)
      if (!device || typeof device.deviceId !== "string") return { code: REJECT.UNKNOWN_KEY }
      key = deviceRelayKey(this.#keySeed, fields.key)
      tag = { kind: "device", deviceId: device.deviceId, ...(device.selftest ? { selftest: true } : {}) }
      limitKey = `device:${device.deviceId}`
      limit = DEVICE_MAX_STREAMS
    } else {
      const entry = this.#bootstrap.lookup(fields.key)
      if (!entry) return { code: REJECT.BOOTSTRAP_UNKNOWN }
      if (entry.expiresAtMs <= this.#now()) return { code: REJECT.BOOTSTRAP_EXPIRED }
      if (entry.consumed) return { code: REJECT.BOOTSTRAP_USED }
      key = entry.key
      tag = { kind: "bootstrap", bootstrapId: b64u(fields.key) }
      limitKey = `bootstrap:${b64u(fields.key)}`
      limit = BOOTSTRAP_MAX_STREAMS
    }
    // 5. MAC（常量时间比较）
    const expected = clientMac(key, clientTranscript({ route: fields.route, kind: fields.kind, key: fields.key, ts: fields.ts, nonce: fields.nonce }))
    if (!safeEqual(expected, fields.mac)) return { code: REJECT.BAD_MAC }
    // 6. 重放
    const replay = this.#nonces.check(fields.kind, fields.key, fields.nonce, fields.ts, nowSec)
    if (replay) return { code: replay }
    // 7. 容量（正在 accept 的流也计入，防止并发 open 同时越过上限）
    let perIdentity = 0
    for (const rec of this.#streams.values()) if (rec.limitKey === limitKey) perIdentity++
    if (perIdentity >= limit) return { code: REJECT.DEVICE_LIMIT }
    if (this.#streams.size >= HOST_MAX_STREAMS) return { code: REJECT.SERVER_BUSY }
    // 8. 本地服务
    if (!this.#isLocalReady()) return { code: REJECT.LOCAL_UNAVAILABLE }
    return { code: null, tag, limitKey }
  }

  #findDevice(handle) {
    const key = b64u(handle)
    const selftest = this.#selftests.get(key)
    if (selftest) {
      if (selftest.expiresAtMs > this.#now() && selftest.handle.equals(handle)) {
        return { deviceId: "selftest", selftest: true }
      }
      this.#selftests.delete(key)
    }
    return this.#lookupDevice(Buffer.from(handle)) ?? null
  }

  // ─── 数据连接 ────────────────────────────────────────────────────────────

  #acceptStream(rec) {
    // v1 不预热（RFC §10.3 第 5 条）：验证通过后才新建数据连接
    const ws = this.#newSocket()
    rec.ws = ws
    const readyTimer = this.#timers.setTimeout(() => {
      // ready 没来：Relay 那边手机会得到 OPEN_TIMEOUT，这里只收尾
      rec.readyTimer = null
      this.#logger.info("dlp-agent: accept timed out")
      safeCloseWs(ws, CLOSE.NORMAL)
      this.#finishStream(rec)
    }, ACCEPT_READY_TIMEOUT_MS)
    readyTimer?.unref?.()
    rec.readyTimer = readyTimer
    let stage = "hello"
    const sendAccept = (ch) => {
      const sig = signHost(this.#hostPrivKey, acceptTranscript(ch, this.#hostPub, rec.sid))
      safeSendWs(ws, encodeControl({ t: "host_accept", v: DLP_VERSION, pub: b64u(this.#hostPub), sid: rec.sidText, sig: b64u(sig) }))
      stage = "ready"
    }
    const onMessage = (data, isBinary) => {
      if (stage === "data") {
        // 数据阶段只允许二进制（§5.4.4）
        if (!isBinary) safeCloseWs(ws, CLOSE.PROTOCOL_ERROR)
        return
      }
      const msg = isBinary ? null : parseControlFrame(data)
      if (msg?.t === "hello" && stage === "hello") {
        const ch = decodeField(msg.ch, CHALLENGE_BYTES)
        if (msg.v !== DLP_VERSION || !ch) safeCloseWs(ws, CLOSE.PROTOCOL_ERROR)
        else sendAccept(ch)
      } else if (msg?.t === "ready" && stage === "ready") {
        stage = "data"
        if (rec.readyTimer) {
          this.#timers.clearTimeout(rec.readyTimer)
          rec.readyTimer = null
        }
        this.#bridgeLocal(rec)
      } else {
        safeCloseWs(ws, CLOSE.PROTOCOL_ERROR)
      }
    }
    ws.on("message", onMessage)
    ws.on("error", () => {})
    ws.on("close", () => {
      if (rec.readyTimer) {
        this.#timers.clearTimeout(rec.readyTimer)
        rec.readyTimer = null
      }
      this.#finishStream(rec)
    })
  }

  /** ready 之后才连本地（§5.5 第 10 步）。 */
  #bridgeLocal(rec) {
    if (rec.done) return
    const ws = rec.ws
    // 先建 duplex，ready 之后客户端可能立刻发数据；本地连上之前由 duplex 缓冲（满了会暂停 ws）
    const wsStream = createWebSocketStream(ws, { highWaterMark: DATA_CHUNK_BYTES })
    rec.wsStream = wsStream
    wsStream.on("error", () => {})
    const port = this.#pluginPort()
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      safeCloseWs(ws, CLOSE.INTERNAL_ERROR)
      this.#finishStream(rec)
      return
    }
    const local = net.createConnection({ host: "127.0.0.1", port })
    rec.local = local
    let localErrored = false
    local.on("error", () => { localErrored = true })
    local.once("connect", () => {
      if (rec.done) {
        local.destroy()
        return
      }
      // 在转发任何字节之前登记来源（§6.1）
      rec.localPort = local.localPort
      this.#origins.set(local.localPort, { ...rec.tag })
      rec.opened = true
      this.emit("stream-open", publicTag(rec.tag))
      wsStream.pipe(local)
      local.pipe(wsStream)
      this.#startWatchdog(rec)
    })
    local.once("close", (hadError) => {
      if (!rec.opened) {
        // 本地连接失败（§5.5 第 10 步）
        safeCloseWs(ws, CLOSE.INTERNAL_ERROR)
        this.#finishStream(rec)
        return
      }
      if (hadError || localErrored || wsStream.writableFinished || wsStream.destroyed) {
        safeCloseWs(ws, CLOSE.NORMAL)
        this.#finishStream(rec)
        return
      }
      // 正常关闭时等待 wsStream 把最后一段响应字节冲刷到 WAN，防止尾部截断。
      const finishAfterFlush = () => {
        if (rec.flushTimer) {
          this.#timers.clearTimeout(rec.flushTimer)
          rec.flushTimer = null
        }
        safeCloseWs(ws, CLOSE.NORMAL)
        this.#finishStream(rec)
      }
      wsStream.once("finish", finishAfterFlush)
      wsStream.once("close", finishAfterFlush)
      rec.flushTimer = this.#timers.setTimeout(finishAfterFlush, LOCAL_FLUSH_TIMEOUT_MS)
      rec.flushTimer?.unref?.()
    })
  }

  /** 单次写超时 30 秒（RFC §5.8）：任一方向的待写数据 30 秒没有字节进展就关闭这一对。 */
  #startWatchdog(rec) {
    let lastWsPending = 0
    let lastLocalPending = 0
    let lastWsBytes = rec.ws?._socket?.bytesWritten ?? 0
    let lastLocalBytes = rec.local?.bytesWritten ?? 0
    let stalledSince = null
    rec.watchdog = this.#timers.setInterval(() => {
      const wsPending = rec.ws?.bufferedAmount ?? 0
      const localPending = rec.local?.writableLength ?? 0
      const wsBytes = rec.ws?._socket?.bytesWritten ?? lastWsBytes
      const localBytes = rec.local?.bytesWritten ?? lastLocalBytes
      // 有积压时只要累计写出字节增加或积压下降，就说明管道仍在正常流动，不误杀大文件传输。
      const wsStalled = wsPending > 0 && wsBytes === lastWsBytes && wsPending >= lastWsPending
      const localStalled = localPending > 0 && localBytes === lastLocalBytes && localPending >= lastLocalPending
      lastWsPending = wsPending
      lastLocalPending = localPending
      lastWsBytes = wsBytes
      lastLocalBytes = localBytes
      if (!wsStalled && !localStalled) {
        stalledSince = null
        return
      }
      const nowMs = this.#now()
      stalledSince ??= nowMs
      if (nowMs - stalledSince >= WRITE_TIMEOUT_MS) {
        this.#logger.info("dlp-agent: stream write timed out")
        try { rec.ws?.terminate() } catch {}
        this.#finishStream(rec)
      }
    }, WATCHDOG_INTERVAL_MS)
    rec.watchdog?.unref?.()
  }

  #finishStream(rec) {
    if (rec.done) return
    rec.done = true
    if (rec.watchdog) {
      this.#timers.clearInterval(rec.watchdog)
      rec.watchdog = null
    }
    if (rec.readyTimer) {
      this.#timers.clearTimeout(rec.readyTimer)
      rec.readyTimer = null
    }
    if (rec.flushTimer) {
      this.#timers.clearTimeout(rec.flushTimer)
      rec.flushTimer = null
    }
    if (rec.localPort !== null && this.#origins.get(rec.localPort)?.sid === rec.sidText) {
      this.#origins.delete(rec.localPort)
    }
    if (this.#streams.get(rec.sidText) === rec) {
      this.#streams.delete(rec.sidText)
    }
    try { rec.wsStream?.destroy() } catch {}
    rec.local?.destroy()
    safeCloseWs(rec.ws, CLOSE.NORMAL)
    if (rec.opened) this.emit("stream-close", publicTag(rec.tag))
  }

  // ─── 外层连接 ────────────────────────────────────────────────────────────

  #newSocket() {
    const options = { perMessageDeflate: false, maxPayload: MAX_DATA_MESSAGE_BYTES, handshakeTimeout: 10_000 }
    if (this.#outerPin && this.#endpoint.startsWith("wss:")) {
      const pin = this.#outerPin
      // 显式 outerPin：跳过 CA 与主机名，改为只认这张叶证书；在 secureConnect 阶段、Upgrade 之前比对
      options.createConnection = (opts) => {
        const socket = tls.connect({
          ...opts,
          path: undefined,
          servername: net.isIP(opts.host) ? "" : opts.servername ?? opts.host,
          rejectUnauthorized: false,
        })
        socket.once("secureConnect", () => {
          const raw = socket.getPeerCertificate()?.raw
          const fp = raw ? createHash("sha256").update(raw).digest("hex") : ""
          if (fp !== pin) socket.destroy(new Error("outer certificate pin mismatch"))
        })
        return socket
      }
    }
    return new WebSocket(this.#endpoint, options)
  }
}

function parseClientOpen(req) {
  if (!req || typeof req !== "object" || Array.isArray(req)) return null
  if (req.v !== DLP_VERSION) return null
  if (req.kind !== "device" && req.kind !== "bootstrap") return null
  if (!Number.isSafeInteger(req.ts) || req.ts < 0) return null
  const route = decodeField(req.route, ROUTE_BYTES)
  const key = decodeField(req.key, KEY_BYTES)
  const nonce = decodeField(req.nonce, NONCE_BYTES)
  const mac = decodeField(req.mac, MAC_BYTES)
  if (!route || !key || !nonce || !mac) return null
  return { kind: req.kind, route, key, ts: req.ts, nonce, mac }
}

function decodeField(value, length) {
  try {
    return unb64u(value, length)
  } catch {
    return null
  }
}

/**
 * 外层连接失败的简短原因。只取 Node 错误码或已知的几类消息：
 * ws 的 message 可能带完整 URL，虽不含秘密，也没必要原样进面板。
 */
function describeSocketError(err) {
  const code = typeof err?.code === "string" ? err.code : ""
  if (/^[A-Z0-9_]{2,40}$/.test(code)) return code
  const message = String(err?.message ?? "")
  if (/pin mismatch/i.test(message)) return "OUTER_PIN_MISMATCH"
  const status = /Unexpected server response: (\d{3})/.exec(message)
  if (status) return `HTTP_${status[1]}`
  if (/timed out/i.test(message)) return "TIMEOUT"
  return "CONNECT_FAILED"
}

function publicTag(tag) {
  return { kind: tag.kind, ...(tag.deviceId ? { deviceId: tag.deviceId } : {}) }
}

function waitForHello(ws) {
  return waitForControl(ws, "hello", FIRST_MESSAGE_TIMEOUT_MS)
}

function waitForControl(ws, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`timeout waiting for ${type}`)), timeoutMs)
    timer.unref?.()
    const onMessage = (data, isBinary) => {
      const msg = isBinary ? null : parseControlFrame(data)
      if (msg?.t === type) finish(null, msg)
      else finish(new Error(`unexpected message while waiting for ${type}`))
    }
    const onClose = () => finish(new Error(`closed while waiting for ${type}`))
    const finish = (error, msg) => {
      clearTimeout(timer)
      ws.off("message", onMessage)
      ws.off("close", onClose)
      if (error) reject(error)
      else resolve(msg)
    }
    ws.on("message", onMessage)
    ws.on("close", onClose)
    ws.on("error", () => {})
  })
}

function closeAndWait(ws, code) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    const timer = setTimeout(() => {
      ws.terminate()
      resolve()
    }, 2_000)
    timer.unref?.()
    ws.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
    else ws.close(code)
  })
}
