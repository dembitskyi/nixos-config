/** @jsxImportSource @opentui/solid */

// /autopilot — control recommended answers and supervised goal completion.

import { createSignal, ErrorBoundary, Show, type Accessor } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createLog, type Log } from "./log"
import { errorName, errorText, interruptedError } from "./question"
import {
  AUTOPILOT_REFRESH_COMMAND,
  formatLimit,
  formatModel,
  goalSummary,
  patchGoal,
  putGoal,
  readState,
  removeGoal,
  setStatusVisibility,
  type Goal,
  type GoalMode,
  type GoalRecovery,
  type ModelRef,
  type QuestionPolicy,
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
  const detail =
    error instanceof Error ? { name: error.name, message, stack: error.stack?.slice(0, 4_000) } : { message }
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
        if (result.error)
          log.warn("ui.server-report-failed", {
            sourceEvent: event,
            error: errorText(result.error),
          })
      })
      .catch((forwardError) =>
        log.warn("ui.server-report-failed", {
          sourceEvent: event,
          error: errorText(forwardError),
        }),
      )
  } catch (forwardError) {
    log.warn("ui.server-report-failed", {
      sourceEvent: event,
      error: errorText(forwardError),
    })
  }
  if (!notify) return
  try {
    api.ui.toast({ variant: "error", message: `Autopilot error: ${message}` })
  } catch (toastError) {
    log.error("ui.toast-failed", {
      sourceEvent: event,
      error: errorText(toastError),
    })
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
  return (...args: T) => runTuiAction(api, log, event, () => action(...args))
}

function showStatus(api: TuiPluginApi, goal: Goal) {
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "Autopilot status",
      message: [goalSummary(goal), goal.lastCheckpoint ? `\nLast checkpoint:\n${goal.lastCheckpoint}` : ""].join("\n"),
    }),
  )
}

function sessionRecovery(api: TuiPluginApi, goal: Goal): GoalRecovery | undefined {
  const latest = [...api.state.session.messages(goal.workerSessionID)]
    .reverse()
    .find((message) => message.role === "assistant" && message.error)
  if (latest?.role !== "assistant" || !latest.error) return
  const detail = errorText(latest.error)
  const interrupted = interruptedError(latest.error)
  const name = errorName(latest.error)
  return {
    kind: interrupted ? "interrupted" : "worker-error",
    summary: interrupted
      ? `Worker turn interrupted${detail ? `: ${detail}` : ""}`
      : `${name ?? "Worker error"}: ${detail}`,
    messageID: latest.id,
    errorName: name,
    detail,
  }
}

function effectiveRecovery(api: TuiPluginApi, goal: Goal): GoalRecovery | undefined {
  return goal.recovery ?? sessionRecovery(api, goal)
}

function showRecovery(api: TuiPluginApi, goal: Goal) {
  const recovery = effectiveRecovery(api, goal)
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: recovery?.kind === "interrupted" ? "Autopilot interruption" : "Autopilot block",
      message: recovery
        ? [
            recovery.summary,
            recovery.errorName ? `Error: ${recovery.errorName}` : "",
            recovery.messageID ? `Message: ${recovery.messageID}` : "",
            recovery.detail && recovery.detail !== recovery.summary ? `\nDetails:\n${recovery.detail}` : "",
            `\n${goalSummary(goal)}`,
          ]
            .filter(Boolean)
            .join("\n")
        : [
            "No structured recovery details were saved for this older block.",
            goal.lastCheckpoint ? `\nLast checkpoint:\n${goal.lastCheckpoint}` : "",
            `\n${goalSummary(goal)}`,
          ].join("\n"),
    }),
  )
}

