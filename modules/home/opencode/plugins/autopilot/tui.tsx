/** @jsxImportSource @opentui/solid */

// /autopilot — control recommended answers and supervised goal completion.

import { createSignal, ErrorBoundary, Show, type Accessor } from "solid-js"
import type { QuestionRequest, Session } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createLog, type Log } from "./log"
import { effectiveQuestionMode, errorText, recommendedAnswers, settled } from "./question"
import {
  AUTOPILOT_REFRESH_COMMAND,
  formatLimit,
  goalSummary,
  patchGoal,
  putGoal,
  readState,
  removeGoal,
  setGlobalQuestionMode,
  setSessionQuestionMode,
  setStatusVisibility,
  type Goal,
  type GoalMode,
  type SessionMode,
  type State,
  type StatusVisibility,
} from "./state"

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (!("params" in route)) return
  const sessionID = route.params?.sessionID
  return route.name === "session" && typeof sessionID === "string" ? sessionID : undefined
}

function reportTuiError(api: TuiPluginApi, log: Log, event: string, error: unknown, notify = true) {
  const message = errorText(error)
  const detail = error instanceof Error ? { name: error.name, message, stack: error.stack?.slice(0, 4_000) } : { message }
  log.error(event, { ...detail, pid: process.pid })
  try {
    void api.client.app
      .log({
        directory: api.state.path.directory,
        service: "autopilot.tui",
        level: "error",
        message: event,
        extra: { ...detail, pid: process.pid },
      })
      .then((result) => {
        if (result.error) log.warn("ui.server-report-failed", { sourceEvent: event, error: errorText(result.error) })
      })
      .catch((forwardError) =>
        log.warn("ui.server-report-failed", { sourceEvent: event, error: errorText(forwardError) }),
      )
  } catch (forwardError) {
    log.warn("ui.server-report-failed", { sourceEvent: event, error: errorText(forwardError) })
  }
  if (!notify) return
  try {
    api.ui.toast({ variant: "error", message: `Autopilot error: ${message}` })
  } catch (toastError) {
    log.error("ui.toast-failed", { sourceEvent: event, error: errorText(toastError) })
  }
}

async function runTuiAction(
  api: TuiPluginApi,
  log: Log,
  event: string,
  action: () => void | Promise<void>,
  notify = true,
) {
  try {
    await action()
  } catch (error) {
    reportTuiError(api, log, event, error, notify)
  }
}

function guarded<T extends unknown[]>(
  api: TuiPluginApi,
  log: Log,
  event: string,
  action: (...args: T) => void | Promise<void>,
) {
  return (...args: T) => {
    void runTuiAction(api, log, event, () => action(...args))
  }
}

function showStatus(api: TuiPluginApi, log: Log, goal: Goal) {
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "Autopilot status",
      message: [goalSummary(goal), goal.lastCheckpoint ? `\nLast checkpoint:\n${goal.lastCheckpoint}` : ""].join("\n"),
    }),
  )
}

export function statusLabel(goal: Goal): string {
  switch (goal.phase) {
    case "waiting-goal":
      return "Idle"
    case "working":
      return "On"
    case "verifying":
      return "On"
    case "continuing":
      return "On"
    case "complete":
      return "Complete"
    case "blocked":
      return "Blocked"
    case "paused":
      return "Paused"
    case "stalled":
      return "Stalled"
    case "exhausted":
      return "Limit reached"
  }
}

function sessionGoal(state: State, sessionID: string) {
  return state.goals[sessionID] ?? Object.values(state.goals).find((item) => item.verifierSessionID === sessionID)
}

export function statusVisible(state: State, sessionID: string): boolean {
  const goal = sessionGoal(state, sessionID)
  const owner = goal?.workerSessionID ?? sessionID
  const visibility = state.status.sessions[owner] ?? "auto"
  if (visibility === "hide") return false
  if (visibility === "show") return true
  return Boolean(goal)
}

