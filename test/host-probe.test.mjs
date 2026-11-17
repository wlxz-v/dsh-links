import assert from "node:assert/strict"
import test from "node:test"
import { HOST_PROBES, createHostProbe } from "../src/host-probe.js"

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test("host probe: 全部调通时标记 supported，checkedAt 有值", async () => {
  const calls = []
  const probe = createHostProbe({
    call: async (method, params) => {
      calls.push({ method, params })
      return {}
    },
    now: () => 1234,
  })
  const summary = await probe.refresh()
  assert.equal(summary.checkedAt, 1234)
  assert.deepEqual(summary.missing, [])
  assert.deepEqual(summary.unknown, [])
  assert.equal(summary.supported.length, HOST_PROBES.length)
  assert.equal(calls.length, HOST_PROBES.length)
  // 写方法用不存在的 id 探测：只带 id 与 action，不会碰到真实记录。
  const edit = calls.find((call) => call.method === "schedule.edit")
  assert.deepEqual(edit.params, { id: "probe-missing", action: "delete" })
})

test("host probe: 只有 gateway/method-unavailable 判 missing，业务错误算支持", async () => {
  const probe = createHostProbe({
    call: async (method) => {
      if (method === "agentPreset.list") {
        const error = new Error("no such remote")
        error.code = "gateway/method-unavailable"
        throw error
      }
      if (method === "schedule.edit") {
        const error = new Error("schedule not found")
        error.code = "schedule/not-found"
        throw error
      }
      return {}
    },
  })
  const summary = await probe.refresh()
  assert.deepEqual(summary.missing, ["agentPreset.list"])
  assert.equal(summary.supported.includes("schedule.edit"), true)
})

test("host probe: 超时算 unknown，不当成宿主不支持", async () => {
  const probe = createHostProbe({
    timeoutMs: 20,
    call: (method) => (method === "llm.listProviders" ? new Promise(() => {}) : Promise.resolve({})),
  })
  const summary = await probe.refresh()
  assert.deepEqual(summary.unknown, ["llm.listProviders"])
  assert.deepEqual(summary.missing, [])
})

test("host probe: TTL 内复用结论，force 才重新探测", async () => {
  let count = 0
  let clock = 0
  const probe = createHostProbe({
    call: async () => {
      count += 1
      return {}
    },
    now: () => clock,
    ttlMs: 1000,
  })
  await probe.refresh()
  const first = count
  await probe.refresh()
  assert.equal(count, first)
  clock = 2000
  await probe.refresh()
  assert.equal(count, first * 2)
  await probe.refresh({ force: true })
  assert.equal(count, first * 3)
})

test("host probe: 并发不超过上限", async () => {
  let active = 0
  let peak = 0
  const gate = deferred()
  const probe = createHostProbe({
    concurrency: 2,
    call: async () => {
      active += 1
      peak = Math.max(peak, active)
      await gate.promise
      active -= 1
      return {}
    },
  })
  const running = probe.refresh()
  await new Promise((resolve) => setTimeout(resolve, 10))
  gate.resolve()
  await running
  assert.ok(peak <= 2, `peak=${peak}`)
})

test("host probe: 同一轮并发刷新只发一遍探测", async () => {
  let count = 0
  const probe = createHostProbe({
    call: async () => {
      count += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {}
    },
  })
  await Promise.all([probe.refresh(), probe.refresh(), probe.refresh()])
  assert.equal(count, HOST_PROBES.length)
})

test("host probe: capabilities 只带缺口，stop 后不再探测", async () => {
  const probe = createHostProbe({ call: async () => ({}) })
  await probe.refresh()
  const caps = probe.capabilities()
  assert.equal(caps.v, 1)
  assert.deepEqual(caps.missing, [])
  assert.equal(typeof caps.checkedAt, "number")
  probe.stop()
  await probe.refresh({ force: true })
  assert.deepEqual(probe.capabilities().missing, [])
})
