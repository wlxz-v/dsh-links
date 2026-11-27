/** 高危命令审批分类器（A5，纯函数零外部依赖）。 */
import { parseToolArguments } from "./approval-detail.js"

const HIGH_RISK_RULES = Object.freeze([
  {
    reason: "destructive_fs",
    patterns: [
      /(?:^|[\s;|&(])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)*-(?:[a-zA-Z]*(?:rf|fr)[a-zA-Z]*|r\s+-f|f\s+-r)(?=\s|$)/i,
      /(?:^|[\s;|&(])rmdir\s+\/s\b/i,
      /(?:^|[\s;|&(])del\s+(?:\/[fqas]+\s+)*\/s\b/i,
      /\bRemove-Item\b[^\n]*(?:-Recurse\b[^\n]*-Force\b|-Force\b[^\n]*-Recurse\b)/i,
      /(?:^|[\s;|&(])(?:format\s+[a-zA-Z]:|mkfs(?:\.[a-z0-9]+)?\b|dd\s+if=)/i,
    ],
  },
  {
    reason: "git_destructive",
    patterns: [
      /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|\s-f\b)/i,
      /\bgit\s+reset\s+--hard\b/i,
      /\bgit\s+clean\s+-[a-zA-Z]*f/i,
    ],
  },
  {
    reason: "remote_pipe_exec",
    patterns: [
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
      /\b(?:iex\s*\([^\n]*irm|irm\b[^\n|]*\|\s*iex|Invoke-Expression)\b/i,
    ],
  },
  {
    reason: "system_privilege",
    patterns: [
      /\breg\s+(?:delete|add)\s+HKLM\b/i,
      /\bsudo\s+rm\b/i,
      /\bchmod\s+-R\s+777\b/i,
      /\bchown\s+-R\b/i,
      /\bnet\s+user\b/i,
      /(?:^|[\s;|&(])shutdown\b/i,
    ],
  },
])

function collectCandidateText({ toolArgs, detail }) {
  const parts = []
  if (typeof detail === "string" && detail.trim()) parts.push(detail.trim())
  const parsed = parseToolArguments(toolArgs)
  if (parsed) {
    for (const key of ["command", "cmd", "script", "code", "path", "filePath"]) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) parts.push(parsed[key].trim())
    }
  } else if (typeof toolArgs === "string" && toolArgs.trim()) {
    parts.push(toolArgs.trim())
  }
  return parts.join("\n")
}

export function classifyApprovalRisk({ toolName, toolArgs, detail } = {}) {
  const text = collectCandidateText({ toolName, toolArgs, detail })
  if (!text) return { riskLevel: "normal" }
  for (const rule of HIGH_RISK_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return { riskLevel: "high", riskReason: rule.reason }
      }
    }
  }
  return { riskLevel: "normal" }
}

export function approvalRiskFields(input) {
  const res = classifyApprovalRisk(input)
  return res.riskLevel === "high" ? { riskLevel: "high", riskReason: res.riskReason } : {}
}
