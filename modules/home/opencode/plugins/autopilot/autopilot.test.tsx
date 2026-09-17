/** @jsxImportSource @opentui/solid */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { RGBA } from "@opentui/core"
import { createComponent, onCleanup } from "solid-js"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"

import type { Event, Message, Provider, QuestionRequest, Session } from "@opencode-ai/sdk/v2"
import { recommendedAnswers, validateAnswers } from "./question"
import { createLog } from "./log"
import { AUTOPILOT_RUNTIME, parseRuntimeRequest, runtimeResponse } from "./runtime"
import { formatLimit, patchGoal, putGoal, readState, type Goal } from "./state"

ensureRuntimePluginSupport()
const { default: autopilot, AutopilotStatus, statusLabel, statusVisible } = await import("./tui")

afterEach(() => {
  delete process.env.XDG_DATA_HOME
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "autopilot-test-"))
  process.env.XDG_DATA_HOME = root
  return root
}

function question(input?: Partial<QuestionRequest>): QuestionRequest {
  return {
    id: "que_test",
    sessionID: "ses_root",
    questions: [
      {
        header: "Approach",
        question: "Which approach?",
        options: [
          { label: "Safe (Recommended)", description: "Preferred option" },
          { label: "Risky", description: "Alternative option" },
        ],
      },
    ],
    ...input,
  }
}

function session(
  id: string,
  parentID?: string,
  model: Session["model"] = {
    providerID: "provider",
    id: "current",
    variant: "high",
  },
): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/workspace",
    parentID,
    title: id,
    model,
    version: "test",
    time: { created: 0, updated: 0 },
  }
}

