/**
 * 主机级会话状态 SSE。DSH 没有全局会话事件，只在有订阅者时对 session.list 做差分。
 * 事件只有会话级状态，不带消息正文和工具参数。
 */
import { SSE_MAX_BACKLOG_BYTES } from "./stream-cursor.js"

const ACTIVE = new Set(["running", "awaitingApproval", "awaitingInput"])
const DEFAULT_BUFFER_LIMIT = 200
const MAX_TERMINAL_CACHE = 512
const TERMINAL_REASON_CONCURRENCY = 4

export function isActiveHostState(state) {
  return ACTIVE.has(state)
}

export function normalizeHostOrigin(origin) {
  if (origin === "subagent" || origin === "schedule") return origin
  return "user"
}

/** 结束原因映射到通知用的终态。没有原因视为正常完成。 */
export function terminalHostState(stoppedReason) {
  if (stoppedReason === "error") return "failed"
  if (stoppedReason && stoppedReason !== "completed") return "stopped"
  return "completed"
}

export function classifyHostSession(row) {
  const sessionId = typeof row?.sessionId === "string" ? row.sessionId : ""
  const title = typeof row?.title === "string" && row.title.trim() ? row.title.trim() : "未命名会话"
  const origin = normalizeHostOrigin(row?.origin)
  let state
  if (row?.running && row?.pendingApproval) state = "awaitingApproval"
  else if (row?.running && (row?.pendingQuestion || row?.awaitingInput)) state = "awaitingInput"
  else if (row?.running) state = "running"
  else state = terminalHostState(row?.stoppedReason)
  // 双端审批：待办审批带上请求 id，App 后台就能直接弹出可操作的审批通知，
  // 而不是只提示「请在电脑上处理」。没有挂起审批时不带这个键，事件形状保持不变。
  const approvalId = state === "awaitingApproval" && typeof row?.pendingApprovalId === "string" && row.pendingApprovalId
    ? row.pendingApprovalId
    : null
  const approvalToolName = approvalId && typeof row?.pendingApprovalToolName === "string" && row.pendingApprovalToolName
    ? row.pendingApprovalToolName.slice(0, 64)
    : null
  // 审批的具体工作内容（命令原文等）：手机上只给选项等于盲批。
  const approvalDetail = approvalId && typeof row?.pendingApprovalDetail === "string" && row.pendingApprovalDetail
    ? row.pendingApprovalDetail.slice(0, 600)
    : null
  // 双端澄清：等待回答时带上请求 id 与题干，App 后台通知才能说清「在问什么」，
  // 点开会话后请求快照会把整张澄清卡补回。
  const questionId = state === "awaitingInput" && typeof row?.pendingQuestionId === "string" && row.pendingQuestionId
    ? row.pendingQuestionId
    : null
  const questionText = questionId && typeof row?.pendingQuestionText === "string" && row.pendingQuestionText
    ? row.pendingQuestionText.slice(0, 200)
    : null
  return {
    sessionId,
    state,
    title,
    origin,
    ...(approvalId ? { approvalId } : {}),
    ...(approvalToolName ? { approvalToolName } : {}),
    ...(approvalDetail ? { approvalDetail } : {}),
    ...(questionId ? { questionId } : {}),
    ...(questionText ? { questionText } : {}),
  }
}

/**
 * previous / next 都是 Map<sessionId, classified>。
 * 第一次快照只报仍在进行的会话，避免把历史里已结束的会话刷一遍。
 */
export function diffHostSessions(previous, next, { initial = false } = {}) {
  const events = []
  const seen = new Set()
  for (const [id, row] of next) {
    if (!id) continue
    seen.add(id)
    const prev = previous.get(id)
    if (!prev) {
      if (initial && !isActiveHostState(row.state)) continue
      events.push({ ...row })
      continue
    }
    if (prev.state !== row.state || prev.title !== row.title || prev.origin !== row.origin
      || prev.approvalId !== row.approvalId || prev.approvalToolName !== row.approvalToolName
      || prev.approvalDetail !== row.approvalDetail
      || prev.questionId !== row.questionId || prev.questionText !== row.questionText) {
      events.push({ ...row })
    }
  }
  for (const [id, prev] of previous) {
    if (seen.has(id) || !isActiveHostState(prev.state)) continue
    events.push({ sessionId: id, state: "stopped", title: prev.title, origin: prev.origin })
  }
  return events
}

