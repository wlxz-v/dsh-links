import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createRequestRegistry,
  canDeviceHandle,
  desktopApprovalDecided,
  graceDurationMs,
  mapApprovalUiStatus,
  APPROVAL_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  requestBelongsToSession,
} from "../src/request-lifecycle.js"

function pending({ id = "a1", sessionId = "s1", type = "approval", now = 1_000, extra = {} } = {}) {
  let settled = null
  const rec = {
    id,
    sessionId,
    type,
    createdAt: now,
    deadlineAt: now + APPROVAL_TIMEOUT_MS,
    eligibleDeviceIds: new Set(["dev-1"]),
    settled: false,
    settle(outcome) { settled = outcome },
    ...extra,
  }
  return { rec, getOutcome: () => settled }
}

test("断线宽限不超过剩余期限且不重置总超时", () => {
  const rec = pending({ now: 0 }).rec
  rec.deadlineAt = 20_000
  assert.equal(graceDurationMs(rec, 0, RECONNECT_GRACE_MS), 20_000)
  rec.deadlineAt = 5 * 60 * 1000
  assert.equal(graceDurationMs(rec, 0, RECONNECT_GRACE_MS), RECONNECT_GRACE_MS)
})

test("宽限内原设备可处理，吊销后立即拒绝", () => {
  const { rec } = pending()
  assert.equal(canDeviceHandle(rec, { deviceId: "dev-1", authorized: true, subscribed: false, inGrace: true }), true)
  assert.equal(canDeviceHandle(rec, { deviceId: "dev-1", authorized: false, subscribed: false, inGrace: true }), false)
  assert.equal(canDeviceHandle(rec, { deviceId: "dev-2", authorized: true, subscribed: false, inGrace: true }), false)
  assert.equal(canDeviceHandle(rec, { deviceId: "dev-1", authorized: true, subscribed: true, inGrace: false }), true)
})

test("双端审批：已配对设备没订阅、没宽限也能作答（后台通知直接批准）", () => {
  const { rec } = pending()
  assert.equal(canDeviceHandle(rec, { deviceId: "dev-1", authorized: true, subscribed: false, inGrace: false }), true)
  // 没进候选集合的设备照样拒。
  assert.equal(canDeviceHandle(rec, { deviceId: "dev-9", authorized: true, subscribed: false, inGrace: false }), false)
  // 电脑端只有明确答复才算定案；unavailable / cancelled 让手机端继续等。
  assert.equal(desktopApprovalDecided("allowed-once"), true)
  assert.equal(desktopApprovalDecided("rejected"), true)
  assert.equal(desktopApprovalDecided("unavailable"), false)
  assert.equal(desktopApprovalDecided("cancelled"), false)
  assert.equal(desktopApprovalDecided(undefined), false)
})

test("终态幂等响应仍绑定原会话", () => {
  const terminal = { id: "a1", sessionId: "s1", type: "approval" }
  assert.equal(requestBelongsToSession(terminal, "s1"), true)
  assert.equal(requestBelongsToSession(terminal, "s2"), false)
  assert.equal(requestBelongsToSession({ id: "a1", type: "approval" }, "s1"), false)
})

test("终态只 settle 一次，重试返回已记录结果", () => {
  const timers = []
  const registry = createRequestRegistry({
    now: () => 1_000,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms }
      timers.push(handle)
      return handle
    },
    clearTimeoutFn: () => {},
  })
  const { rec, getOutcome } = pending()
  registry.addApproval(rec)
  const first = registry.finishApproval(rec, "allowed-once")
  const second = registry.finishApproval(rec, "rejected")
  assert.equal(first.outcome, "allowed-once")
  assert.equal(second.outcome, "allowed-once")
  assert.equal(getOutcome(), "allowed-once")
  assert.equal(registry.getTerminal("a1").outcome, "allowed-once")
  assert.equal(mapApprovalUiStatus("allowed-once"), "resolved")
})

