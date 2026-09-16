import type { QuestionRequest, Session } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { readState, type Mode } from "./state"

export function recommendedAnswers(request: QuestionRequest): string[][] | undefined {
  if (request.questions.length === 0) return
  const answers: string[][] = []
  for (const question of request.questions) {
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
    answers.push(recommended)
  }
  return answers
}

async function resolveSession(
  api: TuiPluginApi,
  sessionID: string,
  directory: string,
): Promise<Session | undefined> {
  const cached = api.state.session.get(sessionID)
  if (cached) return cached
  return api.client.session.get({ sessionID, directory }).then((result) => result.data)
}

export async function effectiveQuestionMode(
  api: TuiPluginApi,
  sessionID: string,
  directory: string,
): Promise<Mode> {
  const state = readState()
  const seen = new Set<string>()
  let cursor: string | undefined = sessionID
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const override = state.questions.sessions[cursor]
    if (override) return override
    const session: Session | undefined = await resolveSession(api, cursor, directory).catch(() => undefined)
    cursor = session?.parentID
  }
  return state.questions.global
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") return error.message
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
      const message = error.data.message
      if (typeof message === "string") return message
    }
  }
  return String(error)
}

export function settled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ("_tag" in error && error._tag === "QuestionNotFoundError") return true
  if ("name" in error && error.name === "NotFoundError") return true
  return "status" in error && error.status === 404
}
