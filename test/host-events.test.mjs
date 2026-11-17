import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyHostSession,
  createHostEventHub,
  diffHostSessions,
  handleHostEvents,
  hostEventFrame,
  parseHostCursor,
  terminalHostState,
} from "../src/host-events.js"

function row(overrides) {
  return {
    sessionId: "s1",
    title: "修登录",
    origin: "user",
    running: true,
    pendingApproval: false,
    pendingQuestion: false,
    awaitingInput: false,
    stoppedReason: null,
    ...overrides,
  }
}

test("差分只报状态变化，不带工具参数", () => {
  const running = classifyHostSession(row({ arguments: "rm -rf /", command: "secret" }))
  assert.deepEqual(Object.keys(running).sort(), ["origin", "sessionId", "state", "title"])
  assert.equal(running.state, "running")
  const approval = classifyHostSession(row({ pendingApproval: true, pendingQuestion: true }))
  assert.equal(approval.state, "awaitingApproval")
  const question = classifyHostSession(row({ pendingQuestion: true }))
  assert.equal(question.state, "awaitingInput")
  const done = classifyHostSession(row({ running: false }))
  assert.equal(done.state, "completed")
  assert.equal(terminalHostState("error"), "failed")
  assert.equal(terminalHostState("interrupted"), "stopped")
  assert.equal(classifyHostSession(row({ origin: "schedule" })).origin, "schedule")
  assert.equal(classifyHostSession(row({ origin: "fork" })).origin, "user")

  const prev = new Map([["s1", running]])
  assert.equal(diffHostSessions(prev, prev).length, 0)
  const next = new Map([["s1", approval]])
  const changed = diffHostSessions(prev, next)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].state, "awaitingApproval")
  assert.equal("arguments" in changed[0], false)
})

test("第一次快照不回放已经结束的会话", () => {
  const next = new Map([
    ["live", classifyHostSession(row({ sessionId: "live" }))],
    ["old", classifyHostSession(row({ sessionId: "old", running: false }))],
  ])
  const initial = diffHostSessions(new Map(), next, { initial: true })
  assert.deepEqual(initial.map((event) => event.sessionId), ["live"])
  const later = diffHostSessions(new Map(), next, { initial: false })
  assert.equal(later.length, 2)
})

test("没有订阅者时不轮询，断线后续传", async () => {
  const calls = []
  let rows = [row()]
  const timers = []
  const hub = createHostEventHub({
    listSessions: async () => {
      calls.push("list")
      return rows
    },
    terminalReason: async () => "error",
    setIntervalFn: (fn, ms) => {
      timers.push({ fn, ms })
      return { id: timers.length }
    },
    clearIntervalFn: (id) => { timers.push({ cleared: id }) },
    bufferLimit: 1,
  })
  const missed = await hub.poll()
  assert.equal(missed.polled, false)
  assert.equal(calls.length, 0)
  assert.equal(hub.polling, false)

  const chunks = []
  const res = {
    write(frame) { chunks.push(frame); return true },
    destroy() {},
  }
  const unsubscribe = hub.subscribe(res, null)
  assert.equal(hub.subscriberCount, 1)
  assert.equal(hub.polling, true)
  assert.deepEqual(timers.map((timer) => timer.ms), [5_000, 25_000])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.match(chunks[0], /"state":"running"/)
  assert.match(chunks[0], /"type":"session\/state"/)
  assert.equal(chunks[0].includes("arguments"), false)
  const firstId = chunks[0].match(/^id: (\d+)/)[1]

  chunks.length = 0
  rows = [row({ running: false })]
  await hub.poll()
  assert.match(chunks[0], /"state":"failed"/)

  const replayed = []
  const res2 = { write(frame) { replayed.push(frame); return true }, destroy() {} }
  const unsubscribe2 = hub.subscribe(res2, firstId)
  assert.equal(replayed.length, 1)
  assert.match(replayed[0], /"state":"failed"/)
  assert.match(replayed[0], new RegExp(`^id: ${Number(firstId) + 1}`))

  rows = [row({ title: "又开始了" })]
  await hub.poll()
  const expired = []
  const res3 = { write(frame) { expired.push(frame); return true }, destroy() {} }
  const unsubscribe3 = hub.subscribe(res3, "1")
  assert.match(expired.join(""), /resync-required/)

  unsubscribe()
  unsubscribe2()
  unsubscribe3()
  assert.equal(hub.subscriberCount, 0)
  assert.equal(hub.polling, false)
  const before = calls.length
  await hub.poll()
  assert.equal(calls.length, before)
})