test("无订阅者时进入宽限，到期后只结束一次", () => {
  const timers = []
  const registry = createRequestRegistry({
    now: () => 1_000,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms, id: timers.length }
      timers.push(handle)
      return handle
    },
    clearTimeoutFn: (handle) => {
      handle.cleared = true
    },
  })
  const { rec, getOutcome } = pending()
  registry.addApproval(rec)
  let expired = 0
  registry.scheduleGrace("s1", () => {
    expired++
    registry.settleSession("s1")
  })
  assert.equal(timers.length, 1)
  assert.equal(registry.inGrace("s1"), true)
  registry.addEligible("s1", "dev-1")
  registry.clearGrace("s1")
  assert.equal(timers[0].cleared, true)
  registry.scheduleGrace("s1", () => {
    expired++
    registry.settleSession("s1")
  })
  timers.at(-1).fn()
  assert.equal(expired, 1)
  assert.equal(getOutcome(), "cancelled")
  registry.settleSession("s1")
  assert.equal(getOutcome(), "cancelled")
})

test("插件退出立即失效，不能把内存回调假装可恢复", () => {
  const registry = createRequestRegistry({ now: () => 1_000, setTimeoutFn: () => ({}), clearTimeoutFn: () => {} })
  const { rec, getOutcome } = pending()
  registry.addApproval(rec)
  registry.disposeAll("cancelled")
  assert.equal(getOutcome(), "cancelled")
  assert.equal(registry.getApproval("a1"), null)
})

test("snapshot 含 pending 澄清题目与审批元数据", () => {
  const registry = createRequestRegistry({ now: () => 1_000, setTimeoutFn: () => ({}), clearTimeoutFn: () => {} })
  registry.addApproval({
    id: "ap-1",
    sessionId: "s1",
    type: "approval",
    createdAt: 1_000,
    deadlineAt: 1_000 + APPROVAL_TIMEOUT_MS,
    eligibleDeviceIds: new Set(),
    settled: false,
    settle() {},
    callId: "c-1",
    toolName: "bash",
  })
  registry.addQuestion({
    id: "q-1",
    sessionId: "s1",
    type: "question",
    createdAt: 1_000,
    deadlineAt: 1_000 + APPROVAL_TIMEOUT_MS,
    eligibleDeviceIds: new Set(),
    settled: false,
    settle() {},
    questions: [{ id: "q1", question: "选一个", options: [{ id: "a", label: "A" }] }],
  })
  const snap = registry.snapshot("s1")
  assert.equal(snap.approvals[0].toolName, "bash")
  assert.equal(snap.approvals[0].callId, "c-1")
  assert.equal(snap.questions[0].questions[0].id, "q1")
  assert.equal(snap.questions[0].questions[0].question, "选一个")
})

test("snapshot 的审批带 detail/headline/reason：手机决策栏不只剩两个按钮", () => {
  const registry = createRequestRegistry({ now: () => 1_000, setTimeoutFn: () => ({}), clearTimeoutFn: () => {} })
  registry.addApproval({
    id: "ap-2",
    sessionId: "s1",
    type: "approval",
    createdAt: 1_000,
    deadlineAt: 1_000 + APPROVAL_TIMEOUT_MS,
    eligibleDeviceIds: new Set(),
    settled: false,
    settle() {},
    toolName: "pwsh",
    reason: "escalate sandbox to danger-full-access",
    detail: "Remove-Item -Recurse build",
    headline: "pwsh · Remove-Item -Recurse build",
  })
  const rec = registry.snapshot("s1").approvals[0]
  assert.equal(rec.detail, "Remove-Item -Recurse build")
  assert.equal(rec.headline, "pwsh · Remove-Item -Recurse build")
  assert.equal(rec.reason, "escalate sandbox to danger-full-access")

  // 拿不到命令时字段为 null，客户端据此显示「看不到参数」，而不是空串冒充内容。
  registry.addApproval({
    id: "ap-3",
    sessionId: "s2",
    type: "approval",
    createdAt: 1_000,
    deadlineAt: 1_000 + APPROVAL_TIMEOUT_MS,
    eligibleDeviceIds: new Set(),
    settled: false,
    settle() {},
    toolName: "bash",
  })
  const bare = registry.snapshot("s2").approvals[0]
  assert.equal(bare.detail, null)
  assert.equal(bare.headline, null)
  assert.equal(bare.reason, null)
})
