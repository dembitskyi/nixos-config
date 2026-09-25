// Autopilot server: supervises build goals across normal provider stops.

import { createHash } from "node:crypto"
import type { Part, Todo } from "@opencode-ai/sdk"
import type { AssistantMessage, Event, QuestionRequest, UserMessage } from "@opencode-ai/sdk/v2"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { createLog } from "./log"
import {
  errorName,
  errorText,
  interruptedError,
  notFound,
  recommendedAnswer,
  recommendedAnswers,
  settled,
  validateAnswers,
} from "./question"
import { AUTOPILOT_RUNTIME, parseRuntimeRequest, runtimeMatches, runtimeResponse } from "./runtime"
import {
  AUTOPILOT_REFRESH_COMMAND,
  formatLimit,
  goalSummary,
  parseCriteria,
  patchGoal,
  patchGoalIf,
  putGoal,
  readState,
  removeGoal,
  storedStateVersion,
  type Goal,
  type GoalRecovery,
  type ModelRef,
} from "./state"

type RuntimeMessage = UserMessage | AssistantMessage
type MessageWithParts = { info: RuntimeMessage; parts: Part[] }
type AssistantWithParts = { info: AssistantMessage; parts: Part[] }
type RuntimeSession = {
  id: string
  parentID?: string
  directory: string
  title: string
  agent?: string
  model?: {
    providerID: string
    id?: string
    modelID?: string
    variant?: string
  }
}
type VerifierVerdict = {
  verdict: "complete" | "continue" | "adjust" | "blocked"
  confidence: number
  verified: string[]
  missing: string[]
  instruction: string
}

type VerifierSubmitArgs = {
  verdict?: unknown
  confidence?: unknown
  verified?: unknown
  missing?: unknown
  instruction?: unknown
}
type ChooserOutput = { answers?: unknown; reason?: unknown }

interface SessionClient {
  get(options: {
    path: { id: string }
    query?: { directory?: string }
  }): Promise<{ data?: RuntimeSession; error?: unknown }>
  create(options?: {
    query?: { directory?: string }
    body?: { parentID?: string; title?: string }
  }): Promise<{ data?: RuntimeSession }>
  update(options: { path: { id: string }; query?: { directory?: string }; body?: { title?: string } }): Promise<unknown>
  children(options: { path: { id: string }; query?: { directory?: string } }): Promise<{ data?: RuntimeSession[] }>
  todo(options: { path: { id: string }; query?: { directory?: string } }): Promise<{ data?: Todo[] }>
  diff(options: { path: { id: string }; query?: { directory?: string } }): Promise<{ data?: unknown[] }>
  messages(options: {
    path: { id: string }
    query?: { directory?: string; limit?: number }
  }): Promise<{ data?: MessageWithParts[] }>
  status(options?: { query?: { directory?: string } }): Promise<{ data?: Record<string, { type?: string }> }>
  prompt(options: {
    path: { id: string }
    query?: { directory?: string }
    body: {
      model: { providerID: string; modelID: string }
      messageID?: string
      agent: string
      variant?: string
      noReply?: boolean
      format?: {
        type: "json_schema"
        schema: Record<string, unknown>
        retryCount?: number
      }
      parts: Array<{
        type: "text"
        text: string
        synthetic?: boolean
        metadata?: Record<string, unknown>
      }>
    }
  }): Promise<{ data?: MessageWithParts; error?: unknown }>
  promptAsync(options: {
    path: { id: string }
    query?: { directory?: string }
    body: {
      model: { providerID: string; modelID: string }
      messageID?: string
      agent: string
      variant?: string
      noReply?: boolean
      parts: Array<{
        type: "text"
        text: string
        synthetic?: boolean
        metadata?: Record<string, unknown>
      }>
    }
  }): Promise<{ error?: unknown }>
}

interface RuntimeClient {
  readonly session: SessionClient
  readonly tui?: {
    publish(options: {
      query?: { directory?: string }
      body: { type: "tui.command.execute"; properties: { command: string } }
    }): Promise<{ error?: unknown }>
  }
  readonly _client?: {
    get(options: { url: string; query?: { directory?: string } }): Promise<{ data?: unknown; error?: unknown }>
    post(options: {
      url: string
      path?: Record<string, string>
      query?: { directory?: string }
      body?: unknown
      headers?: Record<string, string>
    }): Promise<{ data?: unknown; error?: unknown }>
  }
}

const active = (phase: Goal["phase"]) => ["working", "continuing"].includes(phase)
const interrupted = (phase: Goal["phase"]) => ["working", "verifying", "continuing"].includes(phase)
const automatingQuestions = (phase: Goal["phase"]) => active(phase) || phase === "verifying"

function addPending(pending: Map<string, Set<string>>, sessionID: string, requestID: string) {
  const requests = pending.get(sessionID) ?? new Set<string>()
  requests.add(requestID)
  pending.set(sessionID, requests)
}

function removePending(pending: Map<string, Set<string>>, sessionID: string, requestID: string) {
  const requests = pending.get(sessionID)
  if (!requests) return
  requests.delete(requestID)
  if (requests.size === 0) pending.delete(sessionID)
}

function hasPending(pending: Map<string, Set<string>>, sessionID: string) {
  return (pending.get(sessionID)?.size ?? 0) > 0
}