function continueFromCurrentState(api: TuiPluginApi, log: Log, goal: Goal, broadcastState: (source: string) => void) {
  const model = sessionModel(api, goal.workerSessionID)
  if (!model) throw new Error("Could not resolve the current build model")
  const recovery = effectiveRecovery(api, goal)
  const messageID = `msg_autopilot_resume_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const text = [
    "<autopilot-resume>",
    "Continue the active Autopilot goal from the repository's current state.",
    "The previous worker turn was interrupted or ended with an error. Do not blindly repeat its last command.",
    "First inspect the current files, diffs, todos, running child sessions, and available validation evidence; then perform only the remaining work.",
    recovery ? `Previous stop: ${recovery.summary}` : "Previous stop details were not recorded.",
    `Goal: ${goal.text ?? "Use the active session goal."}`,
    "</autopilot-resume>",
  ].join("\n")

  return api.client.session
    .promptAsync({
      sessionID: goal.workerSessionID,
      directory: goal.directory,
      messageID,
      model: { providerID: model.providerID, modelID: model.modelID },
      variant: model.variant,
      agent: "build",
      parts: [{ type: "text", text, synthetic: true, metadata: { autopilot: true, recovery: true } }],
    })
    .then((result) => {
      if (result.error) throw new Error(`Could not continue the worker: ${errorText(result.error)}`)
      patchGoal(goal.workerSessionID, {
        phase: "working",
        revision: goal.revision + 1,
        lastIdleMessageID: undefined,
        lastFingerprint: undefined,
        noProgressRounds: 0,
        recovery: undefined,
        lastCheckpoint: "Autopilot continued from the repository's current state after user confirmation.",
      })
      broadcastState("goal.continue-current")
      log.info("goal.continue-current", { workerSessionID: goal.workerSessionID, messageID })
      api.ui.dialog.clear()
      api.ui.toast({ variant: "success", message: "Autopilot is continuing from the current state" })
    })
}

function showRecoveryMenu(api: TuiPluginApi, log: Log, goal: Goal, broadcastState: (source: string) => void) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: goal.phase === "blocked" ? "Resolve blocked goal" : "Resume Autopilot",
      placeholder: "Inspect the stop or choose how to proceed",
      options: [
        {
          title: goal.phase === "blocked" ? "Inspect block" : "Inspect last stop",
          value: "inspect",
          description: "Show the exact saved stop reason without changing goal state.",
          onSelect: guarded(api, log, "goal.inspect-stop-failed", () => showRecovery(api, goal)),
        },
        {
          title: "Continue from current state",
          value: "continue",
          description: "Start a fresh worker turn after re-reading repository state; do not repeat blindly.",
          onSelect: guarded(api, log, "goal.continue-current-failed", () =>
            continueFromCurrentState(api, log, goal, broadcastState),
          ),
        },
        {
          title: goal.phase === "blocked" ? "Clear block and stay paused" : "Clear stop and stay paused",
          value: "clear",
          description: "Remove the stop marker without starting a worker turn.",
          onSelect: guarded(api, log, "goal.clear-stop-failed", () => {
            patchGoal(goal.workerSessionID, {
              phase: "paused",
              revision: goal.revision + 1,
              recovery: undefined,
              lastIdleMessageID: undefined,
              lastCheckpoint: "Autopilot stop cleared by the user; goal remains paused.",
            })
            broadcastState("goal.stop-cleared")
            log.info("goal.stop-cleared", { workerSessionID: goal.workerSessionID })
            api.ui.dialog.clear()
            api.ui.toast({ variant: "success", message: "Autopilot stop cleared; goal remains paused" })
          }),
        },
      ],
    }),
  )
}

function sessionModel(api: TuiPluginApi, sessionID: string): ModelRef | undefined {
  const selected = api.state.session.get(sessionID)?.model
  if (selected) {
    return {
      providerID: selected.providerID,
      modelID: selected.id,
      ...(selected.variant && selected.variant !== "default" ? { variant: selected.variant } : {}),
    }
  }
  const recent = [...api.state.session.messages(sessionID)].reverse().find((message) => message.role === "user")
  if (recent?.role !== "user") return
  return {
    providerID: recent.model.providerID,
    modelID: recent.model.modelID,
    ...(recent.model.variant && recent.model.variant !== "default" ? { variant: recent.model.variant } : {}),
  }
}

function modelKey(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}`
}

function modelDefinition(api: TuiPluginApi, model: ModelRef) {
  const models = api.state.provider.find((provider) => provider.id === model.providerID)?.models
  return models?.[model.modelID] ?? Object.values(models ?? {}).find((item) => item.id === model.modelID)
}

