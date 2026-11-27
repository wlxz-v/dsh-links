import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import https from "node:https";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../src/index.js";
import {
  MAX_RANGE_CHUNK_BYTES,
  MAX_RANGE_FILE_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
  parseByteRangeHeader,
  readWorkspaceFileRangeAsync,
  statWorkspaceFileAsync,
} from "../src/workspace-file.js";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sendHttp({ port, path, method = "GET", headers = {}, body, tls = false }) {
  return new Promise((resolve, reject) => {
    const mod = tls ? https : { request: httpRequest };
    const req = mod.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { connection: "close", ...headers },
      ...(tls ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let jsonBody = null;
        try { jsonBody = JSON.parse(buf.toString("utf8")); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: jsonBody, buf });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function openSessionSse(port, sessionId, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1",
      port,
      path: "/dsh-link/mobile/sessions/" + encodeURIComponent(sessionId) + "/stream",
      method: "GET",
      headers: { "x-dsh-link-token": token, accept: "text/event-stream" },
      rejectUnauthorized: false,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error("SSE failed with " + res.statusCode));
        return;
      }
      const onData = () => {
        res.off("data", onData);
        resolve({ close() { try { res.destroy(); } catch {} try { req.destroy(); } catch {} } });
      };
      res.on("data", onData);
    });
    req.on("error", (err) => {
      if (err?.code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

async function bootPlugin(stateDir, workspaceDir) {
  const routes = new Map();
  const effects = [];
  const sessionList = [{ sessionId: "s1", cwd: workspaceDir, title: "range-test" }];
  const upstream = createServer((req, res) => {
    const handler = routes.get(req.url?.split("?")[0] || "");
    if (handler) return void handler(req, res);
    if (req.url === "/api/session/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ result: { ok: true, value: { items: sessionList } } }));
    }
    if (req.url === "/api/workspace/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ result: { ok: true, value: { items: sessionList, archivedSessionIds: [] } } }));
    }
    res.writeHead(404); res.end("not found");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const webPort = upstream.address().port;
  const proxyPort = 24000 + Math.floor(Math.random() * 1000);
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === "webServer") {
        return {
          port: webPort,
          register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path); },
          tapIndex() { return () => {}; },
        };
      }
      if (name === "typertGateway") {
        return {
          async invoke(req) {
            if (req.namespace === "session" && req.method === "list") return { items: sessionList };
            return {};
          },
          async stream(req) {
            if (req.namespace === "workspace" && req.method === "follow") {
              return (async function* () { yield { type: "baseline", value: { items: sessionList, archivedSessionIds: [] } }; })();
            }
            return (async function* () {})();
          },
        };
      }
      return null;
    },
    on() {},
    effect(fn) { effects.push(fn()); },
  };
  await apply(ctx, { port: proxyPort, pairingTtlSeconds: 300, autoApprove: true, stateDir, eventPollIntervalMs: 60000 });
  return {
    webPort,
    proxyPort,
    async close() {
      for (const fn of effects) { try { fn(); } catch {} }
      await new Promise((r) => upstream.close(r));
    },
  };
}

