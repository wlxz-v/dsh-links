/** D1：JSON 响应的弱 ETag 与 304（列表轮询省流量）。 */
import assert from "node:assert/strict"
import test from "node:test"
import { ifNoneMatchHit, json, jsonEtag } from "../src/index.js"

function response(headers = {}) {
  return {
    req: { headers },
    code: null,
    headers: null,
    body: null,
    writeHead(code, value) {
      this.code = code
      this.headers = value
    },
    end(body) {
      this.body = body ?? null
    },
  }
}

test("etag：同一内容同一个 ETag，内容或编码不同就不同", () => {
  const body = Buffer.from(JSON.stringify({ items: [1, 2, 3] }))
  const gzipBody = Buffer.from("compressed")
  assert.equal(jsonEtag(null, body), jsonEtag(null, body))
  assert.notEqual(jsonEtag(null, body), jsonEtag("gzip", gzipBody))
  assert.notEqual(jsonEtag(null, body), jsonEtag(null, Buffer.from(JSON.stringify({ items: [1, 2, 4] }))))
  assert.match(jsonEtag(null, body), /^W\/"[A-Za-z0-9_-]{22}"$/)
})

test("etag：200 响应带 ETag，第二次带 If-None-Match 回 304 且不带 body", () => {
  const payload = { items: Array.from({ length: 40 }, (_, i) => ({ sessionId: `s-${i}` })) }
  const first = response()
  json(first, 200, payload)
  assert.equal(first.code, 200)
  assert.ok(first.headers.etag)
  assert.equal(first.headers.vary, "accept-encoding")

  const second = response({ "if-none-match": first.headers.etag })
  json(second, 200, payload)
  assert.equal(second.code, 304)
  assert.equal(second.body, null)
  assert.equal("content-length" in second.headers, false)
  assert.equal("content-encoding" in second.headers, false)
  assert.equal(second.headers.etag, first.headers.etag)
  assert.equal(second.headers.vary, "accept-encoding")
})

test("etag：非 200 或空 body 不带 ETag", () => {
  const error = response()
  json(error, 400, { error: "bad" })
  assert.equal(error.headers.etag, undefined)
})

test("etag：If-None-Match 支持列表、星号与弱比较", () => {
  const etag = 'W/"abc123"'
  assert.equal(ifNoneMatchHit(etag, etag), true)
  assert.equal(ifNoneMatchHit('"other", W/"abc123"', etag), true)
  assert.equal(ifNoneMatchHit("*", etag), true)
  assert.equal(ifNoneMatchHit('"abc123"', etag), true)
  assert.equal(ifNoneMatchHit('"nope"', etag), false)
  assert.equal(ifNoneMatchHit("", etag), false)
  assert.equal(ifNoneMatchHit(etag, null), false)
})

test("etag：gzip 与 identity 的 304 各自成立，不会把压缩体当成明文", () => {
  const payload = { items: Array.from({ length: 40 }, (_, i) => ({ sessionId: `s-${i}`, title: "会话标题会话标题" })) }
  const plain = response({ "accept-encoding": "gzip" })
  json(plain, 200, payload)
  const gz = response({ "accept-encoding": "gzip" })
  json(gz, 200, payload)

  // 带相同的 If-None-Match 但请求的是另一种编码：不能命中。
  const mismatch = response({ "if-none-match": plain.headers.etag })
  json(mismatch, 200, payload)
  assert.equal(mismatch.code, 200, "identity 的 ETag 不该命中 gzip 请求")

  const hit = response({ "accept-encoding": "gzip", "if-none-match": gz.headers.etag })
  json(hit, 200, payload)
  assert.equal(hit.code, 304)
})