function modelChoices(api: TuiPluginApi, preferred: ModelRef | undefined) {
  const preferredKey = preferred ? modelKey(preferred) : undefined
  const choices = api.state.provider
    .flatMap((provider) =>
      Object.entries(provider.models).flatMap(([catalogModelID, model]) => {
        const modelID = model.id || catalogModelID
        const ref = { providerID: provider.id, modelID } satisfies ModelRef
        const key = modelKey(ref)
        if (model.status === "deprecated" && key !== preferredKey) return []
        return [
          {
            key,
            ref,
            providerName: provider.name,
            modelName: model.name || modelID,
            disabled: provider.id === "opencode" && modelID.includes("-nano") && key !== preferredKey,
          },
        ]
      }),
    )
    .sort(
      (left, right) =>
        Number(left.ref.providerID !== "opencode") - Number(right.ref.providerID !== "opencode") ||
        left.providerName.localeCompare(right.providerName) ||
        left.modelName.localeCompare(right.modelName),
    )
  if (!preferred || choices.some((choice) => choice.key === preferredKey)) return choices
  const key = modelKey(preferred)
  return [
    {
      key,
      ref: preferred,
      providerName: preferred.providerID,
      modelName: preferred.modelID,
      disabled: false,
    },
    ...choices,
  ]
}

function askModelVariant(
  api: TuiPluginApi,
  log: Log,
  event: string,
  model: ModelRef,
  onConfirm: (model: ModelRef) => void | Promise<void>,
) {
  const variants = Object.keys(modelDefinition(api, model)?.variants ?? {})
    .filter((variant) => variant !== "default")
    .sort()
  if (model.variant && !variants.includes(model.variant)) variants.unshift(model.variant)
  if (variants.length === 0) {
    api.ui.dialog.setSize("medium")
    return onConfirm(model)
  }
  const choose = (variant?: string) =>
    guarded(api, log, `${event}.variant-failed`, async () => {
      api.ui.dialog.setSize("medium")
      await onConfirm({ ...model, variant })
    })
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Autopilot review-model variant",
      placeholder: "Choose a reasoning variant",
      current: model.variant ?? "default",
      options: [
        { title: "Default", value: "default", onSelect: choose() },
        ...variants.map((variant) => ({
          title: variant,
          value: variant,
          onSelect: choose(variant),
        })),
      ],
    }),
  )
}

function askModel(
  api: TuiPluginApi,
  log: Log,
  event: string,
  preferred: ModelRef | undefined,
  onConfirm: (model: ModelRef) => void | Promise<void>,
) {
  const choices = modelChoices(api, preferred)
  if (choices.length === 0) {
    api.ui.toast({
      variant: "error",
      message: "No available models were found",
    })
    return
  }
  const preferredKey = preferred ? modelKey(preferred) : undefined
  const current = choices.some((choice) => choice.key === preferredKey) ? preferred : choices[0]?.ref
  if (!current) return
  const choose = (model: ModelRef) =>
    guarded(api, log, `${event}.model-failed`, () =>
      askModelVariant(
        api,
        log,
        event,
        modelKey(model) === preferredKey ? { ...model, variant: preferred?.variant } : model,
        onConfirm,
      ),
    )
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Autopilot review model",
      placeholder: "Search review models by name or provider/model",
      flat: true,
      current: modelKey(current),
      options: choices.map((choice) => ({
        title: `${choice.modelName} · ${choice.key}`,
        value: choice.key,
        category: choice.providerName,
        description:
          choice.key === preferredKey
            ? `Current/default review model${preferred?.variant ? ` · ${preferred.variant}` : " · default variant"}`
            : choice.key,
        disabled: choice.disabled,
        onSelect: choose(choice.ref),
      })),
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
    case "waiting-user":
      return "Waiting"
    case "complete":
      return "Done"
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
  return (
    state.goals[sessionID] ??
    Object.values(state.goals).find(
      (item) => item.verifierSessionID === sessionID || item.chooserSessionID === sessionID,
    )
  )
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
      case "waiting-user":
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
              {" "}
              · {item().round}/{item().maxCheckpoints ?? "∞"}
            </span>
          </>
        )}
      </Show>
    </text>
  )
}