async function setup(
  options: {
    dialogError?: Error
    sessionModel?: Session["model"]
    messages?: Message[]
    serverRuntime?: typeof AUTOPILOT_RUNTIME
    skipRuntimeResponse?: boolean
  } = {},
) {
  const handlers = new Map<Event["type"], Array<(event: Event) => void>>()
  const layers: Array<{
    mode?: string
    commands?: Array<{ name: string; run: () => void | Promise<void> }>
    bindings?: Array<{ key: string; cmd: string }>
  }> = []
  const commands: Array<{ name: string; run: () => void | Promise<void> }> = []
  const broadcasts: Array<Record<string, unknown>> = []
  const serverLogs: Array<Record<string, unknown>> = []
  const promptAsyncCalls: Array<Record<string, unknown>> = []
  const alerts: Array<{ title?: string; message?: string }> = []
  let statusSlot: ((context: unknown, props: { session_id: string }) => unknown) | undefined
  const sessions: Record<string, Session> = {
    ses_root: session("ses_root", undefined, options.sessionModel),
    ses_child: session("ses_child", "ses_root"),
  }
  const providers: Provider[] = [
    {
      id: "provider",
      name: "Provider",
      source: "config",
      env: [],
      options: {},
      models: {
        current: {
          id: "current",
          providerID: "provider",
          name: "Current Model",
          api: { id: "current", url: "", npm: "" },
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
          limit: { context: 100_000, output: 10_000 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
          variants: { high: {}, max: {} },
        },
        alternate: {
          id: "alternate",
          providerID: "provider",
          name: "Alternate Model",
          api: { id: "alternate", url: "", npm: "" },
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
          limit: { context: 100_000, output: 10_000 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-02-01",
          variants: { low: {}, max: {} },
        },
      },
    },
  ]
  let dialog:
    | {
        title?: string
        placeholder?: string
        current?: unknown
        options?: Array<{
          title?: string
          description?: string
          value: string
          onSelect?: () => void | Promise<void>
        }>
        onConfirm?: (value: string) => void | Promise<void>
      }
    | undefined
  let route: { name: string; params?: { sessionID: string } } = {
    name: "session",
    params: { sessionID: "ses_root" },
  }
  const api = {
    app: { version: "1.18.31" },
    lifecycle: {
      onDispose() {
        return () => {}
      },
    },
    route: {
      get current() {
        return route
      },
      navigate() {},
    },
    state: {
      path: { directory: "/workspace" },
      provider: providers,
      session: { get: (id: string) => sessions[id], messages: () => options.messages ?? [] },
    },
    client: {
      app: {
        log: async (input: Record<string, unknown>) => {
          serverLogs.push(input)
          return { data: true }
        },
      },
      tui: {
        publish: async (input: Record<string, unknown>) => {
          broadcasts.push(input)
          const command = (input.body as { properties?: { command?: string } } | undefined)?.properties?.command
          const request = command ? parseRuntimeRequest(command) : undefined
          if (request && !options.skipRuntimeResponse) {
            queueMicrotask(() => {
              const event = {
                id: "evt_runtime",
                type: "tui.command.execute",
                properties: { command: runtimeResponse(request.nonce, options.serverRuntime) },
              } as Event
              for (const handler of handlers.get(event.type) ?? []) handler(event)
            })
          }
          return { data: true }
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          data: sessions[sessionID],
        }),
        promptAsync: async (input: Record<string, unknown>) => {
          promptAsyncCalls.push(input)
          return { data: undefined }
        },
      },
    },
    event: {
      on(type: Event["type"], handler: (event: Event) => void) {
        handlers.set(type, [...(handlers.get(type) ?? []), handler])
        return () => {}
      },
    },
    keymap: {
      registerLayer(layer: (typeof layers)[number]) {
        layers.push(layer)
        commands.push(...(layer.commands ?? []))
      },
    },
    ui: {
      dialog: {
        replace: (render: () => typeof dialog) => {
          if (options.dialogError) throw options.dialogError
          dialog = render()
        },
        clear() {},
        setSize() {},
      },
      DialogSelect: (props: typeof dialog) => props,
      DialogPrompt: (props: typeof dialog) => props,
      DialogAlert: (props: typeof dialog) => {
        alerts.push(props as { title?: string; message?: string })
        return props
      },
      toast() {},
    },
    slots: {
      register(plugin: { slots?: { session_prompt_right?: typeof statusSlot } }) {
        statusSlot = plugin.slots?.session_prompt_right
        return "autopilot:test"
      },
    },
    theme: {
      current: {
        success: RGBA.fromInts(40, 180, 90),
        info: RGBA.fromInts(40, 120, 220),
        warning: RGBA.fromInts(220, 170, 50),
        error: RGBA.fromInts(220, 70, 70),
        textMuted: RGBA.fromInts(130, 130, 130),
        text: RGBA.fromInts(230, 230, 230),
        backgroundElement: RGBA.fromInts(30, 30, 30),
        accent: RGBA.fromInts(120, 100, 220),
      },
    },
  }
  await (autopilot.tui as any)(api, undefined, undefined)
  return {
    commands,
    layers,
    broadcasts,
    serverLogs,
    promptAsyncCalls,
    alerts,
    get statusSlot() {
      return statusSlot
    },
    get dialog() {
      return dialog
    },
    setRoute(next: typeof route) {
      route = next
    },
    async emit(event: Event) {
      for (const handler of handlers.get(event.type) ?? []) handler(event)
      await Bun.sleep(0)
    },
  }
}

describe("autopilot TUI plugin", () => {
  test("formats compact status labels", () => {
    const goal = {
      workerSessionID: "ses_root",
      directory: "/workspace",
      criteria: [],
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "working",
      startedAt: 1_000,
      updatedAt: 61_000,
      round: 2,
      continuations: 1,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
    } satisfies Goal

    expect(statusLabel(goal)).toBe("On")
    expect(statusLabel({ ...goal, phase: "verifying" })).toBe("On")
    expect(statusLabel({ ...goal, phase: "waiting-goal" })).toBe("Idle")
  })

  test("renders checkpoint progress rather than continuation progress", async () => {
    scratch()
    const color = RGBA.fromInts(200, 200, 200)
    const goal = {
      workerSessionID: "ses_root",
      directory: "/workspace",
      criteria: [],
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "working",
      updatedAt: 1,
      round: 61,
      continuations: 23,
      maxCheckpoints: 100,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
    } satisfies Goal
    const api = {
      theme: {
        current: {
          success: color,
          info: color,
          warning: color,
          error: color,
          textMuted: color,
          text: color,
          backgroundElement: color,
        },
      },
      ui: { toast() {} },
      client: { app: { log: async () => ({ data: true }) } },
      state: { path: { directory: "/workspace" } },
    }
    const app = await testRender(
      () =>
        createComponent(AutopilotStatus, {
          api: api as any,
          sessionID: "ses_root",
          log: createLog("tui"),
          state: () => ({ ...readState(), goals: { ses_root: goal } }),
        }),
      { width: 48, height: 3 },
    )
    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("61/100")
      expect(app.captureCharFrame()).not.toContain("23/100")
    } finally {
      app.renderer.destroy()
    }
  })

  test("hides status by default and supports automatic or manual visibility", () => {
    scratch()
    const state = readState()
    expect(statusVisible(state, "ses_root")).toBe(false)
    expect(statusVisible({ ...state, status: { sessions: { ses_root: "show" } } }, "ses_root")).toBe(true)
    expect(statusVisible({ ...state, status: { sessions: { ses_root: "hide" } } }, "ses_root")).toBe(false)
    expect(
      statusVisible(
        {
          ...state,
          goals: {
            ses_root: {
              workerSessionID: "ses_root",
              directory: "/workspace",
              criteria: [],
              mode: "drive",
              questionPolicy: "hybrid",
              phase: "working",
              updatedAt: 1,
              round: 0,
              continuations: 0,
              noProgressLimit: 2,
              noProgressRounds: 0,
              revision: 1,
            },
          },
        },
        "ses_root",
      ),
    ).toBe(true)
    expect(
      statusVisible(
        {
          ...state,
          status: { sessions: {} },
          goals: {
            ses_root: {
              workerSessionID: "ses_root",
              directory: "/workspace",
              criteria: [],
              mode: "drive",
              questionPolicy: "hybrid",
              phase: "working",
              updatedAt: 1,
              round: 0,
              continuations: 0,
              noProgressLimit: 2,
              noProgressRounds: 0,
              revision: 1,
            },
            ses_other: {
              workerSessionID: "ses_other",
              directory: "/workspace",
              criteria: [],
              mode: "drive",
              questionPolicy: "hybrid",
              phase: "working",
              updatedAt: 1,
              round: 0,
              continuations: 0,
              noProgressLimit: 2,
              noProgressRounds: 0,
              revision: 1,
            },
          },
        },
        "ses_other",
      ),
    ).toBe(true)
  })

  test("renders the registered status slot and refreshes it from OpenCode events", async () => {
    scratch()
    const item = {
      workerSessionID: "ses_root",
      directory: "/workspace",
      criteria: [],
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "waiting-goal",
      updatedAt: Date.now(),
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 0,
    } satisfies Goal
    const harness = await setup()
    const renderStatus = harness.statusSlot
    expect(renderStatus).toBeDefined()
    if (!renderStatus) throw new Error("Autopilot did not register its status slot")
    function SlotHarness() {
      const registry = createSolidSlotRegistry<{
        session_prompt_right: { session_id: string }
      }>(useRenderer(), {})
      const Slot = createSlot(registry)
      const unregister = registry.register({
        id: "autopilot:test",
        slots: { session_prompt_right: renderStatus as any },
      })
      onCleanup(unregister)
      return (
        <box width="100%" flexDirection="row" justifyContent="space-between">
          <text flexShrink={1} wrapMode="none" truncate>
            build · model
          </text>
          <Slot name="session_prompt_right" session_id="ses_root" />
        </box>
      )
    }
    const app = await testRender(() => <SlotHarness />, {
      width: 48,
      height: 3,
    })
    try {
      await app.renderOnce()
      const hidden = app.captureCharFrame()
      expect(hidden).toContain("build · model")
      expect(hidden).not.toContain("Autopilot")
      putGoal(item)
      await harness.emit({
        id: "evt_autopilot_idle",
        type: "tui.command.execute",
        properties: { command: "autopilot.refresh" },
      })
      const idle = await app.waitForFrame((value) => value.includes("Autopilot Idle"))
      expect(idle).toContain("Autopilot Idle")
      patchGoal("ses_root", { phase: "working" })
      await harness.emit({
        id: "evt_autopilot_working",
        type: "tui.command.execute",
        properties: { command: "autopilot.refresh" },
      })
      const frame = await app.waitForFrame((value) => value.includes("Autopilot On"))
      expect(frame).toContain("Autopilot On")
      app.resize(16, 3)
      await app.renderOnce()
      const narrow = app.captureCharFrame().trim()
      expect(narrow).toContain("● A")
      expect(narrow).toContain("0/∞")
    } finally {
      app.renderer.destroy()
    }
  })

  test("isolates status rendering failures and forwards them to server logging", async () => {
    const root = scratch()
    const reports: Array<Record<string, unknown>> = []
    const color = RGBA.fromInts(200, 200, 200)
    const api = {
      theme: {
        current: {
          success: color,
          info: color,
          warning: color,
          error: color,
          textMuted: color,
          text: color,
          backgroundElement: color,
        },
      },
      ui: { toast() {} },
      client: {
        app: {
          log: async (input: Record<string, unknown>) => {
            reports.push(input)
            return { data: true }
          },
        },
      },
      state: { path: { directory: "/workspace" } },
    }
    const app = await testRender(
      () =>
        createComponent(AutopilotStatus, {
          api: api as any,
          sessionID: "ses_root",
          log: createLog("tui"),
          state: () => {
            throw new Error("render exploded")
          },
        }),
      { width: 48, height: 3 },
    )
    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Autopilot unavailable")
      await Bun.sleep(0)
      expect(reports[0]).toMatchObject({
        service: "autopilot.tui",
        level: "error",
        message: "status.render-failed",
      })
      expect(readFileSync(join(root, "opencode", "log", "autopilot.log"), "utf8")).toContain(
        '"event":"status.render-failed"',
      )
    } finally {
      app.renderer.destroy()
    }
  })

  test("logs and forwards command failures without rejecting the command", async () => {
    const root = scratch()
    const harness = await setup({ dialogError: new Error("command exploded") })
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await expect(command.run()).resolves.toBeUndefined()
    await Bun.sleep(0)
    expect(harness.serverLogs[0]).toMatchObject({
      service: "autopilot.tui",
      message: "command.open-failed",
    })
    expect(readFileSync(join(root, "opencode", "log", "autopilot.log"), "utf8")).toContain(
      '"event":"command.open-failed"',
    )
  })

  test("refuses Autopilot controls when the server runtime does not match", async () => {
    const root = scratch()
    const harness = await setup({
      serverRuntime: { protocol: AUTOPILOT_RUNTIME.protocol, fingerprint: "0".repeat(64) },
    })
    const command = harness.commands.find((item) => item.name === "autopilot.open")!

    await command.run()

    expect(harness.dialog).toBeUndefined()
    expect(readFileSync(join(root, "opencode", "log", "autopilot.log"), "utf8")).toContain(
      "Autopilot TUI/server version mismatch",
    )
  })

  test("selects explicit recommendations conservatively", () => {
    scratch()
    expect(recommendedAnswers(question())).toEqual([["Safe (Recommended)"]])
    expect(
      recommendedAnswers(
        question({
          questions: [
            {
              header: "Ambiguous",
              question: "Which option?",
              options: [
                { label: "One (Recommended)", description: "One" },
                { label: "Two (Recommended)", description: "Two" },
              ],
            },
          ],
        }),
      ),
    ).toBeUndefined()
    expect(
      recommendedAnswers(
        question({
          questions: [
            {
              header: "Duplicate",
              question: "Which option?",
              options: [
                { label: "Safe (Recommended)", description: "One" },
                {
                  label: " safe (recommended) ",
                  description: "Duplicate with different casing",
                },
              ],
            },
          ],
        }),
      ),
    ).toBeUndefined()
    expect(
      recommendedAnswers(
        question({
          questions: [
            {
              header: "Choice",
              question: "Which option?",
              options: [{ label: "(Recommended)", description: "Missing a real label" }],
            },
          ],
        }),
      ),
    ).toBeUndefined()
  })

  test("accepts only exact listed chooser answers", () => {
    scratch()
    const request = question({
      questions: [
        {
          header: "Approach",
          question: "Which approach?",
          options: [
            { label: "Safe", description: "Preferred" },
            { label: "Risky", description: "Alternative" },
          ],
        },
      ],
    })
    expect(validateAnswers(request, [["Safe"]])).toEqual([["Safe"]])
    expect(validateAnswers(request, [["Invented"]])).toBeUndefined()
    expect(validateAnswers(request, [["Safe", "Risky"]])).toBeUndefined()
  })

  test("registers /autopilot and its question-mode recovery shortcut", async () => {
    scratch()
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    expect(command).toBeDefined()
    expect(
      harness.layers.some(
        (layer) =>
          layer.mode === "question" &&
          layer.bindings?.some((binding) => binding.key === "ctrl+p" && binding.cmd === "autopilot.open"),
      ),
    ).toBe(true)

    await command.run()
    expect(harness.dialog!.options!.some((item) => item.value === "goal-start")).toBe(true)
    expect(harness.dialog!.options!.some((item) => item.value.startsWith("questions-"))).toBe(false)
  })

  test("runs one setup wizard with per-goal unattended question handling", async () => {
    scratch()
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await Bun.sleep(0)
    await harness.dialog!.options!.find((item) => item.value === "goal-start")!.onSelect?.()
    await Bun.sleep(0)
    await harness.dialog!.options!.find((item) => item.value === "drive")!.onSelect?.()
    await Bun.sleep(0)
    await harness.dialog!.options!.find((item) => item.value === "hybrid")!.onSelect?.()
    await Bun.sleep(0)
    expect(harness.dialog).toMatchObject({
      title: "Autopilot review model",
      current: "provider/current",
    })
    expect(harness.dialog!.options!.find((item) => item.value === "provider/current")?.description).toContain(
      "Current/default review model · high",
    )
    await harness.dialog!.options!.find((item) => item.value === "provider/current")!.onSelect?.()
    await Bun.sleep(0)
    expect(harness.dialog).toMatchObject({
      title: "Autopilot review-model variant",
      current: "high",
    })
    await harness.dialog!.options!.find((item) => item.value === "high")!.onSelect?.()
    await Bun.sleep(0)
    await harness.dialog!.onConfirm?.("")
    await harness.dialog!.onConfirm?.("")

    expect(readState().goals.ses_root).toMatchObject({
      phase: "waiting-goal",
      mode: "drive",
      questionPolicy: "hybrid",
      reviewModel: { providerID: "provider", modelID: "current", variant: "high" },
      runtime: AUTOPILOT_RUNTIME,
    })
  })

  test("goal setup defaults both limits to Unlimited", async () => {
    scratch()
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "goal-start")!.onSelect?.()
    await Bun.sleep(0)
    await harness.dialog!.options!.find((item) => item.value === "drive")!.onSelect?.()
    await Bun.sleep(0)
    await harness.dialog!.options!.find((item) => item.value === "recommended")!.onSelect?.()
    await Bun.sleep(0)
    await harness.dialog!.options!.find((item) => item.value === "provider/current")!.onSelect?.()
    await Bun.sleep(0)
    await harness.dialog!.options!.find((item) => item.value === "high")!.onSelect?.()
    await Bun.sleep(0)
    await harness.dialog!.onConfirm?.("")
    await harness.dialog!.onConfirm?.("")
    const goal = readState().goals.ses_root
    expect(goal).toMatchObject({
      phase: "waiting-goal",
      mode: "drive",
      questionPolicy: "recommended",
      round: 0,
      continuations: 0,
    })
    expect(goal.maxCheckpoints).toBeUndefined()
    expect(goal.maxMinutes).toBeUndefined()
    expect(formatLimit(goal.maxCheckpoints)).toBe("Unlimited")
  })

  test("selects a distinct review model without switching the build session", async () => {
    scratch()
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "goal-start")!.onSelect?.()
    await harness.dialog!.options!.find((item) => item.value === "drive")!.onSelect?.()
    await harness.dialog!.options!.find((item) => item.value === "hybrid")!.onSelect?.()
    expect(harness.dialog?.placeholder).toContain("Search review models")
    await harness.dialog!.options!.find((item) => item.value === "provider/alternate")!.onSelect?.()
    expect(harness.dialog).toMatchObject({
      title: "Autopilot review-model variant",
      current: "default",
    })
    await harness.dialog!.options!.find((item) => item.value === "max")!.onSelect?.()
    await harness.dialog!.onConfirm?.("4")
    await harness.dialog!.onConfirm?.("30")

    expect(readState().goals.ses_root.reviewModel).toEqual({
      providerID: "provider",
      modelID: "alternate",
      variant: "max",
    })
    expect(harness.promptAsyncCalls).toHaveLength(0)
  })

  test("changes the active review model without changing the build session, phase, or revision", async () => {
    scratch()
    putGoal({
      workerSessionID: "ses_root",
      directory: "/workspace",
      text: "Finish it",
      criteria: [],
      reviewModel: { providerID: "provider", modelID: "current", variant: "high" },
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "verifying",
      updatedAt: 1,
      round: 2,
      continuations: 1,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 7,
    })
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    expect(harness.dialog!.options!.some((item) => item.value === "goal-review-model")).toBe(true)
    await harness.dialog!.options!.find((item) => item.value === "goal-review-model")!.onSelect?.()
    await harness.dialog!.options!.find((item) => item.value === "provider/alternate")!.onSelect?.()
    await harness.dialog!.options!.find((item) => item.value === "low")!.onSelect?.()

    expect(readState().goals.ses_root).toMatchObject({
      phase: "verifying",
      revision: 7,
      reviewModel: { providerID: "provider", modelID: "alternate", variant: "low" },
    })
    expect(harness.promptAsyncCalls).toHaveLength(0)
  })

  test("shows explicit recovery actions instead of a broken blocked resume", async () => {
    scratch()
    putGoal({
      workerSessionID: "ses_root",
      directory: "/workspace",
      text: "Finish it",
      criteria: [],
      reviewModel: { providerID: "provider", modelID: "current", variant: "high" },
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "blocked",
      updatedAt: 1,
      round: 2,
      continuations: 1,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 7,
      recovery: {
        kind: "worker-error",
        summary: "APIError: Provider quota exhausted",
        messageID: "msg_failed",
        errorName: "APIError",
        detail: "Provider quota exhausted",
      },
    })
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    const values = harness.dialog!.options!.map((item) => item.value)
    expect(values).toContain("goal-recovery")
    expect(values).not.toContain("goal-pause")

    await harness.dialog!.options!.find((item) => item.value === "goal-recovery")!.onSelect?.()
    expect(harness.dialog!.options!.map((item) => item.value)).toEqual(["inspect", "continue", "clear"])
    await harness.dialog!.options!.find((item) => item.value === "inspect")!.onSelect?.()
    expect(harness.alerts.at(-1)).toMatchObject({ title: "Autopilot block" })
    expect(harness.alerts.at(-1)?.message).toContain("Provider quota exhausted")
  })

  test("continues a blocked goal through a fresh state-aware worker turn", async () => {
    scratch()
    putGoal({
      workerSessionID: "ses_root",
      directory: "/workspace",
      text: "Finish it",
      criteria: [],
      reviewModel: { providerID: "provider", modelID: "current", variant: "high" },
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "blocked",
      updatedAt: 1,
      round: 2,
      continuations: 1,
      noProgressLimit: 2,
      noProgressRounds: 1,
      lastFingerprint: "old",
      lastIdleMessageID: "msg_failed",
      revision: 7,
      recovery: {
        kind: "interrupted",
        summary: "Worker turn interrupted: The operation was aborted.",
        messageID: "msg_failed",
        errorName: "MessageAbortedError",
        detail: "The operation was aborted.",
      },
    })
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "goal-recovery")!.onSelect?.()
    await harness.dialog!.options!.find((item) => item.value === "continue")!.onSelect?.()

    expect(harness.promptAsyncCalls).toHaveLength(1)
    expect(harness.promptAsyncCalls[0]).toMatchObject({
      sessionID: "ses_root",
      directory: "/workspace",
      model: { providerID: "provider", modelID: "current" },
      variant: "high",
      agent: "build",
    })
    expect(JSON.stringify(harness.promptAsyncCalls[0])).toContain("repository's current state")
    expect(JSON.stringify(harness.promptAsyncCalls[0])).toContain("Do not blindly repeat")
    expect(readState().goals.ses_root).toMatchObject({ phase: "working", revision: 8, noProgressRounds: 0 })
    expect(readState().goals.ses_root.recovery).toBeUndefined()
    expect(readState().goals.ses_root.lastIdleMessageID).toBeUndefined()
  })

  test("clears a legacy block while keeping the goal paused", async () => {
    scratch()
    putGoal({
      workerSessionID: "ses_root",
      directory: "/workspace",
      text: "Finish it",
      criteria: [],
      reviewModel: { providerID: "provider", modelID: "current" },
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "blocked",
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
      lastCheckpoint: "Worker stopped with an error: [object Object]",
    })
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "goal-recovery")!.onSelect?.()
    await harness.dialog!.options!.find((item) => item.value === "clear")!.onSelect?.()

    expect(readState().goals.ses_root).toMatchObject({
      phase: "paused",
      revision: 2,
      lastCheckpoint: "Autopilot stop cleared by the user; goal remains paused.",
    })
    expect(harness.promptAsyncCalls).toHaveLength(0)
  })

  test("recovers exact interruption details for a legacy blocked goal from the session transcript", async () => {
    scratch()
    putGoal({
      workerSessionID: "ses_root",
      directory: "/workspace",
      text: "Finish it",
      criteria: [],
      reviewModel: { providerID: "provider", modelID: "current" },
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "blocked",
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
      lastCheckpoint: "Worker stopped with an error: [object Object]",
    })
    const harness = await setup({
      messages: [
        {
          id: "msg_interrupted",
          sessionID: "ses_root",
          role: "assistant",
          time: { created: 1, completed: 2 },
          parentID: "msg_user",
          providerID: "provider",
          modelID: "current",
          mode: "build",
          agent: "build",
          path: { cwd: "/workspace", root: "/workspace" },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } },
        },
      ],
    })
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "goal-recovery")!.onSelect?.()
    await harness.dialog!.options!.find((item) => item.value === "inspect")!.onSelect?.()

    expect(harness.alerts.at(-1)).toMatchObject({ title: "Autopilot interruption" })
    expect(harness.alerts.at(-1)?.message).toContain("The operation was aborted.")
    expect(harness.alerts.at(-1)?.message).toContain("msg_interrupted")
    expect(harness.alerts.at(-1)?.message).not.toContain("[object Object]")
  })

  test("persists manual status visibility from /autopilot", async () => {
    scratch()
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "status-show")!.onSelect?.()
    expect(readState().status.sessions.ses_root).toBe("show")
    expect(harness.broadcasts.at(-1)).toMatchObject({
      body: {
        type: "tui.command.execute",
        properties: { command: "autopilot.refresh" },
      },
    })
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "status-hide")!.onSelect?.()
    expect(readState().status.sessions.ses_root).toBe("hide")
    expect(readState().status.sessions.ses_child).toBeUndefined()
  })
})
