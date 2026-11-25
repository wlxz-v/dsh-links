/**
 * 插件全量梳理优化回归门禁：
 * 覆盖 P0/P1 修复（V3/V4 活动推导、负缓存、zstd 流式防炸弹、历史投影、定价、
 * 澄清校验、SSE 截断与游标超前、主机事件重启同步、探针错误分类、诊断多会话与防 500、
 * 预览代理安全加固、异步工作区读写、panel.js ↔ client.js IIFE 同步）。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { zstdCompressSync } from "node:zlib"

import { deriveActivity, deriveLastResult } from "../src/mobile-session-activity.js"
import { attachSessionActivity } from "../src/mobile-api.js"
import { decompressZstdFrames } from "../src/zstd-frames.js"
import { projectHistoryPage } from "../src/history.js"
import { priceFromHostModel, modelIdFromProjections } from "../src/pricing.js"
import { normalizeQuestions, validateAnswers } from "../src/question-answers.js"
import { loadEventsAfter } from "../src/stream-cursor.js"
import { createHostEventHub } from "../src/host-events.js"
import { createHostProbe } from "../src/host-probe.js"
import { approvalHeadline } from "../src/approval-detail.js"
import { setBounded } from "../src/bounded-map.js"
import { negotiateJsonEncoding, safeDecodeUriComponent } from "../src/http-utils.js"
import { classifyListenHost, runDiagnostics } from "../src/diagnostics.js"
import { forwardPreviewHeaders, matchPreviewPath, previewPortProblem } from "../src/preview-proxy.js"
import { extractDevServerPorts } from "../src/preview-detect.js"
import { listWorkspaceDirAsync, readWorkspaceFileAsync } from "../src/workspace-file.js"
import { ensureMobileWorkspaceDirectory } from "../src/workspace-create.js"
import { writeFileAtomicSync } from "../src/atomic-fs.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test("deriveActivity：识别 DSH V3/V4 tool/result 关闭工具，且 turn/end 清空残留工具", () => {
  const v4Events = [
    { event: { seq: 1, time: 100, type: "tool/call", data: { callId: "c1", name: "shell", arguments: { command: "npm test" } } } },
    { event: { seq: 2, time: 200, type: "tool/result", data: { message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }] } } } },
    { event: { seq: 3, time: 300, type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "done" } } } },
  ]
  assert.deepEqual(deriveActivity(v4Events), { kind: "writing", startedAt: 300 })

  const v3Events = [
    { event: { seq: 1, time: 100, type: "tool/call", data: { callId: "c2", name: "shell", arguments: { command: "ls" } } } },
    { event: { seq: 2, time: 200, type: "tool/result", data: { message: { role: "user", source: { callId: "c2" }, content: [{ type: "tool-result", toolCallId: "c2", content: [] }] } } } },
  ]
  assert.equal(deriveActivity(v3Events), null)

  const staleAcrossTurn = [
    { event: { seq: 1, time: 100, type: "tool/call", data: { callId: "c3", name: "shell", arguments: { command: "sleep" } } } },
    { event: { seq: 2, time: 200, type: "turn/end", data: { reason: { kind: "interrupted" } } } },
  ]
  assert.equal(deriveActivity(staleAcrossTurn), null)
})

test("deriveLastResult：新一轮 user/message 清空上一轮的 workspace/changes", () => {
  const events = [
    { event: { seq: 1, time: 10, type: "workspace/changes", data: { turn: 1 } } },
    { event: { seq: 2, time: 20, type: "user/message", data: { content: [{ type: "text", text: "hi" }] } } },
    { event: { seq: 3, time: 30, type: "assistant/message", data: { message: { content: [{ type: "text", text: "纯文本回复" }] } } } },
  ]
  const res = deriveLastResult(events, () => ({ turn: 1, total: 5, added: 10, deleted: 2, files: [{ path: "a.js" }] }))
  assert.deepEqual(res, { text: "纯文本回复" })
})

test("attachSessionActivity：非 running 无结果会话也负缓存，避免重复拉历史", async () => {
  const rt = { sessionActivityCache: new Map() }
  let reads = 0
  const readEvents = async () => { reads += 1; return [] }
  await attachSessionActivity(rt, 0, [{ sessionId: "blank", updatedAt: 42, running: false }], { readEvents, changesService: null })
  await attachSessionActivity(rt, 0, [{ sessionId: "blank", updatedAt: 42, running: false }], { readEvents, changesService: null })
  assert.equal(reads, 1)
})

test("zstd-frames：单帧超限在流式解码阶段即拦截，不缓完整帧", async () => {
  const big = Buffer.alloc(64 * 1024, 0x41)
  const compressed = zstdCompressSync(big)
  await assert.rejects(
    () => decompressZstdFrames(compressed, { maxOutputBytes: 4096 }),
    /exceeds 4096 bytes/,
  )
})

test("history：文件补全思考带 kind=reasoning，被剥空的 block-end 正确结束 running 并回填", () => {
  const reasoningBySeq = new Map([[2, { seq: 2, time: 20, text: "补回来的思考" }]])
  const events = [
    { event: { seq: 1, time: 10, type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", text: "补回" } } } },
    { event: { seq: 2, time: 20, type: "assistant/chunk", data: { chunk: { type: "block-end", block: { type: "reasoning", text: "" } } } } },
    { event: { seq: 3, time: 30, type: "assistant/message", data: { message: { content: [{ type: "text", text: "答案" }] } } } },
  ]
  const page = projectHistoryPage({ events, reasoningBySeq })
  const r = page.messages.find((m) => m.role === "reasoning")
  assert.equal(r.kind, "reasoning")
  assert.equal(r.text, "补回来的思考")
  assert.equal(r.running, undefined)

  // 纯文件回填路径也必须带 kind="reasoning"
  const page2 = projectHistoryPage({
    events: [
      { event: { seq: 1, time: 10, type: "user/message", data: { content: [{ type: "text", text: "问" }] } } },
      { event: { seq: 3, time: 30, type: "assistant/message", data: { message: { content: [{ type: "text", text: "答" }] } } } },
    ],
    reasoningBySeq,
  })
  const backfilled = page2.messages.find((m) => m.role === "reasoning")
  assert.equal(backfilled.kind, "reasoning")
})

test("pricing：null/空串不当成 0 美元价格，空 next 对象回退 active", () => {
  assert.equal(
    priceFromHostModel({ pricing: { cacheHitPerMillion: null, cacheMissPerMillion: 0.5, outputPerMillion: 1, currency: "USD" } }),
    null,
  )
  assert.equal(
    priceFromHostModel({ pricing: { cacheHitPerMillion: "", cacheMissPerMillion: 0.5, outputPerMillion: 1, currency: "USD" } }),
    null,
  )
  assert.equal(
    modelIdFromProjections({ modelSelection: { next: {}, active: { model: "deepseek-v4-pro" } } }),
    "deepseek-v4-pro",
  )
})

test("question-answers：拒绝文本题传 selected、重复/未知题号，去重多选", () => {
  const { questions } = normalizeQuestions([
    { id: "t1", question: "输入备注" },
    { id: "m1", question: "多选", multiple: true, options: ["a", "b"] },
  ])
  assert.equal(
    validateAnswers(questions, { answers: [{ id: "t1", selected: ["x".repeat(100)] }, { id: "m1", selected: ["a"] }] }).code,
    "invalid-option",
  )
  assert.equal(
    validateAnswers(questions, { answers: [{ id: "t1", custom: "ok" }, { id: "t1", custom: "dup" }] }).code,
    "duplicate-answer",
  )
  assert.equal(
    validateAnswers(questions, { answers: [{ id: "t1", custom: "ok" }, { id: "unknown", selected: ["a"] }] }).code,
    "unknown-answer",
  )
  const dedup = validateAnswers(questions, {
    answers: [{ id: "t1", custom: "ok" }, { id: "m1", selected: ["a", "a", "b", ""] }],
  })
  assert.equal(dedup.ok, true)
  assert.deepEqual(dedup.answer.answers[1].selected, ["a", "b"])
})

test("stream-cursor：升序页截断保留最新连续尾部，游标超前触发 cursor-ahead", async () => {
  const pages = [
    { events: Array.from({ length: 50 }, (_, i) => ({ event: { seq: 51 + i, type: "x", time: i, data: {} } })), hasMore: true },
    { events: Array.from({ length: 50 }, (_, i) => ({ event: { seq: 1 + i, type: "x", time: i, data: {} } })), hasMore: false },
  ]
  let idx = 0
  const batch = await loadEventsAfter(0, async () => pages[idx++], { maxEvents: 60 })
  assert.equal(batch.complete, false)
  assert.equal(batch.events[0].seq, 41)
  assert.equal(batch.events.at(-1).seq, 100)
  assert.equal(batch.events.length, 60)

  const ahead = await loadEventsAfter(500, async () => ({
    events: [{ event: { seq: 10, type: "x", time: 10, data: {} } }],
    hasMore: false,
  }))
  assert.equal(ahead.complete, false)
  assert.equal(ahead.reason, "cursor-ahead")
})

test("host-events：主机重启后 id > seq 触发 resync，id === seq 不重复推送活跃快照", async () => {
  const hub = createHostEventHub({
    listSessions: async () => [{ sessionId: "s1", title: "任务", origin: "user", running: true }],
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  })
  const c1 = []
  const unsub1 = hub.subscribe({ write(f) { c1.push(f); return true }, destroy() {} }, null)
  await new Promise((r) => setImmediate(r))
  assert.equal(c1.length, 1)

  const caughtUp = []
  const unsub2 = hub.subscribe({ write(f) { caughtUp.push(f); return true }, destroy() {} }, "1")
  assert.equal(caughtUp.length, 0)

  const restarted = []
  const unsub3 = hub.subscribe({ write(f) { restarted.push(f); return true }, destroy() {} }, "99")
  assert.match(restarted.join(""), /event: resync-required/)

  unsub1(); unsub2(); unsub3(); hub.stop()
})

test("host-probe：传输/鉴权故障判 unknown 而非误报 supported", async () => {
  const probe = createHostProbe({
    probes: [{ id: "a", params: {} }, { id: "b", params: {} }],
    call: async (method) => {
      const err = new Error(method === "a" ? "connect ECONNREFUSED" : "unauthorized")
      err.code = method === "a" ? "ECONNREFUSED" : "gateway/unauthorized"
      throw err
    },
  })
  const summary = await probe.refresh()
  assert.deepEqual(summary.supported, [])
  assert.deepEqual(summary.unknown, ["a", "b"])
})

test("approval-detail / bounded-map / http-utils：边界安全", () => {
  const hugeName = "x".repeat(200)
  const headline = approvalHeadline(hugeName, "secret command line that must not leak back")
  assert.equal(headline, hugeName)

  const m = new Map()
  setBounded(m, undefined, 1, 2)
  setBounded(m, "a", 2, 2)
  setBounded(m, "b", 3, 2)
  assert.equal(m.size, 2)
  assert.equal(m.has(undefined), false)

  assert.equal(negotiateJsonEncoding("gzip;q=1.0, br;q=0.5", 4096), "gzip")
  assert.equal(safeDecodeUriComponent("%E0%A4%A"), null)
  assert.equal(safeDecodeUriComponent("abc%201"), "abc 1")
})

test("diagnostics：多会话 viewers 保留、INVALID_TOKEN 不 500、链路本地不误报公网", async () => {
  assert.equal(classifyListenHost("fe80::1%12"), null)
  assert.equal(classifyListenHost("169.254.1.2"), null)
  assert.equal(classifyListenHost("fdb1:1234::1"), "private")
  assert.equal(classifyListenHost("::ffff:192.168.1.5"), "private")

  const report = await runDiagnostics({
    rpc: async () => {
      const err = new Error("bad")
      err.code = "INVALID_TOKEN"
      throw err
    },
    services: { workspaceChanges: true, typertGateway: true, sessions: true },
    plugin: { version: "0.1.0-beta.20", protocol: 2, capabilities: {} },
    tls: { fingerprint: "a".repeat(64), notAfterMs: Date.now() + 90 * 86400_000 },
    devices: [{ deviceId: "d1" }],
    listenHosts: ["192.168.1.10", "fe80::1", "169.254.10.2"],
    streams: {
      hostEvents: 1,
      sessions: [
        { id: "s111111111", viewers: 1 },
        { id: "s222222222", viewers: 2 },
      ],
    },
    remote: { enabled: false, state: "off" },
  }, { scope: "panel" })
  const streamsCheck = report.checks.find((c) => c.id === "mobile.streams")
  assert.equal(streamsCheck.detail.viewers, "s1111111_1.s2222222_2")
  const rpcCheck = report.checks.find((c) => c.id === "host.rpc")
  assert.equal(rpcCheck.code, "HOST_RPC_FAILED")
  assert.equal(rpcCheck.detail.errorCode, undefined)
})

test("preview-proxy / preview-detect：剥离 Cookie、封禁调试端口、支持 IPv6 与句末句号", () => {
  const h = forwardPreviewHeaders({ cookie: "sid=1", "set-cookie": "a=b", "content-type": "text/plain" }, 5173)
  assert.equal(h.cookie, undefined)
  assert.equal(h["set-cookie"], undefined)
  assert.equal(matchPreviewPath(`//evil.com/dsh-link/mobile/preview/${"ab".repeat(12)}/`), null)
  assert.equal(previewPortProblem(9222, {}), "这个端口不能预览")
  assert.equal(previewPortProblem(9229, {}), "这个端口不能预览")
  assert.equal(previewPortProblem(2375, {}), "这个端口不能预览")
  assert.deepEqual(extractDevServerPorts("ready on http://[::1]:5173/ and http://localhost:3000."), [5173, 3000])
})

test("workspace-file / workspace-create / atomic-fs：异步读写、拒绝同名符号链接、原子写入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-hardening-"))
  try {
    const file = join(dir, "hello.txt")
    writeFileAtomicSync(file, "world")
    const read = await readWorkspaceFileAsync(dir, "hello.txt")
    assert.equal(read.body.toString("utf8"), "world")
    const listed = await listWorkspaceDirAsync(dir, "")
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.entries[0].name, "hello.txt")

    const outside = mkdtempSync(join(tmpdir(), "dsh-outside-"))
    try {
      const linkPath = join(dir, "escaped-link")
      let linked = false
      try {
        symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir")
        linked = true
      } catch {}
      if (linked) {
        await assert.rejects(
          () => ensureMobileWorkspaceDirectory({ path: linkPath, shouldCreateDirectory: true }),
          /符号链接/,
        )
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("panel.js 与 client.js 保持同步，且 client.js 包裹在 IIFE 内可重复求值", () => {
  const panel = readFileSync(join(ROOT, "src", "panel.js"), "utf8").replace(/\r\n/g, "\n")
  const client = readFileSync(join(ROOT, "src", "client.js"), "utf8").replace(/\r\n/g, "\n")
  assert.ok(client.includes(";(() => {\n"), "client.js 应使用 IIFE 隔离作用域")
  assert.ok(client.includes(panel), "src/client.js 已落后于 src/panel.js，请运行 npm run build:client")
  assert.ok(panel.includes("'host.probe'"), "panel.js 应包含 host.probe 诊断文案")
  assert.ok(panel.includes("'mobile.streams'"), "panel.js 应包含 mobile.streams 诊断文案")
})
