import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type StatusVisibility = "auto" | "show" | "hide"
export type QuestionPolicy = "manual" | "recommended" | "hybrid"
export type GoalMode = "monitor" | "drive"
export type ModelRef = {
  providerID: string
  modelID: string
  variant?: string
}
export const AUTOPILOT_REFRESH_COMMAND = "autopilot.refresh"
export type GoalPhase =
  | "waiting-goal"
  | "working"
  | "verifying"
  | "continuing"
  | "waiting-user"
  | "complete"
  | "blocked"
  | "paused"
  | "stalled"
  | "exhausted"

export type Goal = {
  workerSessionID: string
  verifierSessionID?: string
  chooserSessionID?: string
  directory: string
  text?: string
  criteria: string[]
  model?: ModelRef
  mode: GoalMode
  questionPolicy: QuestionPolicy
  phase: GoalPhase
  startedAt?: number
  updatedAt: number
  round: number
  continuations: number
  maxCheckpoints?: number
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
  verifier?: ModelRef
}

export type State = {
  version: 2
  status: {
    sessions: Record<string, StatusVisibility>
  }
  goals: Record<string, Goal>
}

export const DEFAULT_STATE: State = {
  version: 2,
  status: { sessions: {} },
  goals: {},
}

const GOAL_PHASES = new Set<GoalPhase>([
  "waiting-goal",
  "working",
  "verifying",
  "continuing",
  "waiting-user",
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
    const goals =
      data.goals && typeof data.goals === "object" && !Array.isArray(data.goals)
        ? Object.fromEntries(
            Object.entries(data.goals).flatMap(([workerSessionID, value]) => {
              const goal = parseGoal(workerSessionID, value)
              return goal ? [[workerSessionID, goal]] : []
            }),
          )
        : {}
    const statusSessions = (data.status as { sessions?: Record<string, unknown> } | undefined)?.sessions
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
      version: 2,
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
  const questionPolicy: QuestionPolicy =
    goal.questionPolicy === "recommended" || goal.questionPolicy === "manual" || goal.questionPolicy === "hybrid"
      ? goal.questionPolicy
      : "hybrid"
  const legacy = value as { maxRounds?: unknown }
  const maxCheckpoints =
    typeof goal.maxCheckpoints === "number"
      ? goal.maxCheckpoints
      : typeof legacy.maxRounds === "number"
        ? legacy.maxRounds
        : undefined
  const { maxRounds: _, ...migrated } = goal as Partial<Goal> & {
    maxRounds?: number
  }
  return {
    ...migrated,
    questionPolicy,
    maxCheckpoints,
    model: parseModelRef(goal.model),
    verifier: parseModelRef(goal.verifier),
  } as Goal
}

function parseModelRef(value: unknown): ModelRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const model = value as Partial<ModelRef>
  if (typeof model.providerID !== "string" || !model.providerID.trim()) return
  if (typeof model.modelID !== "string" || !model.modelID.trim()) return
  const variant = typeof model.variant === "string" ? model.variant.trim() : undefined
  return {
    providerID: model.providerID.trim(),
    modelID: model.modelID.trim(),
    ...(variant && variant !== "default" ? { variant } : {}),
  }
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

export function setStatusVisibility(sessionID: string, visibility: StatusVisibility): State {
  return updateState((state) => {
    const sessions = { ...state.status.sessions }
    if (visibility === "auto") delete sessions[sessionID]
    if (visibility !== "auto") sessions[sessionID] = visibility
    return { ...state, status: { sessions } }
  })
}

export function putGoal(goal: Goal): State {
  return updateState((state) => ({
    ...state,
    goals: { ...state.goals, [goal.workerSessionID]: goal },
  }))
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
    delete goals[workerSessionID]
    return { ...state, goals }
  })
}

export function formatLimit(value: number | undefined, unit = ""): string {
  return value === undefined ? "Unlimited" : `${value}${unit}`
}

export function formatModel(model: ModelRef | undefined): string {
  if (!model) return "current worker model (resolved on the next step)"
  return `${model.providerID}/${model.modelID}${model.variant ? ` · ${model.variant}` : ""}`
}

export function parseCriteria(text: string): string[] {
  const marker = /(?:^|\n)\s*(?:done when|acceptance criteria|criteria)\s*:\s*/i.exec(text)
  if (!marker) return []
  const tail = text.slice((marker.index ?? 0) + marker[0].length)
  return tail
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^[-*\d.)\s]+/, "")
        .trim(),
    )
    .filter(Boolean)
}

export function goalSummary(goal: Goal): string {
  return [
    "Autopilot",
    `State: ${goal.phase}`,
    `Mode: ${goal.mode}`,
    `Questions: ${goal.questionPolicy}`,
    `Model: ${formatModel(goal.model)}`,
    `Checkpoints: ${goal.round}/${formatLimit(goal.maxCheckpoints)}`,
    `Continuations: ${goal.continuations}`,
    `Duration: ${goal.startedAt ? `${Math.max(0, Math.floor((Date.now() - goal.startedAt) / 60_000))}m` : "0m"}/${formatLimit(goal.maxMinutes, "m")}`,
    `Last verifier: ${goal.verifier ? formatModel(goal.verifier) : "not run yet"}`,
    goal.text ? `Goal: ${goal.text}` : "Goal: waiting for your next message",
  ].join("\n")
}
