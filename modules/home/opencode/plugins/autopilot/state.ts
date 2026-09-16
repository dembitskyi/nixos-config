import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Mode = "manual" | "recommended"
export type SessionMode = "inherit" | Mode
export type StatusVisibility = "auto" | "show" | "hide"
export type GoalMode = "monitor" | "drive"
export const AUTOPILOT_REFRESH_COMMAND = "autopilot.refresh"
export type GoalPhase =
  | "waiting-goal"
  | "working"
  | "verifying"
  | "continuing"
  | "complete"
  | "blocked"
  | "paused"
  | "stalled"
  | "exhausted"

export type Goal = {
  workerSessionID: string
  verifierSessionID?: string
  directory: string
  text?: string
  criteria: string[]
  mode: GoalMode
  phase: GoalPhase
  startedAt?: number
  updatedAt: number
  round: number
  continuations: number
  maxRounds?: number
  maxMinutes?: number
  noProgressLimit: number
  noProgressRounds: number
  lastFingerprint?: string
  lastInstruction?: string
  lastVerifierMessageID?: string
  lastCheckpoint?: string
  lastIdleMessageID?: string
  revision: number
  workerAgent?: string
  acknowledgementPending?: boolean
  verifier?: {
    providerID: string
    modelID: string
    variant?: string
  }
}

export type State = {
  version: 1
  questions: {
    global: Mode
    sessions: Record<string, Mode>
  }
  status: {
    sessions: Record<string, StatusVisibility>
  }
  goals: Record<string, Goal>
}

export const DEFAULT_STATE: State = {
  version: 1,
  questions: { global: "manual", sessions: {} },
  status: { sessions: {} },
  goals: {},
}

const GOAL_PHASES = new Set<GoalPhase>([
  "waiting-goal",
  "working",
  "verifying",
  "continuing",
  "complete",
  "blocked",
  "paused",
  "stalled",
  "exhausted",
])

export function statePath(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "autopilot.json")
}

export function readState(): State {
  try {
    const value: unknown = JSON.parse(readFileSync(statePath(), "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(DEFAULT_STATE)
    const data = value as Partial<State>
    const questionSessions = data.questions?.sessions
    const sessions =
      questionSessions && typeof questionSessions === "object" && !Array.isArray(questionSessions)
        ? Object.fromEntries(
            Object.entries(questionSessions).filter(
              (entry): entry is [string, Mode] => entry[1] === "manual" || entry[1] === "recommended",
            ),
          )
        : {}
    const goals =
      data.goals && typeof data.goals === "object" && !Array.isArray(data.goals)
        ? Object.fromEntries(
            Object.entries(data.goals).flatMap(([workerSessionID, value]) => {
              const goal = parseGoal(workerSessionID, value)
              return goal ? [[workerSessionID, goal]] : []
            }),
          )
        : {}
    const statusSessions = data.status?.sessions
    const status =
      statusSessions && typeof statusSessions === "object" && !Array.isArray(statusSessions)
        ? Object.fromEntries(
            Object.entries(statusSessions).filter(
              (entry): entry is [string, StatusVisibility] =>
                entry[1] === "auto" || entry[1] === "show" || entry[1] === "hide",
            ),
          )
        : {}
    return {
      version: 1,
      questions: {
        global: data.questions?.global === "recommended" ? "recommended" : "manual",
        sessions,
      },
      status: { sessions: status },
      goals,
    }
  } catch {
    return structuredClone(DEFAULT_STATE)
  }
}

function parseGoal(workerSessionID: string, value: unknown): Goal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const goal = value as Partial<Goal>
  if (
    goal.workerSessionID !== workerSessionID ||
    typeof goal.directory !== "string" ||
    (goal.mode !== "monitor" && goal.mode !== "drive") ||
    !goal.phase ||
    !GOAL_PHASES.has(goal.phase) ||
    !Array.isArray(goal.criteria) ||
    !goal.criteria.every((item) => typeof item === "string") ||
    typeof goal.updatedAt !== "number" ||
    typeof goal.round !== "number" ||
    typeof goal.continuations !== "number" ||
    typeof goal.noProgressLimit !== "number" ||
    typeof goal.noProgressRounds !== "number" ||
    typeof goal.revision !== "number"
  ) {
    return
  }
  return goal as Goal
}

export function writeState(state: State): void {
  const target = statePath()
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export function mutateState(update: (state: State) => void): State {
  return withLock(() => {
    const state = readState()
    update(state)
    writeState(state)
    return state
  })
}

export function updateState(update: (state: State) => State): State {
  return withLock(() => {
    const next = update(readState())
    writeState(next)
    return next
  })
}

function withLock<T>(run: () => T): T {
  const lock = `${statePath()}.lock`
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 })
  const wait = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 })
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {}
      Atomics.wait(wait, 0, 0, 10)
      continue
    }
    try {
      return run()
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }
  throw new Error("Timed out acquiring the Autopilot state lock")
}

