/**
 * F3：JSON 响应压缩协商。大于 1KB 的响应按 Accept-Encoding 选 zstd / br / gzip，
 * 小响应（含 token 的配对响应都在这档）一律不压。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib"
import { json, negotiateJsonEncoding } from "../src/index.js"

test("协商：浏览器头选 zstd，只认 gzip 的客户端选 gzip，q=0 会跳过", () => {
  assert.equal(negotiateJsonEncoding("gzip, deflate, br, zstd", 5000), "zstd")
  assert.equal(negotiateJsonEncoding("gzip", 5000), "gzip")
  assert.equal(negotiateJsonEncoding("br", 5000), "br")
  assert.equal(negotiateJsonEncoding("zstd;q=0, br;q=0.9, gzip;q=0.5", 5000), "br")
  assert.equal(negotiateJsonEncoding("gzip;q=0, br;q=0", 5000), null)
  assert.equal(negotiateJsonEncoding("*", 5000), "zstd")
})

test("协商：小于 1KB 不压，无 Accept-Encoding 不压", () => {
  assert.equal(negotiateJsonEncoding("gzip, br, zstd", 1023), null)
  assert.equal(negotiateJsonEncoding("gzip, br, zstd", 1024), "zstd")
  assert.equal(negotiateJsonEncoding("", 5000), null)
  assert.equal(negotiateJsonEncoding("identity", 5000), null)
})

function callJson(acceptEncoding, obj) {
  let status = 0
  let headers = {}
  let body = null
  const res = {
    req: { headers: acceptEncoding == null ? {} : { "accept-encoding": acceptEncoding } },
    writeHead(code, h) { status = code; headers = h },
    end(buffer) { body = buffer },
  }
  json(res, 200, obj, { "x-test": "1" })
  return { status, headers, body }
}

const bigPayload = { items: Array.from({ length: 40 }, (_, i) => ({ id: i, title: `会话 ${i} 的标题`, state: "running" })) }

test("json()：zstd 响应可解回原文，头里带宽高与 content-encoding", () => {
  const { status, headers, body } = callJson("gzip, br, zstd", bigPayload)
  assert.equal(status, 200)
  assert.equal(headers["content-encoding"], "zstd")
  assert.equal(headers.vary, "accept-encoding")
  assert.equal(headers["content-length"], String(body.length))
  assert.equal(headers["x-test"], "1")
  assert.deepEqual(JSON.parse(zstdDecompressSync(body).toString("utf8")), bigPayload)
})

test("json()：br / gzip / 不压 三条路径都能还原，Vary 始终在", () => {
  const br = callJson("br", bigPayload)
  assert.equal(br.headers["content-encoding"], "br")
  assert.deepEqual(JSON.parse(brotliDecompressSync(br.body).toString("utf8")), bigPayload)

  const gz = callJson("gzip", bigPayload)
  assert.equal(gz.headers["content-encoding"], "gzip")
  assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString("utf8")), bigPayload)

  const plain = callJson(null, { ok: true })
  assert.equal(plain.headers["content-encoding"], undefined)
  assert.equal(plain.headers.vary, "accept-encoding")
  assert.deepEqual(JSON.parse(plain.body.toString("utf8")), { ok: true })
})