export function AutopilotStatus(props: { api: TuiPluginApi; sessionID: string; log: Log; state: Accessor<State> }) {
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
  questionPolicy: QuestionPolicy,
  model: ModelRef,
  refreshState: (source: string) => void,
) {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Maximum Autopilot checkpoints",
      placeholder: "Blank = Unlimited",
      onConfirm: guarded(api, log, "goal.round-limit-failed", (roundsText) => {
        const rounds = parseLimit(roundsText)
        if (roundsText.trim() && rounds === undefined) {
          api.ui.toast({
            variant: "error",
            message: "Rounds must be a positive integer or blank",
          })
          return
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogPrompt({
            title: "Maximum duration in minutes",
            placeholder: "Blank = Unlimited",
            onConfirm: guarded(api, log, "goal.duration-limit-failed", async (minutesText) => {
              const minutes = parseLimit(minutesText)
              if (minutesText.trim() && minutes === undefined) {
                api.ui.toast({
                  variant: "error",
                  message: "Duration must be a positive integer or blank",
                })
                return
              }
              const session = api.state.session.get(workerSessionID)
              if (!session) return
              const now = Date.now()
              const goal: Goal = {
                workerSessionID,
                directory: session.directory,
                criteria: [],
                reviewModel: model,
                mode,
                questionPolicy,
                phase: "waiting-goal",
                updatedAt: now,
                round: 0,
                continuations: 0,
                maxCheckpoints: rounds,
                maxMinutes: minutes,
                noProgressLimit: 2,
                noProgressRounds: 0,
                revision: 0,
              }
              putGoal(goal)
              api.ui.dialog.clear()
              refreshState("goal.waiting")
              log.info("goal.waiting", {
                workerSessionID,
                mode,
                questionPolicy,
                reviewModel: modelKey(model),
                variant: model.variant,
                maxCheckpoints: rounds ?? "unlimited",
                maxMinutes: minutes ?? "unlimited",
              })
              api.ui.toast({
                variant: "success",
                message: `Autopilot is waiting for your next message. Review model: ${formatModel(model)}; checkpoints: ${formatLimit(rounds)}; duration: ${formatLimit(minutes, "m")}.`,
              })
            }),
          }),
        )
      }),
    }),
  )
}

function askQuestionPolicy(
  api: TuiPluginApi,
  log: Log,
  workerSessionID: string,
  mode: GoalMode,
  refreshState: (source: string) => void,
) {
  const choose = (questionPolicy: QuestionPolicy) =>
    guarded(api, log, "goal.question-policy-failed", () => {
      const current = sessionModel(api, workerSessionID)
      if (!current) {
        api.ui.toast({
          variant: "error",
          message: "Could not resolve the current session model",
        })
        return
      }
      askModel(api, log, "goal.setup", current, (model) =>
        askGoalLimits(api, log, workerSessionID, mode, questionPolicy, model, refreshState),
      )
    })
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Answer agent questions",
      placeholder: "Choose how unattended questions are handled",
      options: [
        {
          title: "Hybrid unattended (Recommended)",
          value: "hybrid",
          description: "Use explicit recommendations; otherwise let the selected review model choose the best fit.",
          onSelect: choose("hybrid"),
        },
        {
          title: "Recommended only",
          value: "recommended",
          description: "Answer only an unambiguous option marked (Recommended).",
          onSelect: choose("recommended"),
        },
        {
          title: "Ask me",
          value: "manual",
          description: "Leave every agent question for you.",
          onSelect: choose("manual"),
        },
      ],
    }),
  )
}

function startGoalWizard(api: TuiPluginApi, log: Log, workerSessionID: string, refreshState: (source: string) => void) {
  const choose = (mode: GoalMode) =>
    guarded(api, log, "goal.mode-failed", () => askQuestionPolicy(api, log, workerSessionID, mode, refreshState))
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Start Autopilot",
      placeholder: "Choose supervision mode",
      options: [
        {
          title: "Drive automatically (Recommended)",
          value: "drive",
          description: "Verify each stop and continue until the goal is complete or genuinely blocked.",
          onSelect: choose("drive"),
        },
        {
          title: "Monitor only",
          value: "monitor",
          description: "Verify the next stop but do not automatically continue the worker.",
          onSelect: choose("monitor"),
        },
      ],
    }),
  )
}