export const AutopilotServer: Plugin = async (input): Promise<Hooks> => {
  const log = createLog("server")
  const client = input.client as unknown as RuntimeClient
  const supervising = new Set<string>()
  const models = new Map<string, ModelRef>()
  const agents = new Map<string, string>()
  const pendingQuestions = new Map<string, Set<string>>()
  const pendingPermissions = new Map<string, Set<string>>()
  const humanRevision = new Map<string, number>()
  const internalMessages = new Set<string>()
  const submittedVerdicts = new Map<string, VerifierVerdict>()
  const verifierModels = new Map<string, ModelRef>()
  const answeringQuestions = new Set<string>()
  const questionQueues = new Map<string, Promise<void>>()
  // Worker sessions this server instance has resolved in its own database, and
  // those a 404 proved belong elsewhere. Several opencode servers (stable on
  // 4096, automation on 4097) run from the same directory with separate
  // databases but share ~/.local/share/opencode/autopilot.json, so a goal in
  // that file is not necessarily ours to supervise.
  const ownedSessions = new Set<string>()
  const foreignSessions = new Set<string>()
  let disposed = false

  const initial = readState()
  log.info("startup.begin", {
    pid: process.pid,
    directory: input.directory,
    goals: Object.keys(initial.goals).length,
    pendingTransport: Boolean(client._client),
    runtime: AUTOPILOT_RUNTIME,
  })
  // Goals that were mid-flight when this plugin instance last died. They are
  // only paused once the deferred bootstrap confirms this server owns the
  // session: the state file is shared with the sibling opencode instance, and
  // pausing its live goals from here would kill them. Resolving ownership needs
  // the transport, which is not guaranteed to be up during plugin construction.
  const interruptedGoals = Object.values(initial.goals)
    .filter((goal) => goal.directory === input.directory && interrupted(goal.phase))
    .map((goal) => goal.workerSessionID)
  log.info("startup.recovery-complete", {
    directory: input.directory,
    candidates: interruptedGoals.length,
  })

  async function recoverInterruptedGoals() {
    let recovered = 0
    for (const sessionID of interruptedGoals) {
      const goal = readState().goals[sessionID]
      if (!goal || !interrupted(goal.phase)) continue
      if (!(await ownsSession(sessionID, goal.directory))) continue
      patchGoal(sessionID, {
        phase: "paused",
        lastCheckpoint: "Autopilot restored this goal in paused mode after the server plugin restarted.",
      })
      notifyTuiState("goal.recovered-paused", sessionID)
      recovered += 1
      log.warn("goal.recovered-paused", {
        workerSessionID: sessionID,
        phase: goal.phase,
      })
    }
    log.info("goal.recovery-applied", {
      directory: input.directory,
      recovered,
    })
  }

  function compatibleGoal(goal: Goal): boolean {
    if (runtimeMatches(goal.runtime)) return true
    log.error("runtime.goal-mismatch", {
      workerSessionID: goal.workerSessionID,
      goalRuntime: goal.runtime,
      serverRuntime: AUTOPILOT_RUNTIME,
    })
    patchGoal(goal.workerSessionID, {
      phase: "blocked",
      lastCheckpoint:
        "Autopilot stopped because the TUI and server plugin versions do not match. Restart both before continuing.",
      recovery: {
        kind: "autopilot-error",
        summary: "Autopilot TUI/server version mismatch.",
        detail: `Goal runtime: ${goal.runtime ? `${goal.runtime.protocol}/${goal.runtime.fingerprint}` : "missing"}; server runtime: ${AUTOPILOT_RUNTIME.protocol}/${AUTOPILOT_RUNTIME.fingerprint}`,
      },
    })
    notifyTuiState("runtime.goal-mismatch", goal.workerSessionID)
    return false
  }

  async function hydratePendingRequests() {
    const startedAt = Date.now()
    log.info("pending.bootstrap-start", { directory: input.directory })
    const [questions, permissions] = await Promise.all([
      listPendingRequests("question").catch((error) => {
        log.warn("question.bootstrap-failed", {
          directory: input.directory,
          error: errorText(error),
        })
        return []
      }),
      listPendingRequests("permission").catch((error) => {
        log.warn("permission.bootstrap-failed", {
          directory: input.directory,
          error: errorText(error),
        })
        return []
      }),
    ])
    for (const request of questions) addPending(pendingQuestions, request.sessionID, request.id)
    for (const request of permissions) addPending(pendingPermissions, request.sessionID, request.id)
    log.info("pending.bootstrap-complete", {
      questions: questions.length,
      permissions: permissions.length,
      durationMs: Date.now() - startedAt,
    })
    for (const request of questions) {
      void queueQuestion(request).catch((error) =>
        log.error("question.bootstrap-answer-failed", {
          sessionID: request.sessionID,
          requestID: request.id,
          error: errorText(error),
        }),
      )
    }
  }

  async function listPendingRequests(kind: "question"): Promise<QuestionRequest[]>
  async function listPendingRequests(kind: "permission"): Promise<Array<{ id: string; sessionID: string }>>
  async function listPendingRequests(kind: "question" | "permission") {
    const startedAt = Date.now()
    log.debug("pending.request-start", { kind, directory: input.directory })
    const transport = client._client
    if (!transport) {
      log.warn("pending.request-unavailable", {
        kind,
        directory: input.directory,
      })
      return []
    }
    let settled = false
    const slowTimer = setTimeout(() => {
      if (!settled)
        log.warn("pending.request-slow", {
          kind,
          directory: input.directory,
          elapsedMs: Date.now() - startedAt,
        })
    }, 5_000)
    try {
      const response = await transport.get({
        url: `/${kind}`,
        query: { directory: input.directory },
      })
      if (response.error) throw response.error
      const requests = Array.isArray(response.data)
        ? response.data.filter((request): request is { id: string; sessionID: string } =>
            Boolean(
              request &&
                typeof request === "object" &&
                "id" in request &&
                typeof request.id === "string" &&
                "sessionID" in request &&
                typeof request.sessionID === "string",
            ),
          )
        : []
      log.debug("pending.request-complete", {
        kind,
        directory: input.directory,
        requests: requests.length,
        durationMs: Date.now() - startedAt,
      })
      return requests as QuestionRequest[] | Array<{ id: string; sessionID: string }>
    } catch (error) {
      log.warn("pending.request-failed", {
        kind,
        directory: input.directory,
        durationMs: Date.now() - startedAt,
        error: errorText(error),
      })
      throw error
    } finally {
      settled = true
      clearTimeout(slowTimer)
    }
  }

  // Whether the worker session backing a goal lives in this server's database.
  // The sweep below cannot tell "session is idle" from "session is not mine"
  // via session.status alone — both yield no status entry — so ownership has to
  // be resolved explicitly before a goal is supervised or paused.
  async function ownsSession(sessionID: string, directory: string): Promise<boolean> {
    if (ownedSessions.has(sessionID)) return true
    const { session, missing } = await lookupSession(sessionID, directory)
    if (session) {
      ownedSessions.add(sessionID)
      foreignSessions.delete(sessionID)
      return true
    }
    // Only a genuine 404 proves the session belongs to another instance. A
    // transport failure means "unknown", so leave the goal untouched and retry
    // on the next sweep rather than latching it away from its owner.
    if (missing && !foreignSessions.has(sessionID)) {
      foreignSessions.add(sessionID)
      log.info("goal.foreign-instance", {
        workerSessionID: sessionID,
        directory,
      })
    }
    return false
  }

  async function onIdle(sessionID: string) {
    const observed = readState().goals[sessionID]
    if (!observed) return
    if (!(await ownsSession(sessionID, observed.directory))) return
    log.debug("worker.idle", {
      workerSessionID: sessionID,
      phase: observed.phase,
      round: observed.round,
    })
    if (!active(observed.phase) || supervising.has(sessionID) || !compatibleGoal(observed)) return
    supervising.add(sessionID)
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const goal = readState().goals[sessionID]
      if (!goal || !active(goal.phase)) return
      await verify(goal)
    } catch (error) {
      const goal = readState().goals[sessionID]
      const detail = errorText(error)
      log.error("verification.failed", {
        workerSessionID: sessionID,
        error: detail,
      })
      if (goal && interrupted(goal.phase))
        await pause(goal, "blocked", `Autopilot verification failed: ${detail}`, {
          kind: "autopilot-error",
          summary: detail,
          detail,
        })
    } finally {
      supervising.delete(sessionID)
      notifyTuiState("worker.idle", sessionID)
    }
  }

  function notifyTuiState(source: string, workerSessionID: string) {
    const request = client.tui?.publish({
      query: { directory: input.directory },
      body: {
        type: "tui.command.execute",
        properties: { command: AUTOPILOT_REFRESH_COMMAND },
      },
    })
    if (!request) {
      log.warn("state.notify-unavailable", { source, workerSessionID })
      return
    }
    void request
      .then((result) => {
        if (result.error) {
          log.warn("state.notify-failed", {
            source,
            workerSessionID,
            error: errorText(result.error),
          })
          return
        }
        log.debug("state.notified", { source, workerSessionID })
      })
      .catch((error) =>
        log.warn("state.notify-failed", {
          source,
          workerSessionID,
          error: errorText(error),
        }),
      )
  }

  async function goalForSession(sessionID: string, directory: string): Promise<Goal | undefined> {
    const state = readState()
    const direct = state.goals[sessionID]
    if (direct) return direct
    const internal = Object.values(state.goals).find(
      (goal) => goal.verifierSessionID === sessionID || goal.chooserSessionID === sessionID,
    )
    if (internal) return internal
    const seen = new Set<string>()
    let cursor: string | undefined = sessionID
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const goal = state.goals[cursor]
      if (goal) return goal
      const session = await sessionInfo(cursor, directory)
      cursor = session?.parentID
    }
  }

  async function answerQuestion(request: QuestionRequest) {
    if (disposed) return
    if (answeringQuestions.has(request.id)) return
    const goal = await goalForSession(request.sessionID, input.directory)
    if (!goal || !automatingQuestions(goal.phase) || goal.questionPolicy === "manual" || !compatibleGoal(goal)) {
      log.debug("question.automation-skip", {
        sessionID: request.sessionID,
        requestID: request.id,
        workerSessionID: goal?.workerSessionID,
        phase: goal?.phase,
        questionPolicy: goal?.questionPolicy ?? "none",
      })
      return
    }
    if (request.sessionID === goal.verifierSessionID || request.sessionID === goal.chooserSessionID) {
      await pause(goal, "blocked", `Internal Autopilot session ${request.sessionID} requested user input.`)
      notifyTuiState("question.internal-blocked", goal.workerSessionID)
      return
    }
    answeringQuestions.add(request.id)
    try {
      const recommended = recommendedAnswers(request)
      if (recommended) {
        await replyQuestion(goal, request, recommended, "recommended")
        return
      }
      if (goal.questionPolicy === "recommended") {
        patchGoal(goal.workerSessionID, {
          phase: "waiting-user",
          lastCheckpoint: `Autopilot is waiting for you to answer question ${request.id}.`,
        })
        notifyTuiState("question.waiting-user", goal.workerSessionID)
        log.info("question.waiting-manual", {
          workerSessionID: goal.workerSessionID,
          requestID: request.id,
          reason: "no-unambiguous-recommendation",
        })
        return
      }
      const fixed = request.questions.map(recommendedAnswer)
      const unresolved = request.questions.flatMap((question, index) => (fixed[index] ? [] : [{ question, index }]))
      const chooserRequest: QuestionRequest = {
        ...request,
        questions: unresolved.map((item) => item.question),
      }
      const chosen = await chooseAnswers(goal, chooserRequest)
      if (!chosen) {
        await pause(goal, "blocked", `Question chooser could not select a valid listed answer for ${request.id}.`)
        notifyTuiState("question.chooser-blocked", goal.workerSessionID)
        return
      }
      const answers = fixed.map((answer) => answer ?? [])
      unresolved.forEach((item, index) => {
        answers[item.index] = chosen[index] ?? []
      })
      const validated = validateAnswers(request, answers)
      if (!validated) {
        await pause(goal, "blocked", `Question chooser could not select a valid listed answer for ${request.id}.`)
        notifyTuiState("question.chooser-blocked", goal.workerSessionID)
        return
      }
      await replyQuestion(goal, request, validated, "best-fit")
    } catch (error) {
      if (settled(error)) {
        removePending(pendingQuestions, request.sessionID, request.id)
        log.info("question.already-settled", {
          workerSessionID: goal?.workerSessionID,
          sessionID: request.sessionID,
          requestID: request.id,
          strategy: "automation",
        })
        return
      }
      log.error("question.answer-failed", {
        workerSessionID: goal?.workerSessionID,
        sessionID: request.sessionID,
        requestID: request.id,
        error: errorText(error),
      })
      if (goal) {
        await pause(goal, "blocked", `Question auto-answer failed for ${request.id}: ${errorText(error)}`)
        notifyTuiState("question.answer-failed", goal.workerSessionID)
      }
    } finally {
      answeringQuestions.delete(request.id)
    }
  }

  async function queueQuestion(request: QuestionRequest) {
    if (disposed) return
    const goal = await goalForSession(request.sessionID, input.directory)
    const key = goal?.workerSessionID ?? request.sessionID
    const previous = questionQueues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => answerQuestion(request))
    questionQueues.set(key, next)
    try {
      await next
    } finally {
      if (questionQueues.get(key) === next) questionQueues.delete(key)
    }
  }

  async function replyQuestion(goal: Goal, request: QuestionRequest, answers: string[][], strategy: string) {
    const transport = client._client
    if (!transport) throw new Error("Question reply transport is unavailable")
    const result = await transport.post({
      url: "/question/{requestID}/reply",
      path: { requestID: request.id },
      query: { directory: goal.directory },
      body: { answers },
      headers: { "Content-Type": "application/json" },
    })
    if (result.error) {
      if (settled(result.error)) {
        removePending(pendingQuestions, request.sessionID, request.id)
        log.info("question.already-settled", {
          workerSessionID: goal.workerSessionID,
          sessionID: request.sessionID,
          requestID: request.id,
          strategy,
        })
        return
      }
      throw result.error
    }
    removePending(pendingQuestions, request.sessionID, request.id)
    log.info("question.auto-replied", {
      workerSessionID: goal.workerSessionID,
      sessionID: request.sessionID,
      requestID: request.id,
      strategy,
      answers: answers.flat(),
    })
    notifyTuiState("question.auto-replied", goal.workerSessionID)
  }

  async function chooseAnswers(goal: Goal, request: QuestionRequest): Promise<string[][] | undefined> {
    const worker = await sessionInfo(goal.workerSessionID, goal.directory)
    if (!worker) {
      log.warn("question.chooser-worker-missing", {
        workerSessionID: goal.workerSessionID,
        requestID: request.id,
      })
      return
    }
    const messages = await sessionMessages(goal.workerSessionID, goal.directory)
    const questionMessages =
      request.sessionID === goal.workerSessionID ? messages : await sessionMessages(request.sessionID, goal.directory)
    const model = await reviewModel(goal, worker, messages)
    if (!model) {
      log.warn("question.chooser-model-missing", {
        workerSessionID: goal.workerSessionID,
        requestID: request.id,
      })
      return
    }
    const chooser = await ensureChooser(goal, worker, model)
    if (!chooser) {
      log.warn("question.chooser-session-missing", {
        workerSessionID: goal.workerSessionID,
        requestID: request.id,
      })
      return
    }
    log.info("question.chooser-start", {
      workerSessionID: goal.workerSessionID,
      chooserSessionID: chooser.id,
      requestID: request.id,
      model: `${model.providerID}/${model.modelID}`,
      variant: model.variant,
    })
    const response = await client.session.prompt({
      path: { id: chooser.id },
      query: { directory: goal.directory },
      body: {
        model: { providerID: model.providerID, modelID: model.modelID },
        variant: model.variant,
        agent: "autopilot-chooser",
        format: chooserFormat(request),
        parts: [
          {
            type: "text",
            text: chooserPacket(goal, request, questionMessages),
          },
        ],
      },
    })
    if (response.error || response.data?.info.role !== "assistant") {
      log.warn("question.chooser-failed", {
        workerSessionID: goal.workerSessionID,
        chooserSessionID: chooser.id,
        requestID: request.id,
        error: response.error ? errorText(response.error) : "Chooser returned no assistant response",
      })
      return
    }
    const output = response.data.info.structured as ChooserOutput | undefined
    const answers = validateAnswers(request, output?.answers)
    log.info("question.chooser-result", {
      workerSessionID: goal.workerSessionID,
      chooserSessionID: chooser.id,
      requestID: request.id,
      valid: Boolean(answers),
      reason: typeof output?.reason === "string" ? output.reason : undefined,
    })
    return answers
  }

  async function ensureChooser(
    goal: Goal,
    worker: RuntimeSession,
    model: ModelRef,
  ): Promise<RuntimeSession | undefined> {
    if (goal.chooserSessionID) {
      const existing = await sessionInfo(goal.chooserSessionID, worker.directory)
      if (existing) {
        log.debug("chooser.reuse", {
          workerSessionID: worker.id,
          chooserSessionID: existing.id,
        })
        return existing
      }
    }
    const created = await client.session.create({
      query: { directory: worker.directory },
      body: {
        parentID: worker.id,
        title: `Autopilot Question Chooser · ${short(goal.text ?? "Goal")}`,
      },
    })
    const chooser = created.data
    if (!chooser) return
    patchGoal(worker.id, { chooserSessionID: chooser.id })
    notifyTuiState("chooser.created", worker.id)
    log.info("chooser.created", {
      workerSessionID: worker.id,
      chooserSessionID: chooser.id,
    })
    return chooser
  }

  async function verify(goal: Goal) {
    log.info("verification.start", {
      workerSessionID: goal.workerSessionID,
      round: goal.round + 1,
    })
    const { session: worker, missing } = await lookupSession(goal.workerSessionID, goal.directory)
    if (!worker) {
      // A failed lookup is not proof the session is gone; only a 404 is. Keep
      // the goal running and let the next sweep retry.
      if (!missing) {
        log.warn("verification.session-unavailable", {
          workerSessionID: goal.workerSessionID,
        })
        return
      }
      ownedSessions.delete(goal.workerSessionID)
      return pause(goal, "blocked", "Worker session no longer exists.")
    }
    if ((agents.get(goal.workerSessionID) ?? goal.workerAgent ?? "build") !== "build") {
      return pause(goal, "blocked", "Autopilot goal completion only drives the build agent.")
    }

    const messages = await sessionMessages(goal.workerSessionID, worker.directory)
    const lastAssistant = [...messages]
      .reverse()
      .find((message): message is AssistantWithParts => message.info.role === "assistant")
    if (!lastAssistant) {
      log.debug("verification.skip-no-assistant", {
        workerSessionID: worker.id,
      })
      return
    }
    const model = await reviewModel(goal, worker, messages)
    if (!model) return pause(goal, "blocked", "Could not resolve the review model for verification.")
    await runVerification(goal, worker, messages, lastAssistant, model)
  }

  async function runVerification(
    goal: Goal,
    worker: RuntimeSession,
    messages: MessageWithParts[],
    lastAssistant: AssistantWithParts,
    reviewModel: ModelRef,
  ) {
    const lastAssistantID = lastAssistant.info.id
    if (lastAssistantID === goal.lastIdleMessageID) {
      log.debug("verification.skip-duplicate-idle", {
        workerSessionID: worker.id,
        lastAssistantID,
      })
      return
    }
    if (lastAssistant.info.error) return handleWorkerError(goal, lastAssistant)
    if (hasPending(pendingQuestions, worker.id)) {
      log.info("verification.waiting-question", {
        workerSessionID: worker.id,
        questionPolicy: goal.questionPolicy,
        chooserActive: answeringQuestions.size > 0,
      })
      return
    }
    if (hasPending(pendingPermissions, worker.id)) {
      log.info("verification.waiting-permission", {
        workerSessionID: worker.id,
      })
      return
    }

    const [children, todos, diffs] = await Promise.all([
      client.session.children({
        path: { id: worker.id },
        query: { directory: worker.directory },
      }),
      client.session
        .todo({
          path: { id: worker.id },
          query: { directory: worker.directory },
        })
        .catch(() => ({ data: [] })),
      client.session
        .diff({
          path: { id: worker.id },
          query: { directory: worker.directory },
        })
        .catch(() => ({ data: [] })),
    ])
    const statuses = await client.session.status({ query: { directory: worker.directory } }).catch((error) => {
      log.warn("verification.status-failed", {
        workerSessionID: worker.id,
        error: errorText(error),
      })
      return undefined
    })
    if (!statuses) return
    const descendants = await collectDescendants(client.session, children.data ?? [], worker.directory)
    if (descendants.some((child) => hasPending(pendingQuestions, child.id))) {
      log.info("verification.waiting-child-question", {
        workerSessionID: worker.id,
        questionPolicy: goal.questionPolicy,
        chooserActive: answeringQuestions.size > 0,
      })
      return
    }
    if (descendants.some((child) => hasPending(pendingPermissions, child.id))) {
      log.info("verification.waiting-child-permission", {
        workerSessionID: worker.id,
      })
      return
    }
    const busyChildren = descendants.filter((child) => {
      const status = statuses.data?.[child.id]
      return status !== undefined && status.type !== "idle"
    })
    if (busyChildren.length > 0) {
      log.info("verification.waiting-children", {
        workerSessionID: worker.id,
        children: busyChildren.map((child) => child.id),
      })
      return
    }

    const revision = goal.revision
    const model = reviewModel
    const verifier = await ensureVerifier(goal, worker, model)
    if (!verifier) return pause(goal, "blocked", "Could not create the verifier session.")

    const packet = verificationPacket({
      goal,
      worker,
      model,
      messages,
      todos: todos.data ?? [],
      diffs: diffs.data ?? [],
      children: descendants,
      lastAssistant,
    })
    log.info("verification.evidence", {
      workerSessionID: worker.id,
      verifierSessionID: verifier.id,
      model: `${model.providerID}/${model.modelID}`,
      variant: model.variant,
      messages: messages.length,
      todos: (todos.data ?? []).length,
      diffs: (diffs.data ?? []).length,
      children: descendants.length,
    })
    const started = patchGoalIf(worker.id, (current) => current.revision === revision && active(current.phase), {
      phase: "verifying",
      activeReviewModel: model,
    })
    if (!started) {
      log.info("verification.cancelled-stale", {
        workerSessionID: worker.id,
        revision,
      })
      return
    }
    verifierModels.set(verifier.id, model)
    const response: { data?: MessageWithParts; error?: unknown } = await client.session
      .prompt({
        path: { id: verifier.id },
        query: { directory: worker.directory },
        body: {
          model: { providerID: model.providerID, modelID: model.modelID },
          variant: model.variant,
          agent: "autopilot-verifier",
          parts: [{ type: "text", text: packet }],
        },
      })
      .catch((error): { error: unknown } => ({ error }))
    if (response.error || !response.data) {
      verifierModels.delete(verifier.id)
      return pause(goal, "blocked", `Verifier failed: ${errorText(response.error)}`)
    }
    const current = readState().goals[worker.id]
    if (!current || current.revision !== revision || current.phase !== "verifying") {
      submittedVerdicts.delete(verifier.id)
      verifierModels.delete(verifier.id)
      return
    }
    const verdict =
      submittedVerdicts.get(verifier.id) ??
      (response.data.info.role === "assistant" ? parseVerdict(response.data.info.structured) : undefined)
    submittedVerdicts.delete(verifier.id)
    verifierModels.delete(verifier.id)
    if (!verdict) return pause(goal, "blocked", "Verifier returned an invalid structured verdict.")
    const workerModel = () => currentModel(worker, messages, models.get(worker.id))
    const sendCurrentWorker = async (text: string, noReply: boolean) => {
      const selected = workerModel()
      if (!selected) throw new Error("Could not resolve the current build model.")
      await sendWorker(worker, selected, text, noReply)
    }
    const applyReview = (patch: Partial<Goal>) => {
      const latest = readState().goals[worker.id]
      if (!latest || latest.revision !== revision || latest.phase !== "verifying") return
      return patchGoal(worker.id, patch)
    }

    const fingerprint = progressFingerprint(goal, verdict, todos.data ?? [], diffs.data ?? [])
    const noProgressRounds = fingerprint === goal.lastFingerprint ? goal.noProgressRounds + 1 : 1
    log.info("verification.verdict", {
      workerSessionID: worker.id,
      verifierSessionID: verifier.id,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      verified: verdict.verified.length,
      missing: verdict.missing.length,
      noProgressRounds,
    })
    const checkpoint = checkpointText(goal, model, verifier.id, verdict, {
      messages: messages.length,
      todos: todos.data ?? [],
      diffs: diffs.data ?? [],
      children: descendants,
      finish: typeof lastAssistant.info.finish === "string" ? lastAssistant.info.finish : "unknown",
    })
    const basePatch = {
      round: goal.round + 1,
      noProgressRounds,
      lastFingerprint: fingerprint,
      lastInstruction: verdict.instruction,
      lastCheckpoint: checkpoint,
      lastVerifierMessageID: response.data.info.id as string,
      lastIdleMessageID: lastAssistantID,
      activeReviewModel: undefined,
      lastReviewModel: model,
    }

    if (verdict.verdict === "complete") {
      if (!applyReview({ ...basePatch, phase: "complete" })) return
      notifyTuiState("goal.complete", worker.id)
      await sendCurrentWorker(checkpoint, true)
      return
    }
    if (verdict.verdict === "blocked") {
      if (!applyReview({ ...basePatch, phase: "blocked" })) return
      notifyTuiState("goal.blocked", worker.id)
      await sendCurrentWorker(checkpoint, true)
      return
    }
    const limit = limitReason(goal)
    if (limit) {
      const exhausted = `${checkpoint}\n\nAutopilot paused: ${limit}`
      if (!applyReview({ ...basePatch, phase: "exhausted", lastCheckpoint: exhausted })) return
      notifyTuiState("goal.exhausted", worker.id)
      await sendCurrentWorker(exhausted, true)
      return
    }
    if (noProgressRounds >= goal.noProgressLimit) {
      const stalled = `${checkpoint}\n\nAutopilot paused: no progress was detected across ${noProgressRounds} consecutive verification rounds.`
      if (!applyReview({ ...basePatch, phase: "stalled", lastCheckpoint: stalled })) return
      notifyTuiState("goal.stalled", worker.id)
      await sendCurrentWorker(stalled, true)
      return
    }
    if (goal.mode === "monitor") {
      if (!applyReview({ ...basePatch, phase: "paused" })) return
      notifyTuiState("goal.monitor-paused", worker.id)
      await sendCurrentWorker(checkpoint, true)
      return
    }

    const next = continuationText(checkpoint, verdict.instruction)
    if (
      !applyReview({
        ...basePatch,
        phase: "continuing",
        continuations: goal.continuations + 1,
      })
    )
      return
    notifyTuiState("goal.continuing", worker.id)
    await sendCurrentWorker(next, false)
    log.info("worker.continue", {
      workerSessionID: worker.id,
      round: goal.round + 1,
      instructionBytes: verdict.instruction.length,
      instructionHash: createHash("sha256").update(verdict.instruction).digest("hex").slice(0, 12),
    })
  }

  async function ensureVerifier(
    goal: Goal,
    worker: RuntimeSession,
    model: ModelRef,
  ): Promise<RuntimeSession | undefined> {
    if (goal.verifierSessionID) {
      const existing = await sessionInfo(goal.verifierSessionID, worker.directory)
      if (existing) {
        log.debug("verifier.reuse", {
          workerSessionID: worker.id,
          verifierSessionID: existing.id,
        })
        return existing
      }
    }
    const created = await client.session.create({
      query: { directory: worker.directory },
      body: {
        parentID: worker.id,
        title: `Autopilot Verifier · ${short(goal.text ?? "Goal")}`,
      },
    })
    const verifier = created.data
    if (!verifier) return
    patchGoal(worker.id, { verifierSessionID: verifier.id })
    log.info("verifier.created", {
      workerSessionID: worker.id,
      verifierSessionID: verifier.id,
    })
    return verifier
  }

  async function sendWorker(worker: RuntimeSession, model: ModelRef, text: string, noReply: boolean) {
    const messageID = `msg_autopilot_${Date.now()}_${Math.random().toString(36).slice(2)}`
    internalMessages.add(messageID)
    const result = await client.session.promptAsync({
      path: { id: worker.id },
      query: { directory: worker.directory },
      body: {
        messageID,
        model: { providerID: model.providerID, modelID: model.modelID },
        variant: model.variant,
        agent: "build",
        noReply,
        parts: [{ type: "text", text }],
      },
    })
    if (result.error) throw new Error(errorText(result.error))
    log.debug("worker.inject", {
      workerSessionID: worker.id,
      messageID,
      noReply,
    })
  }

  // Resolving a session separates "deleted" (404) from "lookup failed", which
  // the callers below must not conflate: only the former may block a goal.
  async function lookupSession(sessionID: string, directory: string) {
    const result = await client.session
      .get({ path: { id: sessionID }, query: { directory } })
      .catch((error: unknown) => ({ data: undefined, error }))
    return { session: result.data, missing: !result.data && notFound(result.error) }
  }

  async function sessionInfo(sessionID: string, directory: string) {
    return (await lookupSession(sessionID, directory)).session
  }

  async function sessionMessages(sessionID: string, directory: string) {
    return client.session
      .messages({ path: { id: sessionID }, query: { directory, limit: 200 } })
      .then((result) => result.data ?? [])
      .catch(() => [])
  }

  async function pause(
    goal: Goal,
    phase: Goal["phase"],
    reason: string,
    recovery: GoalRecovery = { kind: "autopilot-error", summary: reason, detail: reason },
  ) {
    const worker = await sessionInfo(goal.workerSessionID, goal.directory)
    const latest = readState().goals[goal.workerSessionID] ?? goal
    const model = worker
      ? currentModel(worker, await sessionMessages(worker.id, worker.directory), models.get(worker.id))
      : undefined
    const checkpoint = `Autopilot paused\n\nReason: ${reason}\n\n${goalSummary({ ...latest, phase })}`
    patchGoal(goal.workerSessionID, { phase, lastCheckpoint: checkpoint, recovery })
    notifyTuiState("goal.paused", goal.workerSessionID)
    log.warn("goal.paused", {
      workerSessionID: goal.workerSessionID,
      phase,
      reason,
    })
    if (worker && model) await sendWorker(worker, model, checkpoint, true).catch(() => {})
  }

  async function handleWorkerError(goal: Goal, assistant: AssistantWithParts) {
    const error = assistant.info.error
    if (!error) return
    const interrupted = interruptedError(error)
    const detail = errorText(error)
    const name = errorName(error)
    const summary = interrupted
      ? `Worker turn interrupted${detail ? `: ${detail}` : ""}`
      : `${name ?? "Worker error"}: ${detail}`
    await pause(goal, interrupted ? "paused" : "blocked", summary, {
      kind: interrupted ? "interrupted" : "worker-error",
      summary,
      messageID: assistant.info.id,
      errorName: name,
      detail,
    })
  }

  async function reviewModel(
    goal: Goal,
    worker: RuntimeSession,
    messages: MessageWithParts[],
  ): Promise<ModelRef | undefined> {
    if (goal.reviewModel) return goal.reviewModel
    const resolved = currentModel(worker, messages, models.get(goal.workerSessionID))
    if (!resolved) return
    patchGoal(goal.workerSessionID, { reviewModel: resolved })
    notifyTuiState("goal.review-model-resolved", goal.workerSessionID)
    log.info("goal.review-model-resolved", {
      workerSessionID: goal.workerSessionID,
      reviewModel: `${resolved.providerID}/${resolved.modelID}`,
      variant: resolved.variant,
    })
    return resolved
  }

  async function sweepIdleGoals() {
    const goals = Object.values(readState().goals).filter(
      (goal) =>
        goal.directory === input.directory && active(goal.phase) && !foreignSessions.has(goal.workerSessionID),
    )
    if (goals.length === 0) return
    const statuses = await client.session.status({ query: { directory: input.directory } }).catch((error) => {
      log.warn("sweep.status-failed", {
        directory: input.directory,
        error: errorText(error),
      })
      return undefined
    })
    if (!statuses) return
    for (const goal of goals) {
      const status = statuses.data?.[goal.workerSessionID]
      if (!status || status.type === "idle") await onIdle(goal.workerSessionID)
    }
  }

  const sweepTimer = setInterval(() => {
    void sweepIdleGoals().catch((error) =>
      log.error("sweep.failed", {
        directory: input.directory,
        error: errorText(error),
      }),
    )
  }, 2_000)
  const bootstrapTimer = setTimeout(() => {
    // Recovery runs first so an interrupted goal is paused before the pending
    // question backlog can drive it further.
    void recoverInterruptedGoals()
      .catch((error) =>
        log.error("goal.recovery-failed", {
          directory: input.directory,
          error: errorText(error),
        }),
      )
      .then(() =>
        hydratePendingRequests().catch((error) =>
          log.error("pending.bootstrap-failed", {
            directory: input.directory,
            error: errorText(error),
          }),
        ),
      )
  }, 0)
  log.info("pending.bootstrap-scheduled", { directory: input.directory })
  log.info("startup.ready", {
    pid: process.pid,
    directory: input.directory,
    sweepIntervalMs: 2_000,
    bootstrapDeferred: true,
    runtime: AUTOPILOT_RUNTIME,
  })

  return {
    tool: {
      autopilot_submit: {
        description:
          "Submit the final structured Autopilot verification verdict. Only the autopilot-verifier agent may call this tool.",
        args: {
          verdict: {
            type: "string",
            enum: ["complete", "continue", "adjust", "blocked"],
            description: "Verification result.",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Confidence from 0 to 1.",
          },
          verified: {
            type: "array",
            items: { type: "string" },
            description: "Criteria supported by evidence.",
          },
          missing: {
            type: "array",
            items: { type: "string" },
            description: "Criteria that remain unsupported.",
          },
          instruction: {
            type: "string",
            description: "Precise next action for the build agent.",
          },
        },
        execute: async (args: VerifierSubmitArgs, context: { sessionID: string; agent: string }) => {
          if (context.agent !== "autopilot-verifier") return "Autopilot verdict rejected: wrong agent."
          const verdict = parseVerdict(args)
          if (!verdict) return "Autopilot verdict rejected: invalid fields."
          const expected = verifierModels.get(context.sessionID)
          if (!expected) return "Autopilot verdict rejected: no verification is active for this session."
          const actual = models.get(context.sessionID)
          if (
            actual &&
            (actual.providerID !== expected.providerID ||
              actual.modelID !== expected.modelID ||
              (actual.variant ?? "default") !== (expected.variant ?? "default"))
          ) {
            log.error("verifier.model-mismatch", {
              verifierSessionID: context.sessionID,
              expected: `${expected.providerID}/${expected.modelID}:${expected.variant ?? "default"}`,
              actual: `${actual.providerID}/${actual.modelID}:${actual.variant ?? "default"}`,
            })
            return "Autopilot verdict rejected: verifier model does not match the active review model."
          }
          if (submittedVerdicts.has(context.sessionID))
            return "Autopilot verdict rejected: a verdict was already submitted."
          submittedVerdicts.set(context.sessionID, verdict)
          log.info("verifier.submitted", {
            verifierSessionID: context.sessionID,
            verdict: verdict.verdict,
            confidence: verdict.confidence,
          })
          return "Autopilot verdict recorded. End this turn now."
        },
      },
    } as unknown as Hooks["tool"],
    "chat.message": async (message, output) => {
      const model: ModelRef | undefined = message.model
        ? {
            providerID: message.model.providerID,
            modelID: message.model.modelID,
            variant: message.variant,
          }
        : undefined
      if (model) models.set(message.sessionID, model)
      if (message.agent) agents.set(message.sessionID, message.agent)
      const goal = readState().goals[message.sessionID]
      if (!goal) return
      if (!compatibleGoal(goal)) return
      if (internalMessages.delete(message.messageID ?? "")) {
        if (goal.phase === "continuing") {
          patchGoal(message.sessionID, { phase: "working" })
          notifyTuiState("worker.working", message.sessionID)
        }
        return
      }

      if (goal.phase === "waiting-goal") {
        if ((message.agent ?? output.message.agent) !== "build") {
          const blocked =
            "Autopilot goal completion requires the build agent. Switch to build and start the goal again."
          patchGoal(message.sessionID, {
            phase: "blocked",
            lastCheckpoint: blocked,
          })
          output.parts.push({
            type: "text",
            text: blocked,
            synthetic: true,
          } as unknown as Part)
          log.warn("goal.rejected-agent", {
            workerSessionID: message.sessionID,
            agent: message.agent ?? output.message.agent,
          })
          return
        }
        const text = output.parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic)
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) return
        const criteria = parseCriteria(text)
        const now = Date.now()
        const selectedReviewModel = goal.reviewModel ?? model
        const armed: Goal = {
          ...goal,
          text,
          criteria,
          phase: "working",
          startedAt: now,
          updatedAt: now,
          revision: goal.revision + 1,
          workerAgent: message.agent ?? output.message.agent ?? "build",
          reviewModel: selectedReviewModel,
          activeReviewModel: undefined,
          lastReviewModel: undefined,
          acknowledgementPending: true,
        }
        putGoal(armed)
        notifyTuiState("goal.armed", message.sessionID)
        log.info("goal.armed", {
          workerSessionID: message.sessionID,
          mode: armed.mode,
          questionPolicy: armed.questionPolicy,
          maxCheckpoints: armed.maxCheckpoints ?? "unlimited",
          maxMinutes: armed.maxMinutes ?? "unlimited",
          criteria: criteria.length,
          workerModel: model ? `${model.providerID}/${model.modelID}` : "unresolved",
          reviewModel: armed.reviewModel
            ? `${armed.reviewModel.providerID}/${armed.reviewModel.modelID}`
            : "unresolved",
          reviewVariant: armed.reviewModel?.variant,
        })
        output.parts.push({
          type: "text",
          text: `${initialContract(armed)}\n\nUse the user's complete goal message below as the task specification.`,
          synthetic: true,
          metadata: { autopilot: true },
        } as unknown as Part)
        return
      }

      const synthetic =
        output.parts.length > 0 && output.parts.every((part) => "synthetic" in part && part.synthetic === true)
      if (synthetic) return
      const revision = Math.max(humanRevision.get(message.sessionID) ?? 0, goal.revision) + 1
      humanRevision.set(message.sessionID, revision)
      if (active(goal.phase) || goal.phase === "verifying") {
        patchGoal(message.sessionID, {
          phase: "paused",
          revision,
          lastCheckpoint: "Autopilot paused because a new user message changed the supervised session context.",
        })
        notifyTuiState("goal.human-steer", message.sessionID)
      }
      log.info("goal.human-steer", {
        workerSessionID: message.sessionID,
        revision,
      })
    },
    "experimental.text.complete": async (message, output) => {
      const goal = readState().goals[message.sessionID]
      if (!goal?.acknowledgementPending) return
      output.text = `${initialContract(goal)}\n\n${output.text}`
      patchGoal(message.sessionID, { acknowledgementPending: false })
      log.info("goal.acknowledged", {
        workerSessionID: message.sessionID,
        messageID: message.messageID,
      })
    },
    event: async ({ event }) => {
      const data = event as Event
      if (data.type === "tui.command.execute") {
        const request = parseRuntimeRequest(data.properties.command)
        if (request) {
          notifyRuntime(request.nonce, request.runtime)
          return
        }
      }
      if (data.type === "message.updated" && data.properties.info.role === "user") {
        const info = data.properties.info
        if (info.model)
          models.set(info.sessionID, {
            providerID: info.model.providerID,
            modelID: info.model.modelID,
            variant: info.model.variant,
          })
        agents.set(info.sessionID, info.agent)
      }
      if (data.type === "session.deleted") {
        const id = data.properties.info.id
        ownedSessions.delete(id)
        foreignSessions.delete(id)
        const goal = readState().goals[id]
        if (goal) {
          removeGoal(id)
          notifyTuiState("goal.removed-session-deleted", id)
          log.info("goal.removed-session-deleted", { workerSessionID: id })
        }
      }
      if (data.type === "question.asked") {
        addPending(pendingQuestions, data.properties.sessionID, data.properties.id)
        log.info("question.pending", {
          sessionID: data.properties.sessionID,
          requestID: data.properties.id,
          pending: pendingQuestions.get(data.properties.sessionID)?.size ?? 0,
        })
        void queueQuestion(data.properties).catch((error) =>
          log.error("question.event-failed", {
            sessionID: data.properties.sessionID,
            requestID: data.properties.id,
            error: errorText(error),
          }),
        )
      }
      if (data.type === "question.replied" || data.type === "question.rejected") {
        removePending(pendingQuestions, data.properties.sessionID, data.properties.requestID)
        log.info("question.settled", {
          sessionID: data.properties.sessionID,
          requestID: data.properties.requestID,
          pending: pendingQuestions.get(data.properties.sessionID)?.size ?? 0,
        })
        const goal = await goalForSession(data.properties.sessionID, input.directory)
        if (goal?.phase === "waiting-user") {
          patchGoal(goal.workerSessionID, {
            phase: "working",
            revision: goal.revision + 1,
            lastIdleMessageID: undefined,
            lastCheckpoint: `Question ${data.properties.requestID} was settled; Autopilot resumed.`,
          })
          notifyTuiState("question.user-settled", goal.workerSessionID)
        }
      }
      if (data.type === "permission.asked") {
        addPending(pendingPermissions, data.properties.sessionID, data.properties.id)
        log.info("permission.pending", {
          sessionID: data.properties.sessionID,
          requestID: data.properties.id,
          pending: pendingPermissions.get(data.properties.sessionID)?.size ?? 0,
        })
        const goal = await goalForSession(data.properties.sessionID, input.directory)
        if (goal) {
          log.info("permission.left-manual", {
            workerSessionID: goal.workerSessionID,
            sessionID: data.properties.sessionID,
            requestID: data.properties.id,
          })
        }
      }
      if (data.type === "permission.replied") {
        removePending(pendingPermissions, data.properties.sessionID, data.properties.requestID)
        log.info("permission.settled", {
          sessionID: data.properties.sessionID,
          requestID: data.properties.requestID,
          pending: pendingPermissions.get(data.properties.sessionID)?.size ?? 0,
        })
      }
      if (data.type === "session.status" && data.properties.status.type === "idle")
        await onIdle(data.properties.sessionID)
      if (data.type === "session.idle") await onIdle(data.properties.sessionID)
    },
    dispose: async () => {
      disposed = true
      clearTimeout(bootstrapTimer)
      clearInterval(sweepTimer)
      log.info("shutdown", { directory: input.directory })
    },
  }

  function notifyRuntime(nonce: string, tuiRuntime: typeof AUTOPILOT_RUNTIME) {
    const response = client.tui?.publish({
      query: { directory: input.directory },
      body: { type: "tui.command.execute", properties: { command: runtimeResponse(nonce) } },
    })
    log.info("runtime.handshake", {
      nonce,
      compatible: runtimeMatches(tuiRuntime),
      tuiRuntime,
      serverRuntime: AUTOPILOT_RUNTIME,
      storedStateVersion: storedStateVersion(),
    })
    void response?.catch((error) => log.warn("runtime.response-failed", { nonce, error: errorText(error) }))
  }
}