function StatusContent(props: { api: TuiPluginApi; sessionID: string; state: Accessor<State> }) {
  const goal = () => sessionGoal(props.state(), props.sessionID)
  const tone = (goal: Goal) => {
    const theme = props.api.theme.current
    switch (goal.phase) {
      case "working":
      case "continuing":
      case "complete":
        return theme.success
      case "verifying":
        return theme.info
      case "waiting-goal":
      case "exhausted":
        return theme.warning
      case "blocked":
      case "stalled":
        return theme.error
      case "paused":
        return theme.textMuted
    }
  }
  return (
    <text
      visible={statusVisible(props.state(), props.sessionID)}
      fg={props.api.theme.current.text}
      flexShrink={1}
      minWidth={0}
      maxWidth={48}
      overflow="hidden"
      wrapMode="none"
      truncate
    >
      <Show
        when={goal()}
        fallback={
          <>
            <span style={{ fg: props.api.theme.current.textMuted }}>●</span> <b>Autopilot</b>{" "}
            <span style={{ fg: props.api.theme.current.textMuted }}>Off</span>
          </>
        }
      >
        {(item) => (
          <>
            <span style={{ fg: tone(item()) }}>●</span> <b>Autopilot</b>{" "}
            <span style={{ fg: tone(item()) }}>{statusLabel(item())}</span>
            <span style={{ fg: props.api.theme.current.textMuted }}>
              {" "}· {item().continuations}/{item().maxRounds ?? "∞"}
            </span>
          </>
        )}
      </Show>
    </text>
  )
}

export function AutopilotStatus(props: {
  api: TuiPluginApi
  sessionID: string
  log: Log
  state: Accessor<State>
}) {
  return (
    <ErrorBoundary
      fallback={(error) => {
        reportTuiError(props.api, props.log, "status.render-failed", error, false)
        return (
          <text fg="#e06c75" wrapMode="none" truncate>
            Autopilot unavailable
          </text>
        )
      }}
    >
      <StatusContent api={props.api} sessionID={props.sessionID} state={props.state} />
    </ErrorBoundary>
  )
}

function askGoalLimits(
  api: TuiPluginApi,
  log: Log,
  workerSessionID: string,
  mode: GoalMode,
  refreshState: (source: string) => void,
) {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Maximum continuation rounds",
      placeholder: "Blank = Unlimited",
      onConfirm: guarded(api, log, "goal.round-limit-failed", (roundsText) => {
        const rounds = parseLimit(roundsText)
        if (roundsText.trim() && rounds === undefined) {
          api.ui.toast({ variant: "error", message: "Rounds must be a positive integer or blank" })
          return
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogPrompt({
            title: "Maximum duration in minutes",
            placeholder: "Blank = Unlimited",
            onConfirm: guarded(api, log, "goal.duration-limit-failed", (minutesText) => {
              const minutes = parseLimit(minutesText)
              if (minutesText.trim() && minutes === undefined) {
                api.ui.toast({ variant: "error", message: "Duration must be a positive integer or blank" })
                return
              }
              api.ui.dialog.clear()
              const session = api.state.session.get(workerSessionID)
              if (!session) return
              const now = Date.now()
              const goal: Goal = {
                workerSessionID,
                directory: session.directory,
                criteria: [],
                mode,
                phase: "waiting-goal",
                updatedAt: now,
                round: 0,
                continuations: 0,
                maxRounds: rounds,
                maxMinutes: minutes,
                noProgressLimit: 2,
                noProgressRounds: 0,
                revision: 0,
              }
              putGoal(goal)
              refreshState("goal.waiting")
              log.info("goal.waiting", {
                workerSessionID,
                mode,
                maxRounds: rounds ?? "unlimited",
                maxMinutes: minutes ?? "unlimited",
              })
              api.ui.toast({
                variant: "success",
                message: `Autopilot is waiting for your next message. Rounds: ${formatLimit(rounds)}; duration: ${formatLimit(minutes, "m")}.`,
              })
            }),
          }),
        )
      }),
    }),
  )
}