export function hostEventFrame(event) {
  return `id: ${event.seq}\nevent: session/state\ndata: ${JSON.stringify({
    type: "session/state",
    sessionId: event.sessionId,
    state: event.state,
    title: event.title,
    origin: event.origin,
    seq: event.seq,
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    ...(event.approvalToolName ? { approvalToolName: event.approvalToolName } : {}),
    ...(event.approvalDetail ? { approvalDetail: event.approvalDetail } : {}),
    ...(event.questionId ? { questionId: event.questionId } : {}),
    ...(event.questionText ? { questionText: event.questionText } : {}),
    // F2：终态事件是否值得推一条通知。缺失/true 时按老行为推送；
    // false 表示「同一个会话刚刚已经报过终态」——自动重试里的瞬时失败、
    // 或轮询抖动导致的重复终态，别让手机再响一次。
    ...(event.notify === false ? { notify: false } : {}),
  })}\n\n`
}

export function heartbeatFrame() {
  return "event: heartbeat\ndata: {}\n\n"
}

export function resyncFrame(afterSeq) {
  return `event: resync-required\ndata: ${JSON.stringify({ reason: "gap", afterSeq })}\n\n`
}

function eventsAfter(buffer, seq, lastEventId) {
  const id = Number(lastEventId)
  if (!Number.isFinite(id) || id <= 0) return { resync: false, caughtUp: false, events: [] }
  if (id > seq) return { resync: true, caughtUp: false, events: [] }
  if (id === seq) return { resync: false, caughtUp: true, events: [] }
  if (buffer.length === 0 || buffer[0].seq > id + 1) return { resync: true, caughtUp: false, events: [] }
  return { resync: false, caughtUp: false, events: buffer.filter((event) => event.seq > id) }
}

/**
 * @param {{
 *   listSessions: () => Promise<Array<object>>,
 *   terminalReason?: (sessionId: string) => Promise<string|null>,
 *   setIntervalFn?: Function,
 *   clearIntervalFn?: Function,
 *   pollMs?: number,
 *   heartbeatMs?: number,
 * }} options
 */
