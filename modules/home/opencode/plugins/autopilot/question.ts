import type { QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2"

export function recommendedAnswer(question: QuestionInfo): string[] | undefined {
  if (!question.header.trim() || !question.question.trim() || question.options.length === 0) return
  const labels = question.options.map((option) => option.label)
  const normalized = labels.map((label) => label.trim())
  if (normalized.some((label) => !label)) return
  if (new Set(normalized.map((label) => label.toLocaleLowerCase())).size !== normalized.length) return
  const recommended = labels.filter((label) => {
    const marker = /\s*\(Recommended\)\s*$/i
    return marker.test(label) && label.replace(marker, "").trim().length > 0
  })
  if (question.multiple === true ? recommended.length === 0 : recommended.length !== 1) return
  return recommended
}

export function recommendedAnswers(request: QuestionRequest): string[][] | undefined {
  if (request.questions.length === 0) return
  const answers: string[][] = []
  for (const question of request.questions) {
    const answer = recommendedAnswer(question)
    if (!answer) return
    answers.push(answer)
  }
  return answers
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") return error.message
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
      const message = error.data.message
      if (typeof message === "string") return message
    }
    try {
      return JSON.stringify(error)
    } catch {}
  }
  return String(error)
}

export function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name || undefined
  if (!error || typeof error !== "object" || !("name" in error)) return
  return typeof error.name === "string" && error.name ? error.name : undefined
}

export function interruptedError(error: unknown): boolean {
  return errorName(error) === "MessageAbortedError"
}

export function validateAnswers(request: QuestionRequest, value: unknown): string[][] | undefined {
  if (!Array.isArray(value) || value.length !== request.questions.length) return
  const answers: string[][] = []
  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index]
    const answer = value[index]
    if (!question || !Array.isArray(answer)) return
    const labels = question.options.map((option) => option.label)
    const normalized = labels.map((label) => label.trim().toLocaleLowerCase())
    if (normalized.some((label) => !label) || new Set(normalized).size !== labels.length) return
    if (answer.length === 0 || (question.multiple !== true && answer.length !== 1)) return
    if (!answer.every((item): item is string => typeof item === "string" && labels.includes(item))) return
    if (new Set(answer).size !== answer.length) return
    answers.push(answer)
  }
  return answers
}

export function notFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ("name" in error && error.name === "NotFoundError") return true
  return "status" in error && error.status === 404
}

export function settled(error: unknown): boolean {
  if (error && typeof error === "object" && "_tag" in error && error._tag === "QuestionNotFoundError") return true
  return notFound(error)
}