function parseLimit(value: string): number | undefined {
  if (!value.trim()) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

async function initializeTui(api: TuiPluginApi, log: Log) {
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
          body: {
            type: "tui.command.execute",
            properties: { command: AUTOPILOT_REFRESH_COMMAND },
          },
        })
        .then((result) => {
          if (result.error) reportTuiError(api, log, "state.broadcast-failed", result.error, false)
        })
        .catch((error) => reportTuiError(api, log, "state.broadcast-failed", error, false))
    } catch (error) {
      reportTuiError(api, log, "state.broadcast-failed", error, false)
    }
  }

  api.event.on("tui.command.execute", (event) => {
    if (event.properties.command === AUTOPILOT_REFRESH_COMMAND) refreshState("server.notification")
  })
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "autopilot.open",
        title: "Open Autopilot",
        desc: "Configure supervised goals and unattended question handling",
        category: "Autopilot",
        slashName: "autopilot",
        async run() {
          await runTuiAction(api, log, "command.open-failed", async () => {
            const sessionID = currentSessionID(api)
            if (!sessionID) {
              api.ui.toast({
                variant: "warning",
                message: "Open a session before starting Autopilot",
              })
              return
            }
            const current = readState()
            setState(() => current)
            const goal = sessionGoal(current, sessionID)
            const workerSessionID = goal?.workerSessionID ?? sessionID
            const statusVisibility: StatusVisibility = workerSessionID
              ? (current.status.sessions[workerSessionID] ?? "auto")
              : "auto"
            const verifierView = Boolean(goal && sessionID && goal.workerSessionID !== sessionID)
            const canPause = Boolean(goal && ["working", "verifying", "continuing"].includes(goal.phase))
            const canRecover = Boolean(goal && ["blocked", "paused", "stalled", "exhausted"].includes(goal.phase))
            const goalOptions =
              sessionID && !verifierView
                ? [
                    {
                      title: goal ? "Restart Autopilot goal" : "Start Autopilot goal",
                      value: "goal-start",
                      description: "Configure supervision, unattended questions, model, and optional limits.",
                      onSelect: () => startGoalWizard(api, log, sessionID, broadcastState),
                    },
                    ...(goal
                      ? [
                          {
                            title: `View goal status · ${goal.phase}`,
                            value: "goal-status",
                            description: `Checkpoint ${goal.round}/${formatLimit(goal.maxCheckpoints)}; ${goal.continuations} continuations.`,
                            onSelect() {
                              showStatus(api, goal)
                            },
                          },
                          {
                            title: "Change review model",
                            value: "goal-review-model",
                            description: `${formatModel(goal.reviewModel)}. The build session model is not changed.`,
                            onSelect() {
                              const preferred = goal.reviewModel ?? sessionModel(api, sessionID)
                              if (!preferred) {
                                api.ui.toast({
                                  variant: "error",
                                  message: "Could not resolve the current review model",
                                })
                                return
                              }
                              askModel(api, log, "goal.change-model", preferred, async (model) => {
                                patchGoal(sessionID, { reviewModel: model })
                                broadcastState("goal.review-model")
                                log.info("goal.review-model", {
                                  workerSessionID: sessionID,
                                  reviewModel: modelKey(model),
                                  variant: model.variant,
                                  phase: goal.phase,
                                })
                                api.ui.dialog.clear()
                                api.ui.toast({
                                  variant: "success",
                                  message:
                                    goal.phase === "verifying"
                                      ? `Autopilot will review with ${formatModel(model)} after the active review finishes.`
                                      : `Autopilot review model changed to ${formatModel(model)}.`,
                                })
                              })
                            },
                          },
                          ...(canRecover
                            ? [
                                {
                                  title:
                                    goal.phase === "blocked" ? "Resolve blocked goal" : "Resume / recovery options",
                                  value: "goal-recovery",
                                  description: "Inspect the stop, continue from current state, or remain paused.",
                                  onSelect() {
                                    showRecoveryMenu(api, log, goal, broadcastState)
                                  },
                                },
                              ]
                            : []),
                          ...(canPause
                            ? [
                                {
                                  title: "Pause goal",
                                  value: "goal-pause",
                                  description: "Keep goal state but stop automatic verification.",
                                  onSelect() {
                                    patchGoal(sessionID, {
                                      phase: "paused",
                                      revision: goal.revision + 1,
                                    })
                                    broadcastState("goal.phase")
                                    log.info("goal.phase", {
                                      workerSessionID: sessionID,
                                      phase: "paused",
                                    })
                                    api.ui.dialog.clear()
                                    api.ui.toast({ variant: "success", message: "Autopilot paused" })
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
                                    api.route.navigate("session", {
                                      sessionID: goal.verifierSessionID,
                                    })
                                  },
                                },
                              ]
                            : []),
                          ...(goal.chooserSessionID
                            ? [
                                {
                                  title: "Open question chooser transcript",
                                  value: "goal-chooser",
                                  description: goal.chooserSessionID,
                                  onSelect() {
                                    api.ui.dialog.clear()
                                    api.route.navigate("session", {
                                      sessionID: goal.chooserSessionID,
                                    })
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
                              log.info("goal.cleared", {
                                workerSessionID: sessionID,
                              })
                              api.ui.dialog.clear()
                              api.ui.toast({
                                variant: "success",
                                message: "Autopilot goal cleared",
                              })
                            },
                          },
                        ]
                      : []),
                  ]
                : []
            const verifierOptions =
              verifierView && workerSessionID
                ? [
                    {
                      title: "Return to worker session",
                      value: "goal-worker",
                      description: workerSessionID,
                      onSelect() {
                        api.ui.dialog.clear()
                        api.route.navigate("session", {
                          sessionID: workerSessionID,
                        })
                      },
                    },
                    {
                      title: `View goal status · ${goal?.phase}`,
                      value: "goal-status",
                      description: `Checkpoint ${goal?.round}/${formatLimit(goal?.maxCheckpoints)}; ${goal?.continuations} continuations.`,
                      onSelect() {
                        if (goal) showStatus(api, goal)
                      },
                    },
                  ]
                : []
            const statusOptions = workerSessionID
              ? [
                  {
                    title: `Status · Automatic${statusVisibility === "auto" ? " (current)" : ""}`,
                    value: "status-auto",
                    description: "Show the status only after Autopilot is activated for this session.",
                    onSelect() {
                      setStatusVisibility(workerSessionID, "auto")
                      broadcastState("status.visibility")
                      log.info("status.visibility", {
                        sessionID: workerSessionID,
                        visibility: "auto",
                      })
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
                      log.info("status.visibility", {
                        sessionID: workerSessionID,
                        visibility: "show",
                      })
                      api.ui.dialog.clear()
                    },
                  },
                  {
                    title: `Status · Hidden${statusVisibility === "hide" ? " (current)" : ""}`,
                    value: "status-hide",
                    description: "Hide the Autopilot status in this session, including while its goal is active.",
                    onSelect() {
                      setStatusVisibility(workerSessionID, "hide")
                      broadcastState("status.visibility")
                      log.info("status.visibility", {
                        sessionID: workerSessionID,
                        visibility: "hide",
                      })
                      api.ui.dialog.clear()
                    },
                  },
                ]
              : []
            const options = [...goalOptions, ...verifierOptions, ...statusOptions]
            const guardedOptions = options.map((option) => ({
              ...option,
              onSelect: guarded(api, log, `command.action-failed.${option.value}`, option.onSelect),
            }))
            api.ui.dialog.replace(() =>
              api.ui.DialogSelect({
                title: "Autopilot",
                placeholder: "Choose an action",
                options: guardedOptions,
              }),
            )
          })
        },
      },
    ],
    bindings: [],
  })

  api.keymap.registerLayer({
    mode: "question",
    bindings: [
      {
        key: "ctrl+p",
        cmd: "autopilot.open",
        desc: "Open Autopilot",
        group: "Question",
      },
    ],
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
}

const tui: TuiPlugin = async (api) => {
  const log = createLog("tui")
  log.info("startup.begin", {
    pid: process.pid,
    directory: api.state.path.directory,
    version: api.app.version,
  })
  try {
    await initializeTui(api, log)
  } catch (error) {
    reportTuiError(api, log, "startup.failed", error, false)
    throw error
  }
}

export default { id: "autopilot", tui }
