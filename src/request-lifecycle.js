/**
 * 审批 / 澄清请求生命周期：与 SSE socket 分离，终态只写一次，
 * 断线给有限重连宽限，吊销与插件退出立即结束。
 */
import { RECONNECT_GRACE_MS } from "./protocol-caps.js"

export { RECONNECT_GRACE_MS }
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 手机端这一刻没连着（没有会话订阅、也没有后台事件流）时的兜底等待。
 *
 * 双端审批总是先建手机端记录，否则「电脑端开着会话、手机只是没订阅」就会整体交回电脑端，
 * 手机端事后打开会话也看不到这条待办。但没人连着时也不该把一轮工具调用卡满
 * {@link APPROVAL_TIMEOUT_MS}：电脑端明确表示没人应答（`unavailable`）之后，再给手机端
 * 这么长一段重连窗口，仍没等到就按「无人应答」结束。
 */
export const APPROVAL_OFFLINE_GRACE_MS = 30 * 1000
export const MAX_TERMINAL_RESULTS = 256
export const TERMINAL_TTL_MS = 10 * 60 * 1000
export const APPROVAL_OUTCOMES = new Set(["allowed-once", "rejected", "cancelled", "unavailable"])

export function remainingMs(rec, now) {
  return Math.max(0, (rec?.deadlineAt ?? now) - now)
}

export function graceDurationMs(rec, now, grace = RECONNECT_GRACE_MS) {
  return Math.min(grace, remainingMs(rec, now))
}

export function canDeviceHandle(rec, { deviceId, authorized, subscribed }) {
  if (!rec || !deviceId || !authorized) return false
  if (subscribed) return true
  // 双端审批：从后台通知直接作答的设备并没有订阅这个会话（也没有重连宽限），
  // 但它是这次审批的候选设备之一、且已通过设备令牌鉴权，让它答；其他设备照样拒。
  return Boolean(rec.eligibleDeviceIds?.has(deviceId))
}

/** 请求 ID 可能来自另一个会话；终态幂等响应也必须绑定 URL 会话。 */
export function requestBelongsToSession(request, sessionId) {
  return Boolean(request?.sessionId) && request.sessionId === sessionId
}

/**
 * 双端审批（2026-11-09 用户要求「双端同时推送、先答先算」）。
 *
 * 电脑端是同一个 waterfall 的下游：插件把请求交给它之后，只有网页真的接了这个会话
 * 才会给出 allowed-once / rejected。`unavailable` 是「没有应答者」、`cancelled` 是
 * 「网页端撤销了这次提问」，两者都不代表用户做了决定——不能拿来抢答，否则网页没打开
 * 该会话时手机端会被瞬间判成无人应答。
 */
export function desktopApprovalDecided(outcome) {
  return outcome === "allowed-once" || outcome === "rejected"
}

export function mapApprovalUiStatus(outcome) {
  if (!outcome) return "pending"
  if (outcome === "allowed-once" || outcome === "rejected") return "resolved"
  if (outcome === "cancelled") return "cancelled"
  if (outcome === "unavailable") return "expired"
  return "unknown"
}

