/**
 * F2：终态通知提示（notify）。
 *
 * 场景：会话跑完 → 自动重试又失败 → 再跑完，同一会话在几分钟内连推几条通知。
 * 插件不替手机做决定，但会在 SSE 帧里标 `notify: false`：
 * 「这个终态刚刚报过，别再响一次」。事件本身照发，UI 不会漏状态。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { createHostEventHub } from "../src/host-events.js"

function row(overrides = {}) {
  return {
    sessionId: "s1",
    title: "跑迁移",
    origin: "user",
    running: true,
    pendingApproval: false,
    pendingQuestion: false,
    awaitingInput: false,
    stoppedReason: null,
    ...overrides,
  }
}

function collectHub(rowsRef, { now } = {}) {
  const chunks = []
  const hub = createHostEventHub({
    listSessions: async () => rowsRef.rows,
    setIntervalFn: () => ({ id: 1 }),
    clearIntervalFn: () => {},
    notificationWindowMs: 60_000,
    ...(now ? { now } : {}),
  })
  const res = { write(frame) { chunks.push(frame); return true }, destroy() {} }
  const unsubscribe = hub.subscribe(res, null)
  return { hub, chunks, unsubscribe }
}

function lastEvent(chunks) {
  const frame = chunks.at(-1) ?? ""
  const data = frame.split("data: ")[1]
  return data ? JSON.parse(data) : null
}

test("同一会话重复终态在窗口内标 notify:false，过了窗口再恢复", async () => {
  let clock = 1_000_000
  const rowsRef = { rows: [row()] }
  const { hub, chunks } = collectHub(rowsRef, { now: () => clock })

  await hub.poll() // 首个快照：running
  assert.equal(lastEvent(chunks).state, "running")
  assert.equal("notify" in lastEvent(chunks), false)

  rowsRef.rows = [row({ running: false, stoppedReason: "error" })]
  clock += 5_000
  await hub.poll()
  const first = lastEvent(chunks)
  assert.equal(first.state, "failed")
  assert.equal("notify" in first, false, "第一次失败要正常通知")

  // 自动重试又跑起来，再失败：窗口内 → 不再建议通知
  rowsRef.rows = [row()]
  clock += 2_000
  await hub.poll()
  assert.equal(lastEvent(chunks).state, "running")

  rowsRef.rows = [row({ running: false, stoppedReason: "error" })]
  clock += 3_000
  await hub.poll()
  const second = lastEvent(chunks)
  assert.equal(second.state, "failed")
  assert.equal(second.notify, false)

  // 换一种终态（failed → completed）不是重复，照常通知
  rowsRef.rows = [row()]
  clock += 1_000
  await hub.poll()
  rowsRef.rows = [row({ running: false, stoppedReason: "completed" })]
  clock += 1_000
  await hub.poll()
  assert.equal("notify" in lastEvent(chunks), false)

  // 过了窗口，同一个终态重新值得通知
  rowsRef.rows = [row()]
  clock += 1_000
  await hub.poll()
  rowsRef.rows = [row({ running: false, stoppedReason: "completed" })]
  clock += 61_000
  await hub.poll()
  assert.equal(lastEvent(chunks).state, "completed")
  assert.equal("notify" in lastEvent(chunks), false)
})

test("两个会话互不影响：各自第一次终态都通知", async () => {
  let clock = 2_000_000
  const rowsRef = {
    rows: [row({ sessionId: "a", title: "A" }), row({ sessionId: "b", title: "B" })],
  }
  const { hub, chunks } = collectHub(rowsRef, { now: () => clock })
  await hub.poll()

  rowsRef.rows = [
    row({ sessionId: "a", title: "A", running: false, stoppedReason: "error" }),
    row({ sessionId: "b", title: "B", running: false, stoppedReason: "error" }),
  ]
  clock += 4_000
  await hub.poll()
  const terminal = chunks
    .map((frame) => JSON.parse(frame.split("data: ")[1]))
    .filter((event) => event.state === "failed")
  assert.equal(terminal.length, 2)
  assert.ok(terminal.every((event) => event.notify !== false), "两台不同会话各自第一次失败都要通知")
})