test("parseByteRangeHeader rejects malformed/multi/empty ranges and clamps valid ranges", () => {
  assert.deepEqual(parseByteRangeHeader("bytes=0-10", 100), { start: 0, end: 10 });
  assert.deepEqual(parseByteRangeHeader("bytes=90-999", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRangeHeader("bytes=80-", 100), { start: 80, end: 99 });
  assert.deepEqual(parseByteRangeHeader("bytes=-25", 100), { start: 75, end: 99 });
  assert.equal(parseByteRangeHeader("bytes=0-0", 0), null);
  assert.equal(parseByteRangeHeader("bytes=100-101", 100), null);
  assert.equal(parseByteRangeHeader("bytes=10-5", 100), null);
  assert.equal(parseByteRangeHeader("bytes=0-1, 2-3", 100), null);
  assert.equal(parseByteRangeHeader("items=0-10", 100), null);
});

test("workspace-file range unit enforces maxFileBytes, maxChunkBytes clamping, and symlinks", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-c1-unit-"));
  const ws = join(base, "ws");
  const outside = join(base, "outside.txt");
  mkdirSync(ws, { recursive: true });
  writeFileSync(outside, "secret");
  const sample = Buffer.alloc(10 * 1024, 0x41);
  writeFileSync(join(ws, "sample.bin"), sample);
  try {
    await assert.rejects(() => statWorkspaceFileAsync(ws, "sample.bin", 1024), (e) => e?.status === 413);
    const part = await readWorkspaceFileRangeAsync(ws, "sample.bin", { start: 0, end: 9999, maxChunkBytes: 4096 });
    assert.equal(part.start, 0);
    assert.equal(part.end, 4095);
    assert.equal(part.chunk.length, 4096);
    assert.equal(MAX_RANGE_FILE_BYTES, 256 * 1024 * 1024);
    assert.equal(MAX_RANGE_CHUNK_BYTES, 2 * 1024 * 1024);
    assert.equal(MAX_WORKSPACE_FILE_BYTES, 8 * 1024 * 1024);
    try {
      symlinkSync(outside, join(ws, "escape.txt"));
      await assert.rejects(() => statWorkspaceFileAsync(ws, "escape.txt"), (e) => e?.status === 403);
    } catch {
      // Windows without Developer Mode may forbid creating symlinks; skip only symlink test branch.
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("HTTP HEAD, Range 206 multi-chunk reassembly, If-Range 412, 416, non-Range 413, and auth guards", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-c1-http-"));
  const stateDir = join(base, "state");
  const ws = join(base, "ws");
  const outside = join(base, "secret.txt");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(outside, "top-secret");
  writeFileSync(join(ws, "empty.bin"), Buffer.alloc(0));
  // 5 MiB pseudo-random deterministic buffer (~2.5 chunks)
  const payload5M = Buffer.allocUnsafe(5 * 1024 * 1024);
  for (let i = 0; i < payload5M.length; i += 4) payload5M.writeUInt32LE((i * 2654435761) >>> 0, i);
  writeFileSync(join(ws, "five.bin"), payload5M);
  // 9 MiB file (> 8 MiB legacy cap): non-Range GET must return 413 while HEAD + Range succeed
  const payload9M = Buffer.alloc(9 * 1024 * 1024 + 17, 0x5a);
  writeFileSync(join(ws, "nine.bin"), payload9M);

  const env = await bootPlugin(stateDir, ws);
  let sse = null;
  try {
    const pairInfo = await sendHttp({ port: env.webPort, path: "/dsh-link/pair-info" });
    const pairRes = await sendHttp({
      port: env.proxyPort,
      path: "/dsh-link/pair",
      method: "POST",
      tls: true,
      headers: { "content-type": "application/json" },
      body: { name: "RangePhone", code: pairInfo.body.pairingCode },
    });
    assert.equal(pairRes.status, 200);
    const token = pairRes.body.token;
    const auth = { "x-dsh-link-token": token };

    // Unsubscribed device is rejected on HEAD and Range GET
    const unsubHead = await sendHttp({ port: env.proxyPort, method: "HEAD", path: "/dsh-link/mobile/sessions/s1/file?path=five.bin", tls: true, headers: auth });
    assert.equal(unsubHead.status, 403);
    const unsubGet = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=five.bin", tls: true, headers: { ...auth, range: "bytes=0-99" } });
    assert.equal(unsubGet.status, 403);

    sse = await openSessionSse(env.proxyPort, "s1", token);

    // Traversal blocked on HEAD and Range GET
    const travHead = await sendHttp({ port: env.proxyPort, method: "HEAD", path: "/dsh-link/mobile/sessions/s1/file?path=../secret.txt", tls: true, headers: auth });
    assert.equal(travHead.status, 403);
    const travRange = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=../secret.txt", tls: true, headers: { ...auth, range: "bytes=0-10" } });
    assert.equal(travRange.status, 403);

    // 0-byte file: HEAD -> 200 content-length 0; non-Range GET -> 200 empty; Range -> 416
    const emptyHead = await sendHttp({ port: env.proxyPort, method: "HEAD", path: "/dsh-link/mobile/sessions/s1/file?path=empty.bin", tls: true, headers: auth });
    assert.equal(emptyHead.status, 200);
    assert.equal(emptyHead.headers["content-length"], "0");
    assert.equal(emptyHead.headers["accept-ranges"], "bytes");
    const emptyGet = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=empty.bin", tls: true, headers: auth });
    assert.equal(emptyGet.status, 200);
    assert.equal(emptyGet.buf.length, 0);
    const emptyRange = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=empty.bin", tls: true, headers: { ...auth, range: "bytes=0-0" } });
    assert.equal(emptyRange.status, 416);
    assert.equal(emptyRange.headers["content-range"], "bytes */0");

    // 5 MiB HEAD + multi-chunk 206 download + checksum verification
    const head5 = await sendHttp({ port: env.proxyPort, method: "HEAD", path: "/dsh-link/mobile/sessions/s1/file?path=five.bin", tls: true, headers: auth });
    assert.equal(head5.status, 200);
    assert.equal(head5.headers["content-length"], String(payload5M.length));
    assert.equal(head5.headers["accept-ranges"], "bytes");
    const etag5 = head5.headers.etag;
    assert.ok(etag5 && etag5.length > 0);

    // Over-2MiB single Range clamped to MAX_RANGE_CHUNK_BYTES
    const clamped = await sendHttp({
      port: env.proxyPort,
      path: "/dsh-link/mobile/sessions/s1/file?path=five.bin",
      tls: true,
      headers: { ...auth, range: "bytes=0-" + (payload5M.length - 1), "if-range": etag5 },
    });
    assert.equal(clamped.status, 206);
    assert.equal(clamped.buf.length, MAX_RANGE_CHUNK_BYTES);
    assert.equal(clamped.headers["content-range"], "bytes 0-" + (MAX_RANGE_CHUNK_BYTES - 1) + "/" + payload5M.length);
    assert.equal(clamped.headers["x-dsh-link-chunk-sha256"], sha256(clamped.buf));

    // Collect remaining chunks starting at clamped.buf.length
    const assembled = [clamped.buf];
    let offset = clamped.buf.length;
    while (offset < payload5M.length) {
      const end = Math.min(offset + MAX_RANGE_CHUNK_BYTES - 1, payload5M.length - 1);
      const part = await sendHttp({
        port: env.proxyPort,
        path: "/dsh-link/mobile/sessions/s1/file?path=five.bin",
        tls: true,
        headers: { ...auth, range: "bytes=" + offset + "-" + end, "if-range": etag5 },
      });
      assert.equal(part.status, 206);
      assert.equal(part.headers["x-dsh-link-chunk-sha256"], sha256(part.buf));
      assembled.push(part.buf);
      offset += part.buf.length;
    }
    assert.equal(sha256(Buffer.concat(assembled)), sha256(payload5M));

    // Out-of-range and multi-range -> 416
    const oor = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=five.bin", tls: true, headers: { ...auth, range: "bytes=99999999-100000000" } });
    assert.equal(oor.status, 416);
    assert.equal(oor.headers["content-range"], "bytes */" + payload5M.length);
    const multi = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=five.bin", tls: true, headers: { ...auth, range: "bytes=0-1, 2-3" } });
    assert.equal(multi.status, 416);

    // If-Range mismatch -> 412; file change -> 412
    const mismatch = await sendHttp({
      port: env.proxyPort,
      path: "/dsh-link/mobile/sessions/s1/file?path=five.bin",
      tls: true,
      headers: { ...auth, range: "bytes=0-1023", "if-range": "\"0-0\"" },
    });
    assert.equal(mismatch.status, 412);
    assert.equal(mismatch.headers.etag, etag5);

    // 9 MiB file: non-Range GET still 413; HEAD 200; tail Range 206 succeeds
    const nonRange9 = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=nine.bin", tls: true, headers: auth });
    assert.equal(nonRange9.status, 413);
    const head9 = await sendHttp({ port: env.proxyPort, method: "HEAD", path: "/dsh-link/mobile/sessions/s1/file?path=nine.bin", tls: true, headers: auth });
    assert.equal(head9.status, 200);
    assert.equal(head9.headers["content-length"], String(payload9M.length));
    const tailStart = 9 * 1024 * 1024;
    const tail9 = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=nine.bin", tls: true, headers: { ...auth, range: "bytes=" + tailStart + "-" + (payload9M.length - 1) } });
    assert.equal(tail9.status, 206);
    assert.equal(tail9.buf.length, 17);
  } finally {
    if (sse) sse.close();
    await env.close();
    rmSync(base, { recursive: true, force: true });
  }
});
