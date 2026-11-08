/**
 * 定时任务写路径的版本适配：DSH 0.2.x 把 schedule/update 与 schedule/delete 合并成
 * schedule/edit（{ id, action, patch }）；老版本只有旧的两个 Remote。
 * 插件先打新方法，遇到「方法不存在」才回退旧方法，并把旧语义（expected + change）原样带上。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { bindLocalRpcRuntime, LocalRpcError, unbindLocalRpcRuntime } from "../src/local-rpc.js"
import { handleMobileSessionControlApi } from "../src/mobile-session-control.js"

function harness(invoke) {
  const calls = []
  bindLocalRpcRuntime({
    invoke: async (req) => {
      calls.push(req)
      return invoke(req)
    },
  })
  const out = { status: 0, body: null }
  const deps = {
    json: (_res, status, body) => { out.status = status; out.body = body },
    readAuthorizedJson: async (req) => req.body,
    requireJsonWrite: () => true,
    runMobileDeviceMutation: async (_rt, _state, _device, fn) => fn(),
    mobileMutationWasRevoked: () => false,
    respondDeviceRevoked: () => { out.status = 401 },
  }
  const run = (method, path, body) => handleMobileSessionControlApi(
    { method, url: path, body }, {}, 0, {}, { deviceId: "d1" }, path.split("?")[0], {}, deps,
  )
  return { calls, out, run }
}

const expected = { id: "t1", kind: "every", everySeconds: 60, title: "x" }

test("老版本 DSH：schedule/edit 不存在时回退 schedule/update，CAS 字段照原样带", async () => {
  const h = harness(async (req) => {
    if (req.method === "edit") throw new LocalRpcError("schedule.edit", { code: "gateway/lookup-not-found", message: "schedule/edit not found" })
    return { ok: true, revision: 2 }
  })
  try {
    await h.run("PUT", "/dsh-link/mobile/sessions/s1/schedules/t1", { expected, title: "新标题" })
    assert.equal(h.out.status, 200)
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[0].method, "edit")
    assert.equal(h.calls[1].method, "update")
    assert.deepEqual(h.calls[1].args.request, { sessionId: "s1", id: "t1", expected, title: "新标题" })
  } finally {
    unbindLocalRpcRuntime()
  }
})

test("老版本 DSH：删除同样回退 schedule/delete；新方法只用 id + action", async () => {
  const h = harness(async (req) => {
    if (req.method === "edit") throw new LocalRpcError("schedule.edit", { code: "gateway/method-unavailable", message: "no such remote" })
    return {}
  })
  try {
    await h.run("DELETE", "/dsh-link/mobile/sessions/s1/schedules/t1")
    assert.equal(h.out.status, 200)
    assert.deepEqual(h.calls[0].args.request, { id: "t1", action: "delete" })
    assert.deepEqual(h.calls[1], { namespace: "schedule", method: "delete", args: { request: { sessionId: "s1", id: "t1" } } })
  } finally {
    unbindLocalRpcRuntime()
  }
})

test("业务错误（不是方法缺失）不回退，直接 4xx/5xx 报给手机", async () => {
  const h = harness(async () => {
    throw new LocalRpcError("schedule.edit", { code: "schedule/not-found", message: "没这个任务" })
  })
  try {
    await h.run("DELETE", "/dsh-link/mobile/sessions/s1/schedules/t1")
    assert.equal(h.out.status, 404)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].method, "edit")
  } finally {
    unbindLocalRpcRuntime()
  }
})