function currentModel(worker: RuntimeSession, messages: MessageWithParts[], observed?: ModelRef): ModelRef | undefined {
  if (worker.model) {
    const modelID = worker.model.id ?? worker.model.modelID
    if (modelID)
      return {
        providerID: worker.model.providerID,
        modelID,
        variant: worker.model.variant,
      }
  }
  const recent = [...messages].reverse().find((message) => message.info.role === "user")?.info
  if (recent?.role === "user") {
    return {
      providerID: recent.model.providerID,
      modelID: recent.model.modelID,
      variant: recent.model.variant,
    }
  }
  return observed
}

async function collectDescendants(
  sessions: SessionClient,
  roots: RuntimeSession[],
  directory: string,
): Promise<RuntimeSession[]> {
  const result = [...roots]
  const seen = new Set(result.map((session) => session.id))
  for (let index = 0; index < result.length; index += 1) {
    const parent = result[index]
    if (!parent) continue
    const children = await sessions
      .children({ path: { id: parent.id }, query: { directory } })
      .then((value) => value.data ?? [])
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      result.push(child)
    }
  }
  return result
}

function parseVerdict(value: unknown): VerifierVerdict | undefined {
  if (!value || typeof value !== "object") return
  const data = value as Partial<VerifierVerdict>
  if (!data.verdict || !["complete", "continue", "adjust", "blocked"].includes(data.verdict)) return
  if (typeof data.confidence !== "number" || !Number.isFinite(data.confidence)) return
  if (data.confidence < 0 || data.confidence > 1) return
  if (!stringList(data.verified) || !stringList(data.missing) || typeof data.instruction !== "string") return
  const instruction = data.instruction.trim()
  if (data.verdict !== "complete" && !instruction) return
  if (data.verdict === "complete" && data.missing.length > 0) return
  return {
    verdict: data.verdict,
    confidence: data.confidence,
    verified: data.verified.map((item) => item.trim()),
    missing: data.missing.map((item) => item.trim()),
    instruction,
  }
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0)
}

