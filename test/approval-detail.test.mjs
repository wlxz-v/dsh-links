import assert from "node:assert/strict"
import test from "node:test"

import {
  APPROVAL_DETAIL_LIMIT,
  approvalHeadline,
  oneLine,
  parseToolArguments,
  toolCallDetail,
} from "../src/approval-detail.js"

test("参数可以是对象或 JSON 字符串，坏输入不抛", () => {
  assert.deepEqual(parseToolArguments({ command: "ls" }), { command: "ls" })
  assert.deepEqual(parseToolArguments('{"command":"ls"}'), { command: "ls" })
  assert.equal(parseToolArguments("not json"), null)
  assert.equal(parseToolArguments("[1,2]"), null)
  assert.equal(parseToolArguments(null), null)
})

test("命令类工具直接给命令原文，保留换行", () => {
  assert.equal(toolCallDetail("bash", { command: "a\nb" }), "a\nb")
  assert.equal(toolCallDetail("bash", { cmd: "npm test" }), "npm test")
  assert.equal(toolCallDetail("pwsh", { script: "Get-Date" }), "Get-Date")
})

test("文件类工具给路径，其他工具平铺键值", () => {
  assert.equal(toolCallDetail("read", { file_path: "docs/a.md" }), "docs/a.md")
  assert.equal(toolCallDetail("grep", { pattern: "TODO", path: "src" }), "TODO\nsrc")
  assert.equal(
    toolCallDetail("plugin_manager", { action: "list_plugins" }),
    "action: list_plugins",
  )
})

test("没有可展示的参数时返回 null，而不是空串", () => {
  assert.equal(toolCallDetail("bash", null), null)
  assert.equal(toolCallDetail("bash", {}), null)
  assert.equal(toolCallDetail("bash", { command: "   " }), null)
})

test("超长工作内容截断，不撑爆手机屏", () => {
  const detail = toolCallDetail("bash", { command: "x".repeat(2000) })
  assert.equal(detail.length, APPROVAL_DETAIL_LIMIT)
  assert.ok(detail.endsWith("…"))
})

test("单行摘要与标题：换行压成空格，标题带工具名", () => {
  assert.equal(oneLine("a\n\nb   c"), "a b c")
  assert.equal(approvalHeadline("bash", "npm test"), "bash · npm test")
  assert.equal(approvalHeadline("bash", null), "bash")
})