function parseLimit(value: string): number | undefined {
  if (!value.trim()) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

async function initializeTui(api: TuiPluginApi, log: Log) {
  const replying = new Set<string>()
  const [state, setState] = createSignal(readState())

  function refreshState(source: string) {
    try {
      setState(() => readState())
      log.debug("state.refreshed", { source })
    } catch (error) {
      reportTuiError(api, log, "state.refresh-failed", error, false)
    }
  }

  function broadcastState(source: string) {
    refreshState(source)
    try {
      void api.client.tui
        .publish({
          directory: api.state.path.directory,
          body: { type: "tui.command.execute", properties: { command: AUTOPILOT_REFRESH_COMMAND } },
        })
        .then((result) => {
          if (result.error) reportTuiError(api, log, "state.broadcast-failed", result.error, false)
        })
        .catch((error) => reportTuiError(api, log, "state.broadcast-failed", error, false))
    } catch (error) {
      reportTuiError(api, log, "state.broadcast-failed", error, false)
    }
  }

  async function handleQuestion(request: QuestionRequest, directory: string): Promise<void> {
    if (replying.has(request.id)) return
    replying.add(request.id)
    try {
      const session: Session | undefined =
        api.state.session.get(request.sessionID) ??
        (await api.client.session.get({ sessionID: request.sessionID, directory }).then((result) => result.data))
      const targetDirectory = session?.directory ?? directory
      if ((await effectiveQuestionMode(api, request.sessionID, targetDirectory)) !== "recommended") return
      const answers = recommendedAnswers(request)
      if (!answers) {
        log.debug("question.manual-no-recommendation", { requestID: request.id, sessionID: request.sessionID })
        return
      }
      log.info("question.auto-reply", { requestID: request.id, sessionID: request.sessionID, answers: answers.flat() })
      const result = await api.client.question.reply({ requestID: request.id, directory: targetDirectory, answers })
      if (!result.error || settled(result.error)) return
      api.ui.toast({ variant: "error", message: `Failed to auto-answer question: ${errorText(result.error)}` })
    } catch (error) {
      if (!settled(error)) {
        log.error("question.auto-reply-failed", { requestID: request.id, error: errorText(error) })
        api.ui.toast({ variant: "error", message: `Failed to auto-answer question: ${errorText(error)}` })
      }
    } finally {
      replying.delete(request.id)
    }
  }

  async function sweepQuestions(): Promise<void> {
    const directory = api.state.path.directory
    const result = await api.client.question.list({ directory })
    if (result.error) throw result.error
    for (const request of result.data ?? []) await handleQuestion(request, directory)
  }

  function queueQuestionSweep(source: string) {
    void runTuiAction(api, log, "question.sweep-failed", sweepQuestions, false).then(() => {
      log.debug("question.sweep-complete", { source })
    })
  }

  api.event.on("question.asked", (event) => {
    const request = event.properties
    void runTuiAction(
      api,
      log,
      "question.event-failed",
      () => handleQuestion(request, api.state.session.get(request.sessionID)?.directory ?? api.state.path.directory),
      false,
    )
  })
  api.event.on("tui.command.execute", (event) => {
    if (event.properties.command === AUTOPILOT_REFRESH_COMMAND) refreshState("server.notification")
  })
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "autopilot.open",
        title: "Open Autopilot",
        desc: "Configure recommended answers and supervised goal completion",
        category: "Autopilot",
        slashName: "autopilot",
        async run() {
          await runTuiAction(api, log, "command.open-failed", async () => {
            const sessionID = currentSessionID(api)
            const current = readState()
            setState(() => current)
            const questionGlobal = current.questions.global
            const questionSession: SessionMode = sessionID
              ? (current.questions.sessions[sessionID] ?? "inherit")
              : "inherit"
            const goal = sessionID ? sessionGoal(current, sessionID) : undefined
            const workerSessionID = goal?.workerSessionID ?? sessionID
            const statusVisibility: StatusVisibility = workerSessionID
              ? (current.status.sessions[workerSessionID] ?? "auto")
              : "auto"
            const verifierView = Boolean(goal && sessionID && goal.workerSessionID !== sessionID)
            const canPause = Boolean(goal && ["working", "verifying", "continuing"].includes(goal.phase))
            const canResume = Boolean(goal && ["paused", "blocked", "stalled"].includes(goal.phase))
            const effective = sessionID
              ? await effectiveQuestionMode(api, sessionID, api.state.path.directory)
              : questionGlobal
            const options = [
            ...(sessionID && !verifierView
              ? [
                  {
                    title: `Start goal · Drive automatically`,
                    value: "goal-drive",
                    description: "Your next normal message becomes the goal; limits default to Unlimited.",
                    onSelect: () => askGoalLimits(api, log, sessionID, "drive", broadcastState),
                  },
                  {
                    title: `Start goal · Monitor only`,
                    value: "goal-monitor",
                    description: "Verify idle checkpoints without automatically continuing.",
                    onSelect: () => askGoalLimits(api, log, sessionID, "monitor", broadcastState),
                  },
                  ...(goal
                    ? [
                        {
                          title: `View goal status · ${goal.phase}`,
                          value: "goal-status",
                            description: `Checkpoint ${goal.round}; continuations ${goal.continuations}/${formatLimit(goal.maxRounds)}.`,
                          onSelect() {
                            showStatus(api, log, goal)
                          },
                        },
                        ...(canPause || canResume
                          ? [
                              {
                                title: canResume ? "Resume goal" : "Pause goal",
                                value: "goal-pause",
                                description: "Keep goal state but stop or resume automatic verification.",
                                onSelect() {
                                  const phase = canResume ? "working" : "paused"
                                  patchGoal(sessionID, {
                                    phase,
                                    revision: goal.revision + 1,
                                    ...(canResume
                                      ? {
                                          lastIdleMessageID: undefined,
                                          lastFingerprint: undefined,
                                          noProgressRounds: 0,
                                        }
                                      : {}),
                                  })
                                  broadcastState("goal.phase")
                                  log.info("goal.phase", { workerSessionID: sessionID, phase })
                                  api.ui.dialog.clear()
                                  api.ui.toast({
                                    variant: "success",
                                    message: `Autopilot ${phase === "paused" ? "paused" : "resumed"}`,
                                  })
                                },
                              },
                            ]
                          : []),
                        ...(goal.verifierSessionID
                          ? [
                              {
                                title: "Open verifier transcript",
                                value: "goal-verifier",
                                description: goal.verifierSessionID,
                                onSelect() {
                                  api.ui.dialog.clear()
                                  api.route.navigate("session", { sessionID: goal.verifierSessionID })
                                },
                              },
                            ]
                          : []),
                        {
                          title: "Stop and clear goal",
                          value: "goal-stop",
                          description: "Disable supervision and remove saved goal state.",
                          onSelect() {
                            removeGoal(sessionID)
                            broadcastState("goal.cleared")
                            log.info("goal.cleared", { workerSessionID: sessionID })
                            api.ui.dialog.clear()
                            api.ui.toast({ variant: "success", message: "Autopilot goal cleared" })
                          },
                        },
                      ]
                    : []),
                  {
                    title: `Questions · Session recommended${questionSession === "recommended" ? " (current)" : ""}`,
                    value: "questions-session-recommended",
                    description: "Auto-answer explicit recommendations in this session and its children.",
                    onSelect() {
                      setSessionQuestionMode(sessionID, "recommended")
                      log.info("question.mode", { scope: "session", sessionID, mode: "recommended" })
                      api.ui.dialog.clear()
                      queueQuestionSweep("session-recommended")
                    },
                  },
                  {
                    title: `Questions · Session manual${questionSession === "manual" ? " (current)" : ""}`,
                    value: "questions-session-manual",
                    description: "Always wait for a person in this session and its children.",
                    onSelect() {
                      setSessionQuestionMode(sessionID, "manual")
                      log.info("question.mode", { scope: "session", sessionID, mode: "manual" })
                      api.ui.dialog.clear()
                    },
                  },
                  {
                    title: `Questions · Session inherit (${effective})${questionSession === "inherit" ? " (current)" : ""}`,
                    value: "questions-session-inherit",
                    description: "Use the nearest parent override or global setting.",
                    onSelect() {
                      setSessionQuestionMode(sessionID, "inherit")
                      log.info("question.mode", { scope: "session", sessionID, mode: "inherit" })
                      api.ui.dialog.clear()
                      if (effective === "recommended") queueQuestionSweep("session-inherit")
                    },
                  },
                ]
              : []),
            ...(verifierView && workerSessionID
              ? [
                  {
                    title: "Return to worker session",
                    value: "goal-worker",
                    description: workerSessionID,
                    onSelect() {
                      api.ui.dialog.clear()
                      api.route.navigate("session", { sessionID: workerSessionID })
                    },
                  },
                  {
                    title: `View goal status · ${goal?.phase}`,
                    value: "goal-status",
                    description: `Checkpoint ${goal?.round}; continuations ${goal?.continuations}/${formatLimit(goal?.maxRounds)}.`,
                    onSelect() {
                      if (goal) showStatus(api, log, goal)
                    },
                  },
                ]
              : []),
            ...(workerSessionID
              ? [
                  {
                    title: `Status · Automatic${statusVisibility === "auto" ? " (current)" : ""}`,
                    value: "status-auto",
                    description: "Show the status only after Autopilot is activated for this session.",
                    onSelect() {
                      setStatusVisibility(workerSessionID, "auto")
                      broadcastState("status.visibility")
                      log.info("status.visibility", { sessionID: workerSessionID, visibility: "auto" })
                      api.ui.dialog.clear()
                    },
                  },
                  {
                    title: `Status · Always show${statusVisibility === "show" ? " (current)" : ""}`,
                    value: "status-show",
                    description: "Keep the Autopilot status visible in this session when no goal is active.",
                    onSelect() {
                      setStatusVisibility(workerSessionID, "show")
                      broadcastState("status.visibility")
                      log.info("status.visibility", { sessionID: workerSessionID, visibility: "show" })
                      api.ui.dialog.clear()
                    },
                  },
                  {
                    title: `Status · Hidden${statusVisibility === "hide" ? " (current)" : ""}`,
                    value: "status-hide",
                    description: "Hide the Autopilot status in this session, including while a goal is active.",
                    onSelect() {
                      setStatusVisibility(workerSessionID, "hide")
                      broadcastState("status.visibility")
                      log.info("status.visibility", { sessionID: workerSessionID, visibility: "hide" })
                      api.ui.dialog.clear()
                    },
                  },
                ]
              : []),
            {
              title: `Questions · Global recommended${questionGlobal === "recommended" ? " (current)" : ""}`,
              value: "questions-global-recommended",
              description: "Auto-answer explicit recommendations unless a session overrides it.",
              onSelect() {
                setGlobalQuestionMode("recommended")
                log.info("question.mode", { scope: "global", mode: "recommended" })
                api.ui.dialog.clear()
                queueQuestionSweep("global-recommended")
              },
            },
            {
              title: `Questions · Global manual${questionGlobal === "manual" ? " (current)" : ""}`,
              value: "questions-global-manual",
              description: "Always ask unless a session overrides it.",
              onSelect() {
                setGlobalQuestionMode("manual")
                log.info("question.mode", { scope: "global", mode: "manual" })
                api.ui.dialog.clear()
              },
            },
            ]
            const guardedOptions = options.map((option) => ({
              ...option,
              onSelect: guarded(api, log, `command.action-failed.${option.value}`, option.onSelect),
            }))
            api.ui.dialog.replace(() =>
              api.ui.DialogSelect({ title: "Autopilot", placeholder: "Choose an action", options: guardedOptions }),
            )
          })
        },
      },
    ],
    bindings: [],
  })

  api.keymap.registerLayer({
    mode: "question",
    bindings: [{ key: "ctrl+p", cmd: "autopilot.open", desc: "Open Autopilot", group: "Question" }],
  })

  api.slots.register({
    order: 50,
    slots: {
      session_prompt_right(_ctx: unknown, props: { session_id: string }) {
        try {
          return <AutopilotStatus api={api} sessionID={props.session_id} log={log} state={state} />
        } catch (error) {
          reportTuiError(api, log, "status.mount-failed", error, false)
          return null
        }
      },
    },
  })

  log.info("startup.ready", {
    pid: process.pid,
    directory: api.state.path.directory,
    version: api.app.version,
    command: "autopilot",
    statusSlot: "session_prompt_right",
  })
  queueQuestionSweep("startup")
}

const tui: TuiPlugin = async (api) => {
  const log = createLog("tui")
  log.info("startup.begin", { pid: process.pid, directory: api.state.path.directory, version: api.app.version })
  try {
    await initializeTui(api, log)
  } catch (error) {
    reportTuiError(api, log, "startup.failed", error, false)
    throw error
  }
}

export default { id: "autopilot", tui }