function chooserFormat(request: QuestionRequest) {
  return {
    type: "json_schema" as const,
    retryCount: 2,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["answers", "reason"],
      properties: {
        answers: {
          type: "array",
          minItems: request.questions.length,
          maxItems: request.questions.length,
          items: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
        },
        reason: { type: "string" },
      },
    },
  }
}

function chooserPacket(goal: Goal, request: QuestionRequest, messages: MessageWithParts[]) {
  const transcript = messages.slice(-20).map((message) => ({
    role: message.info.role,
    parts: message.parts.filter((part) => part.type === "text").map((part) => part.text),
  }))
  return JSON.stringify(
    {
      kind: "autopilot-question-choice",
      goal: goal.text,
      acceptanceCriteria: goal.criteria,
      questionSessionID: request.sessionID,
      questions: request.questions.map((question) => ({
        header: question.header,
        question: question.question,
        multiple: question.multiple === true,
        options: question.options,
      })),
      recentTranscript: transcript,
      instruction:
        "Choose the option label or labels that best advance the active goal. Return labels exactly as provided. Do not invent an answer or approve permissions.",
    },
    null,
    2,
  )
}

function verificationPacket(input: {
  goal: Goal
  worker: RuntimeSession
  model: ModelRef
  messages: MessageWithParts[]
  todos: Todo[]
  diffs: unknown[]
  children: RuntimeSession[]
  lastAssistant: AssistantWithParts
}) {
  const transcript = input.messages.slice(-40).map((message) => ({
    info: message.info,
    parts: message.parts.filter((part) => part.type === "text" || part.type === "tool"),
  }))
  return JSON.stringify(
    {
      kind: "autopilot-verification",
      round: input.goal.round + 1,
      worker: { sessionID: input.worker.id, agent: "build" },
      verifier: { ...input.model, source: "Autopilot review model" },
      limits: {
        checkpoints: formatLimit(input.goal.maxCheckpoints),
        minutes: formatLimit(input.goal.maxMinutes),
        noProgressRounds: input.goal.noProgressLimit,
      },
      goal: input.goal.text,
      acceptanceCriteria: input.goal.criteria,
      evidence: {
        messages: transcript,
        todos: input.todos,
        diff: input.diffs,
        childSessions: input.children.map((child) => ({
          id: child.id,
          title: child.title,
        })),
        lastWorkerMessage: input.lastAssistant,
      },
    },
    null,
    2,
  )
}