test("事件帧带 seq，心跳不带会话内容", () => {
  const frame = hostEventFrame({
    seq: 4,
    sessionId: "s1",
    state: "running",
    title: "修登录",
    origin: "user",
  })
  assert.match(frame, /^id: 4\nevent: session\/state\n/)
  const body = JSON.parse(frame.split("data: ")[1])
  assert.deepEqual(body, {
    type: "session/state",
    sessionId: "s1",
    state: "running",
    title: "修登录",
    origin: "user",
    seq: 4,
  })
})

test("待审批事件带 approvalId：App 后台通知可以直接作答（双端审批）", () => {
  const approval = classifyHostSession(row({
    pendingApproval: true,
    pendingApprovalId: "ap-123",
    pendingApprovalToolName: "pwsh",
  }))
  assert.deepEqual(approval, {
    sessionId: "s1",
    state: "awaitingApproval",
    title: "修登录",
    origin: "user",
    approvalId: "ap-123",
    approvalToolName: "pwsh",
  })
  const frame = hostEventFrame({ ...approval, seq: 7 })
  const body = JSON.parse(frame.split("data: ")[1])
  assert.equal(body.approvalId, "ap-123")
  assert.equal(body.approvalToolName, "pwsh")

  // 换了一条审批（id 不同）也要算变化，否则手机还留着上一条的通知。
  const prev = new Map([["s1", approval]])
  const next = new Map([["s1", classifyHostSession(row({
    pendingApproval: true,
    pendingApprovalId: "ap-456",
    pendingApprovalToolName: "pwsh",
  }))]])
  const changed = diffHostSessions(prev, next)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].approvalId, "ap-456")

  // 没有挂起审批时事件形状不变（工具名只随审批出现）。
  assert.deepEqual(Object.keys(classifyHostSession(row())).sort(), ["origin", "sessionId", "state", "title"])
})

test("待审批事件带 approvalDetail：通知栏/决策栏看得见要跑什么", () => {
  const approval = classifyHostSession(row({
    pendingApproval: true,
    pendingApprovalId: "ap-777",
    pendingApprovalToolName: "pwsh",
    pendingApprovalDetail: "Remove-Item -Recurse build",
  }))
  assert.equal(approval.approvalDetail, "Remove-Item -Recurse build")
  const body = JSON.parse(hostEventFrame({ ...approval, seq: 9 }).split("data: ")[1])
  assert.equal(body.approvalDetail, "Remove-Item -Recurse build")

  // 同一审批的工作内容变了（例如回填历史后才拿到命令）也要推一次，否则手机停在「看不到参数」。
  const prev = new Map([["s1", classifyHostSession(row({
    pendingApproval: true,
    pendingApprovalId: "ap-777",
    pendingApprovalToolName: "pwsh",
  }))]])
  const next = new Map([["s1", approval]])
  const changed = diffHostSessions(prev, next)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].approvalDetail, "Remove-Item -Recurse build")

  // 没有工作内容时不出这个键（老客户端看到的帧形状不变）。
  const bare = classifyHostSession(row({ pendingApproval: true, pendingApprovalId: "ap-1", pendingApprovalToolName: "pwsh" }))
  assert.equal("approvalDetail" in bare, false)
})

