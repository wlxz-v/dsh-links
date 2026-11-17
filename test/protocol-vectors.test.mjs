/**
 * 协议契约：spec/protocol-vectors.json 是插件与 Android 共用的线上帧定义。
 * 这里校验插件自己发出的帧与它一致（Android 侧 ProtocolVectorsTest.kt 读同一份文件）。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { hostEventFrame, resyncFrame } from "../src/host-events.js"
import { pluginCapabilities } from "../src/protocol-caps.js"
import { createRequestRegistry } from "../src/request-lifecycle.js"

const spec = JSON.parse(readFileSync(new URL("../spec/protocol-vectors.json", import.meta.url), "utf8"))

function frameData(text) {
  const dataLine = String(text).split("\n").find((line) => line.startsWith("data:"))
  assert.ok(dataLine, "帧里没有 data 行")
  return JSON.parse(dataLine.slice("data:".length).trim())
}

function keysOf(object) {
  return Object.keys(object).sort()
}

test("protocol vectors: 文件结构完整，required 都是 data 里真有的键", () => {
  assert.equal(spec.version, 1)
  assert.ok(Array.isArray(spec.frames) && spec.frames.length > 0)
  for (const frame of spec.frames) {
    assert.ok(frame.name && frame.event, "帧要有名字与事件名")
    assert.ok(Array.isArray(frame.required), `${frame.name} 缺 required`)
    const optional = frame.optional ?? []
    for (const key of frame.required) {
      assert.ok(key in frame.data, `${frame.name} 的 required 键 ${key} 不在 data 里`)
    }
    for (const key of Object.keys(frame.data)) {
      assert.ok(
        frame.required.includes(key) || optional.includes(key),
        `${frame.name} 的 ${key} 既不在 required 也不在 optional`,
      )
    }
  }
})

test("protocol vectors: session/state 帧与 hostEventFrame 输出逐键一致", () => {
  for (const vector of spec.frames.filter((item) => item.event === "session/state")) {
    const event = { ...vector.data, seq: vector.data.seq }
    const data = frameData(hostEventFrame(event))
    assert.deepEqual(keysOf(data), keysOf(vector.data), vector.name)
    for (const key of Object.keys(vector.data)) {
      assert.deepEqual(data[key], vector.data[key], `${vector.name} 的 ${key}`)
    }
  }
})

test("protocol vectors: resync-required 帧形状一致", () => {
  const vector = spec.frames.find((item) => item.event === "resync-required")
  assert.ok(vector)
  const data = frameData(resyncFrame(vector.data.afterSeq))
  assert.deepEqual(data, vector.data)
})

test("protocol vectors: 能力声明包含 spec 里承诺的每一项", () => {
  const caps = pluginCapabilities({ changes: true, host: { v: 1, checkedAt: 1, missing: [], unknown: [] } })
  assert.equal(caps.protocol, spec.protocol)
  assert.equal(caps.events.host, spec.plugin.events.host)
  assert.equal(caps.events.since, spec.plugin.events.since)
  assert.equal(caps.questions.multi, spec.plugin.questions.multi)
  assert.equal(caps.requests.snapshot, spec.plugin.requests.snapshot)
  assert.equal(caps.files.workspace, spec.plugin.files.workspace)
  assert.equal(caps.diagnostics.v, spec.plugin.diagnostics.v)
})

test("protocol vectors: /requests 快照的审批与澄清条目字段一致", () => {
  const registry = createRequestRegistry({ now: () => 1_700_000_000_000 })
  registry.addApproval({
    id: "ap-1",
    sessionId: "s-1",
    toolName: "pwsh",
    callId: "call-1",
    createdAt: 1_700_000_000_000,
    deadlineAt: 1_700_000_300_000,
    detail: "pnpm test",
    headline: "pnpm test",
    reason: "escalate",
  })
  registry.addQuestion({
    id: "q-1",
    sessionId: "s-1",
    createdAt: 1_700_000_000_000,
    deadlineAt: 1_700_000_300_000,
    questions: [{ id: "q1", header: "安装位置", question: "装到哪个目录？", options: [{ id: "a", label: "D:/apps" }] }],
  })
  // 手机 API 路由在快照外面补 version（见 src/mobile-api.js），这里照它的形状拼。
  const snapshot = { version: 1, ...registry.snapshot("s-1") }
  for (const key of spec.snapshot.required) assert.ok(key in snapshot, `快照缺 ${key}`)

  const approval = snapshot.approvals.find((item) => item.approvalId === "ap-1")
  assert.ok(approval, "快照里没有待审批条目")
  const approvalKeys = [...spec.snapshot.approval.required, ...spec.snapshot.approval.optional]
  for (const key of approvalKeys) assert.ok(key in approval, `审批条目缺 ${key}`)

  const question = snapshot.questions.find((item) => item.rpcId === "q-1")
  assert.ok(question, "快照里没有待回答条目")
  const questionKeys = [...spec.snapshot.question.required, ...spec.snapshot.question.optional]
  for (const key of questionKeys) assert.ok(key in question, `澄清条目缺 ${key}`)
})
