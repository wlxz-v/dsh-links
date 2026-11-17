import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseSessionLogFilename,
  pickCurrentSessionLogFilename,
  resolveSessionLogPath,
} from "../src/session-log-path.js"

test("canonical v0 / vN 文件名可解析，临时文件与 .v0 不算", () => {
  assert.deepEqual(parseSessionLogFilename("session.jsonl.zstd"), { version: 0, compressed: true })
  assert.deepEqual(parseSessionLogFilename("session.jsonl"), { version: 0, compressed: false })
  assert.deepEqual(parseSessionLogFilename("session.v3.jsonl.zstd"), { version: 3, compressed: true })
  assert.equal(parseSessionLogFilename("session.v0.jsonl.zstd"), null)
  assert.equal(parseSessionLogFilename("session.v3.jsonl.zstd.tmp"), null)
  assert.equal(parseSessionLogFilename("header.json"), null)
})

test("同目录取最高 generation；同代优先 zstd", () => {
  assert.equal(
    pickCurrentSessionLogFilename(["session.jsonl.zstd", "session.v2.jsonl.zstd", "session.v3.jsonl.zstd"]),
    "session.v3.jsonl.zstd",
  )
  assert.equal(
    pickCurrentSessionLogFilename(["session.v3.jsonl", "session.v3.jsonl.zstd"]),
    "session.v3.jsonl.zstd",
  )
  assert.equal(pickCurrentSessionLogFilename(["session.jsonl.zstd"]), "session.jsonl.zstd")
  assert.equal(pickCurrentSessionLogFilename([]), null)
})

test("resolveSessionLogPath 读目录并拼出当前日志路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-links-session-log-"))
  try {
    assert.equal(resolveSessionLogPath(dir), null)
    writeFileSync(join(dir, "session.jsonl.zstd"), "")
    writeFileSync(join(dir, "session.v3.jsonl.zstd"), "")
    assert.equal(resolveSessionLogPath(dir), join(dir, "session.v3.jsonl.zstd"))
    assert.equal(resolveSessionLogPath("/no/such/dsh-links-session-dir"), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("会话目录跟随 DSH_HOME，未设时回落到 ~/.dsh，兼容 Windows 盘符与非 ASCII 路径", async () => {
  const { encodeSessionProjectKey, sessionDirFor } = await import("../src/session-log-path.js")
  const { homedir } = await import("node:os")
  assert.equal(
    sessionDirFor("/Users/me/proj", "session-1", { DSH_HOME: "/tmp/dsh-home" }),
    join("/tmp/dsh-home", "sessions", "--Users-me-proj--", "session-1"),
  )
  assert.equal(
    sessionDirFor("/Users/me/proj", "session-1", {}),
    join(homedir(), ".dsh", "sessions", "--Users-me-proj--", "session-1"),
  )
  assert.equal(
    sessionDirFor("/Users/me/proj", "session-1", { DSH_HOME: "  " }),
    join(homedir(), ".dsh", "sessions", "--Users-me-proj--", "session-1"),
  )
  // Windows 盘符、反斜杠与非 ASCII 字符（与 @deepseek-ai/dsh-session-persistence-jsonl 对齐）
  assert.equal(encodeSessionProjectKey("D:\\DSH"), "--D-DSH--")
  assert.equal(encodeSessionProjectKey("C:\\Users\\无界15X"), "--C-Users-~65E0~754C15X--")
  assert.equal(encodeSessionProjectKey("/"), "--root--")
  assert.equal(
    sessionDirFor("D:\\DSH", "session-1", { DSH_HOME: "D:\\dsh-home" }),
    join("D:\\dsh-home", "sessions", "--D-DSH--", "session-1"),
  )
  assert.equal(
    sessionDirFor("", "session-1", { DSH_HOME: "/tmp/dsh-home" }),
    join("/tmp/dsh-home", "sessions", "_no-cwd", "session-1"),
  )
})
