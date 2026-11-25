/** 澄清题答案校验：只接受原 pending 请求里出现过的题目与选项。 */

export const MAX_CUSTOM_CHARS = 8_000
export const MAX_ANSWERS = 32

export function optionIdentity(option, index) {
  if (option == null) return `opt${index}`
  if (typeof option === "string") return option
  const id = option.id ?? option.value
  if (id != null && String(id).trim()) return String(id)
  if (option.label != null && String(option.label).trim()) return String(option.label)
  return `opt${index}`
}

export function optionLabel(option, index) {
  if (option == null) return `opt${index}`
  if (typeof option === "string") return option
  if (option.label != null && String(option.label).trim()) return String(option.label)
  return optionIdentity(option, index)
}

export function questionKind(question) {
  const type = question?.type
  if (type != null && type !== "" && type !== "select" && type !== "text" && type !== "input") {
    return "unsupported"
  }
  const options = Array.isArray(question?.options) ? question.options : []
  if (options.length > 0) return "select"
  return "text"
}

export function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "invalid-questions", questions: [] }
  }
  if (raw.length > MAX_ANSWERS) {
    return { ok: false, error: "too-many-questions", questions: [] }
  }
  const seen = new Set()
  const questions = []
  for (let i = 0; i < raw.length; i++) {
    const src = raw[i] && typeof raw[i] === "object" ? raw[i] : {}
    const id = String(src.id ?? "").trim() || `q${i}`
    if (seen.has(id)) return { ok: false, error: "duplicate-question-id", questions: [] }
    seen.add(id)
    const options = Array.isArray(src.options) ? src.options : []
    const allowed = new Set()
    const normalizedOptions = options.map((option, index) => {
      const identity = optionIdentity(option, index)
      if (identity) allowed.add(identity)
      if (typeof option === "string") {
        if (option) allowed.add(option)
      } else {
        if (option?.label != null && String(option.label) !== "") allowed.add(String(option.label))
        if (option?.id != null && String(option.id) !== "") allowed.add(String(option.id))
        if (option?.value != null && String(option.value) !== "") allowed.add(String(option.value))
      }
      return {
        id: identity,
        label: optionLabel(option, index),
      }
    })
    questions.push({
      id,
      header: src.header != null ? String(src.header) : "",
      question: String(src.question ?? src.prompt ?? src.text ?? ""),
      options: normalizedOptions,
      allowed,
      kind: questionKind(src),
      multiple: src.multiple === true || src.allowMultiple === true || src.allow_multiple === true,
      optional: src.optional === true || src.required === false,
    })
  }
  return { ok: true, error: null, questions }
}

function selectedValues(answer) {
  const raw = answer?.selected
  if (Array.isArray(raw)) {
    const out = []
    const seen = new Set()
    for (const item of raw) {
      if (item == null) continue
      const text = String(item)
      if (!text || seen.has(text)) continue
      seen.add(text)
      out.push(text)
    }
    return out
  }
  if (raw == null || raw === "") return []
  return [String(raw)]
}

export function validateAnswers(questions, payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.answers)) {
    return { ok: false, code: "invalid-answers", error: "缺少 answer.answers" }
  }
  const answers = payload.answers
  if (answers.length !== questions.length) {
    return { ok: false, code: "answer-count", error: "答案数量与题目不一致" }
  }
  const questionIds = new Set(questions.map((q) => q.id))
  const byId = new Map()
  for (const item of answers) {
    const id = String(item?.id ?? "")
    if (!id || !questionIds.has(id)) {
      return { ok: false, code: "unknown-answer", error: "包含未知题目 ID" }
    }
    if (byId.has(id)) {
      return { ok: false, code: "duplicate-answer", error: "答案题目 ID 重复" }
    }
    byId.set(id, item)
  }
  const normalized = []
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (!answer) {
      return { ok: false, code: "missing-answer", error: `缺少题目 ${question.id} 的答案` }
    }
    if (question.kind === "unsupported") {
      return { ok: false, code: "unsupported-question", error: "存在手机端无法回答的题目，请在电脑上处理" }
    }
    const selected = selectedValues(answer)
    const custom = answer.custom == null ? "" : String(answer.custom)
    if (custom.length > MAX_CUSTOM_CHARS) {
      return { ok: false, code: "custom-too-long", error: "自由输入超出长度限制" }
    }
    if (question.kind === "text" && selected.length > 0) {
      return { ok: false, code: "invalid-option", error: `题目 ${question.id} 为自由输入题，不接受预设选项` }
    }
    if (selected.length > 1 && !question.multiple) {
      return { ok: false, code: "invalid-option", error: "该题不支持多选" }
    }
    if (question.kind === "select") {
      if (selected.length > question.options.length) {
        return { ok: false, code: "invalid-option", error: `题目 ${question.id} 选项数量超出范围` }
      }
      for (const value of selected) {
        if (!question.allowed.has(value)) {
          return { ok: false, code: "invalid-option", error: `选项不属于题目 ${question.id}` }
        }
      }
    }
    const hasValue = selected.length > 0 || custom.trim().length > 0
    if (!hasValue && !question.optional) {
      return { ok: false, code: "required", error: `题目 ${question.id} 为必填` }
    }
    const out = { id: question.id, selected }
    if (custom.trim()) out.custom = custom
    normalized.push(out)
  }
  return { ok: true, answer: { answers: normalized } }
}