function checkpointText(
  goal: Goal,
  model: ModelRef,
  verifierSessionID: string,
  verdict: VerifierVerdict,
  evidence: {
    messages: number
    todos: Todo[]
    diffs: unknown[]
    children: RuntimeSession[]
    finish: string
  },
) {
  return [
    `<autopilot checkpoint="${goal.round + 1}">`,
    `Autopilot checkpoint · ${goal.round + 1}`,
    "",
    `Worker stopped: finish=${evidence.finish}`,
    `Verifier session: ${verifierSessionID}`,
    `Verifier model: ${model.providerID}/${model.modelID}${model.variant ? ` · ${model.variant}` : ""}`,
    `Checkpoints used: ${goal.round + 1}/${formatLimit(goal.maxCheckpoints)}`,
    `Continuations used: ${goal.continuations}`,
    `Evidence supplied: ${evidence.messages} messages, ${evidence.todos.length} todos, ${evidence.diffs.length} file diffs, ${evidence.children.length} child sessions`,
    "",
    `Verdict: ${verdict.verdict.toUpperCase()}`,
    `Confidence: ${Math.round(verdict.confidence * 100)}%`,
    verdict.verified.length ? `\nVerified:\n${verdict.verified.map((item) => `- ${item}`).join("\n")}` : "",
    verdict.missing.length ? `\nMissing:\n${verdict.missing.map((item) => `- ${item}`).join("\n")}` : "",
    verdict.instruction ? `\nNext instruction:\n${verdict.instruction}` : "",
    "</autopilot>",
  ]
    .filter(Boolean)
    .join("\n")
}