test("待回答的澄清带 questionId 与题干：多题依次选择也能推到手机（双端澄清）", () => {
  const asking = classifyHostSession(row({
    pendingQuestion: true,
    pendingQuestionId: "q-abc123",
    pendingQuestionText: "先选哪种数据库？",
  }))
  assert.deepEqual(asking, {
    sessionId: "s1",
    state: "awaitingInput",
    title: "修登录",
    origin: "user",
    questionId: "q-abc123",
    questionText: "先选哪种数据库？",
  })
  const frame = hostEventFrame({ ...asking, seq: 11 })
  const body = JSON.parse(frame.split("data: ")[1])
  assert.equal(body.state, "awaitingInput")
  assert.equal(body.questionId, "q-abc123")
  assert.equal(body.questionText, "先选哪种数据库？")

  // 题面变了（换下一题）要再推一次，通知栏才不会停在上一题。
  const prev = new Map([["s1", asking]])
  const next = new Map([["s1", classifyHostSession(row({
    pendingQuestion: true,
    pendingQuestionId: "q-abc123",
    pendingQuestionText: "那用哪个缓存？",
  }))]])
  const changed = diffHostSessions(prev, next)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].questionText, "那用哪个缓存？")

  // 只是「等待输入」但没有澄清请求（例如等用户敲字）时不带这两个键。
  const waiting = classifyHostSession(row({ awaitingInput: true }))
  assert.equal("questionId" in waiting, false)
  assert.equal("questionText" in waiting, false)
})

function sseResponse() {
  const chunks = []
  const handlers = new Map()
  return {
    chunks,
    writeHead() {},
    flushHeaders() {},
    socket: { setNoDelay() {} },
    write(frame) { chunks.push(frame); return true },
    on(name, fn) { handlers.set(name, fn) },
    destroy() {},
    end() {},
    close() { handlers.get("close")?.() },
  }
}

test("?since= 与 Last-Event-ID 等价：断线期间的事件按游标补发", async () => {
  let rows = [row({ sessionId: "s1" })]
  const hub = createHostEventHub({
    listSessions: async () => rows,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    bufferLimit: 20,
  })
  const first = sseResponse()
  handleHostEvents({ url: "/dsh-link/mobile/events", headers: {} }, first, hub)
  await new Promise((resolve) => setImmediate(resolve))
  const firstId = Number(first.chunks.join("").match(/id: (\d+)/)[1])

  // 还连着的时候产生第二条事件；随后断线，断线期间的事件要靠游标补回来。
  rows = [row({ sessionId: "s1", running: false })]
  await hub.poll()
  first.close()
  assert.equal(hub.subscriberCount, 0)

  // 用查询参数续传：只补游标之后的事件，不重复快照。
  const byQuery = sseResponse()
  handleHostEvents({ url: `/dsh-link/mobile/events?since=${firstId}`, headers: {} }, byQuery, hub)
  assert.match(byQuery.chunks.join(""), /"state":"completed"/)
  assert.equal(byQuery.chunks.filter((chunk) => chunk.includes("session/state")).length, 1)
  byQuery.close()

  // 头部写法等价。
  const byHeader = sseResponse()
  handleHostEvents({ url: "/dsh-link/mobile/events", headers: { "last-event-id": String(firstId) } }, byHeader, hub)
  assert.match(byHeader.chunks.join(""), /"state":"completed"/)
  byHeader.close()

  // 非法游标当没有游标：不回放旧事件（此时也没有活跃会话，快照为空），更不会 resync 风暴。
  const garbage = sseResponse()
  handleHostEvents({ url: "/dsh-link/mobile/events?since=abc", headers: {} }, garbage, hub)
  assert.equal(garbage.chunks.join(""), "")
  garbage.close()

  assert.equal(parseHostCursor("12"), 12)
  assert.equal(parseHostCursor("0"), null)
  assert.equal(parseHostCursor("-1"), null)
  assert.equal(parseHostCursor("1.5"), null)
  hub.stop()
})