export function createHostEventHub({
  listSessions,
  terminalReason = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  pollMs = 5_000,
  heartbeatMs = 25_000,
  bufferLimit = DEFAULT_BUFFER_LIMIT,
  // 同一会话的终态在这么长时间内重复出现时，不再建议推送通知（F2，参考 dsh-meow-smooth 的
  // 「自动重试中的瞬时错误不打扰、每条恰好一条」）。只影响 notify 提示，事件照发，UI 不会漏状态。
  notificationWindowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const subscribers = new Set()
  let previous = new Map()
  let seq = 0
  const buffer = []
  let pollTimer = null
  let heartTimer = null
  let inflight = false
  // sessionId → { state, at }：上一次已经「值得通知」的终态
  const lastNotifiedTerminal = new Map()

  function remember(event) {
    buffer.push(event)
    if (buffer.length > bufferLimit) buffer.shift()
  }

  function writeOne(conn, frame) {
    try {
      const ok = conn.res.write(frame)
      if (ok === false && (conn.res.writableLength ?? 0) > SSE_MAX_BACKLOG_BYTES) drop(conn)
    } catch {
      drop(conn)
    }
  }

  function writeAll(frame) {
    for (const conn of [...subscribers]) writeOne(conn, frame)
  }

  function writeSnapshot(conn) {
    for (const row of previous.values()) {
      if (!row.event || !isActiveHostState(row.state)) continue
      writeOne(conn, hostEventFrame(row.event))
    }
  }

  function drop(conn) {
    subscribers.delete(conn)
    try { conn.res.destroy() } catch {}
    stopTimersIfIdle()
  }

  function startTimers() {
    if (!pollTimer) {
      pollTimer = setIntervalFn(() => { poll().catch(() => {}) }, pollMs)
      pollTimer?.unref?.()
    }
    if (!heartTimer) {
      heartTimer = setIntervalFn(() => heartbeat(), heartbeatMs)
      heartTimer?.unref?.()
    }
  }

  function stopTimersIfIdle() {
    if (subscribers.size > 0) return
    if (pollTimer) clearIntervalFn(pollTimer)
    if (heartTimer) clearIntervalFn(heartTimer)
    pollTimer = null
    heartTimer = null
  }

  function heartbeat() {
    if (subscribers.size === 0) return
    writeAll(heartbeatFrame())
  }

  async function poll() {
    if (subscribers.size === 0 || inflight) return { polled: false }
    inflight = true
    try {
      const rows = await listSessions()
      const next = new Map()
      const asOfBySession = new Map()
      for (const row of rows ?? []) {
        const classified = classifyHostSession(row)
        if (!classified.sessionId) continue
        next.set(classified.sessionId, classified)
        if (Number.isInteger(row?.asOfSeq)) asOfBySession.set(classified.sessionId, row.asOfSeq)
      }
      const initial = previous.size === 0
      const changes = diffHostSessions(previous, next, { initial })
      if (terminalReason) {
        const needReason = changes.filter((change) => {
          const prev = previous.get(change.sessionId)
          return change.state === "completed" && prev && isActiveHostState(prev.state)
        })
        if (needReason.length > 0) {
          let idx = 0
          const worker = async () => {
            while (idx < needReason.length) {
              const change = needReason[idx++]
              try {
                const asOf = asOfBySession.get(change.sessionId)
                change.state = terminalHostState(await terminalReason(change.sessionId, asOf))
              } catch {
                // 读不到结束原因就保持 completed
              }
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(TERMINAL_REASON_CONCURRENCY, needReason.length) }, () => worker()),
          )
        }
      }
      // F2：终态去重。会话跑完 → 自动重试又失败 → 再跑完，这种抖动会在几分钟内
      // 连推好几条通知；同一个会话在 notificationWindowMs 内重复同一种终态就标 notify:false。
      const at = now()
      for (const [id, entry] of lastNotifiedTerminal) {
        if (at - entry.at >= notificationWindowMs) lastNotifiedTerminal.delete(id)
      }
      for (const change of changes) {
        // 注意：会话回到 running 时不能清掉记录——「失败→自动重试→又失败」正是要压的场景，
        // 清理只会让第二次失败再响一次。过期由 notificationWindowMs 负责。
        if (isActiveHostState(change.state)) continue
        const last = lastNotifiedTerminal.get(change.sessionId)
        if (last && last.state === change.state && at - last.at < notificationWindowMs) {
          change.notify = false
        } else {
          lastNotifiedTerminal.delete(change.sessionId)
          lastNotifiedTerminal.set(change.sessionId, { state: change.state, at })
          while (lastNotifiedTerminal.size > MAX_TERMINAL_CACHE) {
            const first = lastNotifiedTerminal.keys().next()
            if (first.done) break
            lastNotifiedTerminal.delete(first.value)
          }
        }
      }
      const stamped = []
      for (const change of changes) {
        seq += 1
        const event = { type: "session/state", ...change, seq }
        remember(event)
        const stored = next.get(change.sessionId) ?? { ...change }
        stored.event = event
        stored.state = change.state
        next.set(change.sessionId, stored)
        stamped.push(event)
      }
      for (const [id, row] of next) {
        if (!row.event && previous.get(id)?.event) row.event = previous.get(id).event
      }
      previous = next
      for (const event of stamped) writeAll(hostEventFrame(event))
      return { polled: true, emitted: stamped.length }
    } finally {
      inflight = false
    }
  }

  function subscribe(res, lastEventId) {
    const conn = { res }
    const first = subscribers.size === 0
    subscribers.add(conn)
    if (first) startTimers()
    const replay = eventsAfter(buffer, seq, lastEventId)
    if (replay.resync) {
      writeOne(conn, resyncFrame(Number(lastEventId) || 0))
      writeSnapshot(conn)
    } else if (replay.events.length > 0) {
      for (const event of replay.events) writeOne(conn, hostEventFrame(event))
    } else if (!replay.caughtUp) {
      writeSnapshot(conn)
    }
    if (first) poll().catch(() => {})
    return () => {
      subscribers.delete(conn)
      stopTimersIfIdle()
    }
  }

  function stop() {
    for (const conn of [...subscribers]) {
      try { conn.res.end() } catch {}
    }
    subscribers.clear()
    previous.clear()
    buffer.length = 0
    lastNotifiedTerminal.clear()
    stopTimersIfIdle()
  }

  return {
    subscribe,
    poll,
    heartbeat,
    stop,
    get subscriberCount() { return subscribers.size },
    get polling() { return pollTimer != null },
  }
}

/**
 * 续传游标。浏览器 EventSource 只能带 Last-Event-ID 头；有些客户端（以及对
 * 代理/中间层不信任的场景）拿不到自定义头，就用 ?since=<seq>。两处都按正整数解析，
 * 非法值一律当「没有游标」，让订阅从快照开始而不是从 0 号事件开始乱补。
 */
export function parseHostCursor(value) {
  const raw = String(value ?? "").trim()
  if (!/^\d{1,12}$/.test(raw)) return null
  const seq = Number(raw)
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null
}

export function handleHostEvents(req, res, hub) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.flushHeaders?.()
  try { res.socket?.setNoDelay?.(true) } catch {}
  let since = null
  try {
    since = parseHostCursor(new URL(req?.url ?? "/", "http://localhost").searchParams.get("since"))
  } catch {
    since = null
  }
  const cursor = since ?? parseHostCursor(req?.headers?.["last-event-id"])
  const unsubscribe = hub.subscribe(res, cursor != null ? String(cursor) : null)
  res.on("close", unsubscribe)
  res.on("error", unsubscribe)
}
