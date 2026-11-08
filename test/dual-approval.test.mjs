import { test } from "node:test"
import assert from "node:assert/strict"
import { hasLiveMobileDevice } from "../src/index.js"

test("手机端在线判定：会话 SSE 或后台主机事件流任一存在就算在线", () => {
  const empty = { sessionStreams: new Map() }
  assert.equal(hasLiveMobileDevice(empty, 0), false)
  assert.equal(hasLiveMobileDevice(empty, 1), true)

  const withViewer = { sessionStreams: new Map([["s1", new Set([{ deviceId: "dev-1" }])]]) }
  assert.equal(hasLiveMobileDevice(withViewer, 0), true)

  // 空集合等于没在看（退订后集合会留着，但 size 为 0）。
  const stale = { sessionStreams: new Map([["s1", new Set()]]) }
  assert.equal(hasLiveMobileDevice(stale, 0), false)

  // 兜底：运行时对象缺字段时不要抛。
  assert.equal(hasLiveMobileDevice(undefined, 0), false)
})