export function setGlobalQuestionMode(mode: Mode): State {
  return updateState((state) => ({ ...state, questions: { ...state.questions, global: mode } }))
}

export function setSessionQuestionMode(sessionID: string, mode: SessionMode): State {
  return updateState((state) => {
    const sessions = { ...state.questions.sessions }
    if (mode === "inherit") delete sessions[sessionID]
    if (mode !== "inherit") sessions[sessionID] = mode
    return { ...state, questions: { ...state.questions, sessions } }
  })
}

export function setStatusVisibility(sessionID: string, visibility: StatusVisibility): State {
  return updateState((state) => {
    const sessions = { ...state.status.sessions }
    if (visibility === "auto") delete sessions[sessionID]
    if (visibility !== "auto") sessions[sessionID] = visibility
    return { ...state, status: { sessions } }
  })
}

export function putGoal(goal: Goal): State {
  return updateState((state) => ({ ...state, goals: { ...state.goals, [goal.workerSessionID]: goal } }))
}

export function patchGoal(workerSessionID: string, patch: Partial<Goal>): Goal | undefined {
  let result: Goal | undefined
  updateState((state) => {
    const current = state.goals[workerSessionID]
    if (!current) return state
    result = { ...current, ...patch, updatedAt: Date.now() }
    return { ...state, goals: { ...state.goals, [workerSessionID]: result } }
  })
  return result
}

export function patchGoalIf(
  workerSessionID: string,
  predicate: (goal: Goal) => boolean,
  patch: Partial<Goal>,
): Goal | undefined {
  let result: Goal | undefined
  updateState((state) => {
    const current = state.goals[workerSessionID]
    if (!current || !predicate(current)) return state
    result = { ...current, ...patch, updatedAt: Date.now() }
    return { ...state, goals: { ...state.goals, [workerSessionID]: result } }
  })
  return result
}

export function removeGoal(workerSessionID: string): State {
  return updateState((state) => {
    const goals = { ...state.goals }
    const statusSessions = { ...state.status.sessions }
    delete goals[workerSessionID]
    delete statusSessions[workerSessionID]
    return { ...state, status: { sessions: statusSessions }, goals }
  })
}

export function findGoalByVerifier(verifierSessionID: string): Goal | undefined {
  return Object.values(readState().goals).find((goal) => goal.verifierSessionID === verifierSessionID)
}

export function formatLimit(value: number | undefined, unit = ""): string {
  return value === undefined ? "Unlimited" : `${value}${unit}`
}

export function parseCriteria(text: string): string[] {
  const marker = /(?:^|\n)\s*(?:done when|acceptance criteria|criteria)\s*:\s*/i.exec(text)
  if (!marker) return []
  const tail = text.slice((marker.index ?? 0) + marker[0].length)
  return tail
    .split("\n")
    .map((line) => line.trim().replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
}

export function goalSummary(goal: Goal): string {
  return [
    "Autopilot",
    `State: ${goal.phase}`,
    `Mode: ${goal.mode}`,
    `Checkpoints: ${goal.round}`,
    `Continuations: ${goal.continuations}/${formatLimit(goal.maxRounds)}`,
    `Duration: ${goal.startedAt ? `${Math.max(0, Math.floor((Date.now() - goal.startedAt) / 60_000))}m` : "0m"}/${formatLimit(goal.maxMinutes, "m")}`,
    `Verifier: ${goal.verifier ? `${goal.verifier.providerID}/${goal.verifier.modelID}${goal.verifier.variant ? ` · ${goal.verifier.variant}` : ""}` : "same as worker (resolved on verification)"}`,
    goal.text ? `Goal: ${goal.text}` : "Goal: waiting for your next message",
  ].join("\n")
}