function continuationText(checkpoint: string, instruction: string) {
  return `${checkpoint}\n\nContinue working on the active goal now. ${instruction || "Resolve the missing criteria above."} Do not merely summarize.`
}

function initialContract(goal: Goal) {
  return [
    "<autopilot>",
    "Autopilot armed",
    "",
    `Goal:\n${goal.text}`,
    goal.criteria.length
      ? `\nAcceptance criteria:\n${goal.criteria.map((item) => `- ${item}`).join("\n")}`
      : "\nAcceptance criteria: inferred from the full goal message",
    "",
    `Worker agent: ${goal.workerAgent ?? "build"}`,
    `Question handling: ${questionPolicyLabel(goal.questionPolicy)}`,
    `Review model: ${goal.reviewModel ? `${goal.reviewModel.providerID}/${goal.reviewModel.modelID}${goal.reviewModel.variant ? ` · ${goal.reviewModel.variant}` : ""}` : "current build model (resolved at the first checkpoint)"}`,
    `The verifier and question chooser use the review model. Worker turns keep the build session's current model.`,
    `Autopilot checkpoints: ${formatLimit(goal.maxCheckpoints)}`,
    `Duration: ${formatLimit(goal.maxMinutes, "m")}`,
    `No-progress breaker: ${goal.noProgressLimit} identical rounds`,
    "Verifier receives: goal, criteria, recent transcript, todos, diffs, child-session state, and recorded validation evidence. Pending requests are checked before verification.",
    "Begin work now. Do not claim completion without evidence for every required criterion.",
    "</autopilot>",
  ]
    .filter(Boolean)
    .join("\n")
}

function questionPolicyLabel(policy: Goal["questionPolicy"]) {
  if (policy === "hybrid") return "Hybrid unattended (explicit recommendations, then review-model best fit)"
  if (policy === "recommended") return "Recommended only"
  return "Ask me"
}

function progressFingerprint(goal: Goal, verdict: VerifierVerdict, todos: Todo[], diffs: unknown[]) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        goal: goal.text,
        verified: verdict.verified,
        missing: verdict.missing,
        instruction: verdict.instruction,
        todos,
        diffs,
      }),
    )
    .digest("hex")
}

function limitReason(goal: Goal): string | undefined {
  if (goal.maxCheckpoints !== undefined && goal.round + 1 >= goal.maxCheckpoints) {
    return `Maximum Autopilot checkpoints reached (${goal.maxCheckpoints}).`
  }
  if (goal.maxMinutes !== undefined && goal.startedAt && Date.now() - goal.startedAt >= goal.maxMinutes * 60_000) {
    return `Maximum duration reached (${goal.maxMinutes} minutes).`
  }
}

function short(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 60)
}

export default { id: "autopilot", server: AutopilotServer }