export function createRequestRegistry({
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const pendingApprovals = new Map()
  const pendingQuestions = new Map()
  const terminalResults = new Map()
  const graceTimers = new Map()

  function pruneTerminal(at = now()) {
    for (const [id, rec] of terminalResults) {
      if (at - rec.at > TERMINAL_TTL_MS) terminalResults.delete(id)
    }
    while (terminalResults.size > MAX_TERMINAL_RESULTS) {
      const first = terminalResults.keys().next()
      if (first.done) break
      terminalResults.delete(first.value)
    }
  }

  function rememberTerminal(rec, outcome, extra = {}) {
    const result = {
      id: rec.id,
      type: rec.type,
      sessionId: rec.sessionId,
      outcome,
      status: rec.type === "approval" ? mapApprovalUiStatus(outcome) : (outcome ? "resolved" : "cancelled"),
      at: now(),
      ...extra,
    }
    terminalResults.set(rec.id, result)
    pruneTerminal()
    return result
  }

  function clearTimers(rec) {
    if (rec?.timer) {
      clearTimeoutFn(rec.timer)
      rec.timer = null
    }
    if (rec?.graceTimer) {
      clearTimeoutFn(rec.graceTimer)
      rec.graceTimer = null
    }
    try { rec.signal?.removeEventListener?.("abort", rec.onAbort) } catch {}
  }

  function finishApproval(rec, outcome) {
    if (!rec || rec.settled) return rec?.terminal ?? null
    rec.settled = true
    pendingApprovals.delete(rec.id)
    clearTimers(rec)
    if (rec.sessionId && pendingForSession(rec.sessionId).length === 0) clearGrace(rec.sessionId)
    const resolved = APPROVAL_OUTCOMES.has(outcome) ? outcome : "unavailable"
    const terminal = rememberTerminal(rec, resolved)
    rec.terminal = terminal
    try { rec.settle(resolved) } catch {}
    return terminal
  }

  function finishQuestion(rec, answer) {
    if (!rec || rec.settled) return rec?.terminal ?? null
    rec.settled = true
    pendingQuestions.delete(rec.id)
    clearTimers(rec)
    if (rec.sessionId && pendingForSession(rec.sessionId).length === 0) clearGrace(rec.sessionId)
    const ok = Boolean(answer && Array.isArray(answer.answers))
    const terminal = rememberTerminal(rec, ok ? "answered" : "cancelled", ok ? { answer } : {})
    rec.terminal = terminal
    try { rec.settle(ok ? answer : null) } catch {}
    return terminal
  }

  function pendingForSession(sessionId) {
    return [
      ...pendingApprovals.values(),
      ...pendingQuestions.values(),
    ].filter((rec) => rec.sessionId === sessionId)
  }

  function addEligible(sessionId, deviceId) {
    if (!sessionId || !deviceId) return
    for (const rec of pendingForSession(sessionId)) rec.eligibleDeviceIds.add(deviceId)
  }

  function removeEligible(sessionId, deviceId) {
    for (const rec of pendingForSession(sessionId)) rec.eligibleDeviceIds.delete(deviceId)
  }

  function clearGrace(sessionId) {
    const timer = graceTimers.get(sessionId)
    if (timer) clearTimeoutFn(timer)
    graceTimers.delete(sessionId)
  }

  function settleSession(sessionId, { approvalOutcome = "cancelled" } = {}) {
    clearGrace(sessionId)
    for (const rec of [...pendingApprovals.values()]) {
      if (rec.sessionId === sessionId) finishApproval(rec, approvalOutcome)
    }
    for (const rec of [...pendingQuestions.values()]) {
      if (rec.sessionId === sessionId) finishQuestion(rec, null)
    }
  }

  function scheduleGrace(sessionId, onExpire) {
    if (graceTimers.has(sessionId)) return
    const recs = pendingForSession(sessionId)
    if (recs.length === 0) return
    const wait = Math.min(...recs.map((rec) => graceDurationMs(rec, now())))
    if (wait <= 0) {
      onExpire(sessionId)
      return
    }
    const timer = setTimeoutFn(() => {
      graceTimers.delete(sessionId)
      onExpire(sessionId)
    }, wait)
    timer?.unref?.()
    graceTimers.set(sessionId, timer)
  }

  function inGrace(sessionId) {
    return graceTimers.has(sessionId)
  }

  function snapshot(sessionId) {
    pruneTerminal()
    const approvals = []
    const questions = []
    for (const rec of pendingApprovals.values()) {
      if (rec.sessionId !== sessionId) continue
      approvals.push({
        approvalId: rec.id,
        status: "pending",
        outcome: null,
        sessionId,
        createdAt: rec.createdAt,
        deadlineAt: rec.deadlineAt,
        callId: rec.callId ?? null,
        toolName: rec.toolName ?? null,
        // 手机上的审批栏要显示「在跑什么命令」，只给工具名等于让人盲批。
        detail: rec.detail ?? null,
        headline: rec.headline ?? null,
        reason: rec.reason ?? null,
        riskLevel: rec.riskLevel === "high" ? "high" : null,
        riskReason: rec.riskLevel === "high" ? (rec.riskReason ?? null) : null,
      })
    }
    for (const rec of pendingQuestions.values()) {
      if (rec.sessionId !== sessionId) continue
      questions.push({
        rpcId: rec.id,
        status: "pending",
        sessionId,
        createdAt: rec.createdAt,
        deadlineAt: rec.deadlineAt,
        questions: rec.questions ?? [],
      })
    }
    for (const rec of terminalResults.values()) {
      if (rec.sessionId !== sessionId) continue
      if (rec.type === "approval") {
        approvals.push({
          approvalId: rec.id,
          status: rec.status,
          outcome: rec.outcome,
          sessionId,
          createdAt: rec.at,
          deadlineAt: rec.at,
        })
      } else {
        questions.push({
          rpcId: rec.id,
          status: rec.status,
          sessionId,
          createdAt: rec.at,
          deadlineAt: rec.at,
        })
      }
    }
    return { approvals, questions, graceActive: inGrace(sessionId) }
  }

  function disposeAll(outcome = "cancelled") {
    for (const sessionId of [...graceTimers.keys()]) clearGrace(sessionId)
    for (const rec of [...pendingApprovals.values()]) finishApproval(rec, outcome)
    for (const rec of [...pendingQuestions.values()]) finishQuestion(rec, null)
    pendingApprovals.clear()
    pendingQuestions.clear()
    terminalResults.clear()
  }

  return {
    pendingApprovals,
    pendingQuestions,
    terminalResults,
    graceTimers,
    addEligible,
    removeEligible,
    clearGrace,
    scheduleGrace,
    inGrace,
    settleSession,
    finishApproval,
    finishQuestion,
    rememberTerminal,
    snapshot,
    disposeAll,
    pruneTerminal,
    pendingForSession,
    addApproval(rec) {
      pendingApprovals.set(rec.id, rec)
    },
    addQuestion(rec) {
      pendingQuestions.set(rec.id, rec)
    },
    getApproval(id) {
      return pendingApprovals.get(id) ?? null
    },
    getQuestion(id) {
      return pendingQuestions.get(id) ?? null
    },
    getTerminal(id) {
      pruneTerminal()
      return terminalResults.get(id) ?? null
    },
  }
}
