/**
 * 端口顺延（E2）：默认端口（或配置端口）被别的进程占用时，
 * 插件按 +1 试到 +8 个端口，抢到哪个就用哪个端口出二维码/面板，
 * 而不是直接 readiness=failed、整个配对面板不可用。
 * 参考 lrxG/dsh-app 的 createLanGateway(attempts=8) 做法。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { createConnection } from "node:net"
import { request as httpsRequest } from "node:https"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply } from "../src/index.js"

const ROOT_TMP = mkdtempSync(join(tmpdir(), "dsh-port-shift-test-"))

const upstream = await new Promise((resolve) => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("upstream-ok")
  })
  srv.listen(0, "127.0.0.1", () => resolve(srv))
})

const disposers = []
let squatter = null

test.after(() => {
  for (const fn of disposers) try { fn() } catch {}
  try { squatter?.close() } catch {}
  try { upstream.close() } catch {}
  rmSync(ROOT_TMP, { recursive: true, force: true })
})

function makeCtx() {
  const registered = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === "webServer") {
        return {
          port: upstream.address().port,
          register(route) { registered.push(route); return () => {} },
          tapIndex() { return () => {} },
        }
      }
      return null
    },
    on() {},
    effect(fn) { effects.push(fn()) },
  }
  disposers.push(...effects)
  return { ctx, registered, effects }
}

async function start(stateDir, port) {
  const { ctx, registered, effects } = makeCtx()
  await apply(ctx, {
    port,
    pairingTtlSeconds: 300,
    autoApprove: true,
    stateDir,
    eventPollIntervalMs: 60000,
  })
  return { registered, effects }
}

function callRoute(route, path) {
  let status = 0
  let out = ""
  const res = {
    writeHead(code) { status = code },
    end(body) { out = body == null ? "" : Buffer.isBuffer(body) ? body.toString("utf8") : String(body) },
  }
  const req = {
    method: "GET",
    headers: { host: `127.0.0.1:${upstream.address().port}` },
    url: path,
    socket: { remoteAddress: "127.0.0.1" },
  }
  return Promise.resolve(route.handler(req, res)).then(() => ({
    status,
    body: (() => { try { return JSON.parse(out) } catch { return null } })(),
  }))
}

/** 借一个空闲端口再释放（存在极小竞争窗口，仅用于「本来就没被占」的用例）。 */
function freePort() {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function tcpReachable(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    socket.setTimeout(3000, () => { socket.destroy(); resolve(false) })
    socket.once("connect", () => { socket.end(); resolve(true) })
    socket.once("error", () => resolve(false))
  })
}

function tlsHealth(port) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/dsh-link/health",
        rejectUnauthorized: false,
        headers: { host: `127.0.0.1:${port}` },
        timeout: 5000,
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => { text += chunk })
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      },
    )
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", reject)
    req.end()
  })
}

test("端口被占用时顺延，二维码与面板都用实际端口", async () => {
  squatter = createServer()
  await new Promise((resolve) => squatter.listen(0, "0.0.0.0", resolve))
  const blocked = squatter.address().port
  const { registered } = await start(join(ROOT_TMP, "shifted"), blocked)
  const pairRoute = registered.find((route) => route.path === "/dsh-link/pair-info")
  const pair = await callRoute(pairRoute, "/dsh-link/pair-info")
  assert.equal(pair.status, 200)
  // 配置端口仍是被占的那个，实际端口必须顺延到它后面，并且所有 urls 都用实际端口
  assert.notEqual(pair.body.port, blocked)
  assert.ok(pair.body.port > blocked && pair.body.port <= blocked + 8, String(pair.body.port))
  for (const url of pair.body.urls) assert.ok(url.endsWith(`:${pair.body.port}`), url)
  for (const info of pair.body.infos) assert.ok(info.url.endsWith(`:${pair.body.port}`), info.url)
  // 面板/诊断里的监听信息也必须是实际端口
  assert.equal(pair.body.exposure.listen.port, pair.body.port)
  assert.equal(pair.body.exposure.listen.address, "0.0.0.0")
  assert.equal(await tcpReachable(pair.body.port), true)
  // 顺延后的端口上确实是我们自己的 TLS 服务（pair-info 是 PANEL_ONLY_PATHS，
  // 只给本机面板，所以用 /dsh-link/health 验证）。端口刚探测过，冷启动竞态用重试兜住。
  let health = null
  for (let i = 0; i < 3 && !health; i += 1) {
    health = await tlsHealth(pair.body.port).catch(() => null)
  }
  assert.equal(health?.status, 200)
  assert.equal(health?.body.ok, true)
})
