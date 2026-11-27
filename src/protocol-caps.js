/** 业务层能力协商。远程通道（DLP/1）与内层证书钉扎不因这些字段改变。 */

import { createRequire } from "node:module"
import { MAX_WORKSPACE_DIR_ENTRIES, MAX_WORKSPACE_FILE_BYTES } from "./workspace-file.js"
import { MAX_DIFF_LINES } from "./workspace-changes.js"

const require = createRequire(import.meta.url)
const DEFAULT_PLUGIN_VERSION = require("../package.json").version
export const MIN_COMPAT_APP_VERSION = "0.5.0-beta.27"

export const PLUGIN_PROTOCOL = 2
export const CAP_SYNC2 = "sync2"
export const CAP_MULTI_QUESTION = "multiQuestion"
export const CAP_REQUEST_STATE = "requestState"
export const RECONNECT_GRACE_MS = 30_000

export const CLIENT_CAPS_QUERY = `${CAP_SYNC2},${CAP_MULTI_QUESTION},${CAP_REQUEST_STATE}`

export function parseClientCaps(raw) {
  const bounded = String(raw ?? "").slice(0, 512)
  const set = new Set(bounded.split(",").map((item) => item.trim()).filter(Boolean))
  return {
    sync2: set.has(CAP_SYNC2),
    multiQuestion: set.has(CAP_MULTI_QUESTION),
    requestState: set.has(CAP_REQUEST_STATE),
  }
}

/**
 * @param {{ changes?: boolean, host?: object }} [input] changes：Host 挂载了 workspaceChanges
 *   服务（DSH 0.1.7 起的 `@deepseek-ai/dsh-workspace-changes`）；host：宿主能力探针的结论
 *   （`{ checkedAt, missing, unknown }`，见 host-probe.js）。旧 App 忽略未知字段。
 */
export function pluginCapabilities({ changes = false, host, pluginVersion = DEFAULT_PLUGIN_VERSION, minAppVersion = MIN_COMPAT_APP_VERSION } = {}) {
  return {
    protocol: PLUGIN_PROTOCOL,
    sync: { resync: true, catchupIntegrity: true },
    questions: { multi: true, serverValidation: true },
    requests: { snapshot: true, reconnectGraceMs: RECONNECT_GRACE_MS },
    // 排队消息管理、目标操作、定时任务（DSH 不支持的 Host 上会返回 400/502，App 据此隐藏入口）
    control: { queue: true, goals: true, schedules: true },
    files: {
      workspace: true,
      maxBytes: MAX_WORKSPACE_FILE_BYTES,
      tree: true,
      treeMaxEntries: MAX_WORKSPACE_DIR_ENTRIES,
      sha256: true,
      ...(changes ? { changes: true, diff: true, diffMaxLines: MAX_DIFF_LINES } : {}),
    },
    // 连接诊断。旧 App 忽略未知字段；没声明时 App 不展示主机诊断报告。
    diagnostics: { v: 1 },
    // 主机级会话状态流。旧 App 忽略未知字段，仍只订阅单个会话。
    // since：/mobile/events 除了 Last-Event-ID 头，也接受 ?since=<seq> 续传。
    events: { host: true, since: true },
    // 宿主能力实测结论：missing 里的入口在宿主上不存在，App 据此隐藏对应按钮，
    // 而不是点下去才收到 400。checkedAt 为 0 表示还没探测完（App 先按「可能在」处理）。
    ...(host && typeof host === "object" ? { host } : {}),
    // 已批准的本机预览端口。detect=1 表示可以列出工具输出里看到的端口。旧 App 忽略未知字段。手机不能批准端口。
    preview: { v: 1, detect: 1 },
    compat: {
      pluginVersion,
      minAppVersion,
      protocolVersion: 1,
    },
  }
}

export function anyConnHasCap(writers, cap) {
  for (const conn of writers ?? []) {
    if (conn?.caps?.[cap]) return true
  }
  return false
}

export function subscribedDeviceIds(writers) {
  const ids = new Set()
  for (const conn of writers ?? []) {
    if (conn?.deviceId) ids.add(conn.deviceId)
  }
  return ids
}
