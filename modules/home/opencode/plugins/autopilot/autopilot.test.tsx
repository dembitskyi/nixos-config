/** @jsxImportSource @opentui/solid */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { RGBA } from "@opentui/core"
import { createComponent, onCleanup } from "solid-js"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"

import type { Event, QuestionRequest, Session } from "@opencode-ai/sdk/v2"
import { recommendedAnswers } from "./question"
import { createLog } from "./log"
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

function session(id: string, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/workspace",
    parentID,
    title: id,
    version: "test",
    time: { created: 0, updated: 0 },
  }
}

async function setup(options: { dialogError?: Error } = {}) {
  const handlers = new Map<Event["type"], Array<(event: Event) => void>>()
  const layers: Array<{
    mode?: string
    commands?: Array<{ name: string; run: () => void | Promise<void> }>
    bindings?: Array<{ key: string; cmd: string }>
  }> = []
  const commands: Array<{ name: string; run: () => void | Promise<void> }> = []
  const replies: Array<{ requestID: string; directory?: string; answers: string[][] }> = []
  const broadcasts: Array<Record<string, unknown>> = []
  const serverLogs: Array<Record<string, unknown>> = []
  let statusSlot: ((context: unknown, props: { session_id: string }) => unknown) | undefined
  const sessions: Record<string, Session> = {
    ses_root: session("ses_root"),
    ses_child: session("ses_child", "ses_root"),
  }
  let dialog:
    | {
        options?: Array<{ value: string; onSelect?: () => void | Promise<void> }>
        onConfirm?: (value: string) => void | Promise<void>
      }
    | undefined
  let route: { name: string; params?: { sessionID: string } } = { name: "session", params: { sessionID: "ses_root" } }
  const api = {
    app: { version: "1.18.31" },
    lifecycle: { onDispose() { return () => {} } },
    route: {
      get current() {
        return route
      },
      navigate() {},
    },
    state: { path: { directory: "/workspace" }, session: { get: (id: string) => sessions[id] } },
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
          return { data: true }
        },
      },
      session: { get: async ({ sessionID }: { sessionID: string }) => ({ data: sessions[sessionID] }) },
      question: {
        list: async () => ({ data: [] }),
        reply: async (input: { requestID: string; directory?: string; answers: string[][] }) => {
          replies.push(input)
          return { data: true }
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
      },
      DialogSelect: (props: typeof dialog) => props,
      DialogPrompt: (props: typeof dialog) => props,
      DialogAlert: (props: typeof dialog) => props,
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
    replies,
    broadcasts,
    serverLogs,
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

function asked(request: QuestionRequest): Event {
  return { id: "evt_test", type: "question.asked", properties: request }
}

describe("autopilot TUI plugin", () => {
  test("formats compact status labels", () => {
    const goal = {
      workerSessionID: "ses_root",
      directory: "/workspace",
      criteria: [],
      mode: "drive",
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

  test("hides status by default and supports automatic or manual visibility", () => {
    scratch()
    const state = readState()
    expect(statusVisible(state, "ses_root")).toBe(false)
    expect(statusVisible({ ...state, status: { sessions: { ses_root: "show" } } }, "ses_root")).toBe(true)
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
    expect(statusVisible({ ...state, status: { sessions: { ses_root: "hide" } } }, "ses_root")).toBe(false)
    expect(
      statusVisible(
        {
          ...state,
          status: { sessions: { ses_root: "hide" } },
          goals: {
            ses_root: {
              workerSessionID: "ses_root",
              directory: "/workspace",
              criteria: [],
              mode: "drive",
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
      const registry = createSolidSlotRegistry<{ session_prompt_right: { session_id: string } }>(useRenderer(), {})
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
    const app = await testRender(() => <SlotHarness />, { width: 48, height: 3 })
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
    expect(harness.serverLogs[0]).toMatchObject({ service: "autopilot.tui", message: "command.open-failed" })
    expect(readFileSync(join(root, "opencode", "log", "autopilot.log"), "utf8")).toContain(
      '"event":"command.open-failed"',
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
                { label: " safe (recommended) ", description: "Duplicate with different casing" },
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

  test("uses /autopilot and can recover from an open question with ctrl+p", async () => {
    const data = scratch()
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
    await harness.dialog!.options!.find((item) => item.value === "questions-global-recommended")!.onSelect?.()
    await harness.emit(asked(question()))

    expect(harness.replies).toEqual([
      { requestID: "que_test", directory: "/workspace", answers: [["Safe (Recommended)"]] },
    ])
    expect(JSON.parse(readFileSync(join(data, "opencode", "autopilot.json"), "utf8"))).toMatchObject({
      questions: { global: "recommended", sessions: {} },
    })
  })

  test("inherits parent question policy and leaves ambiguous questions manual", async () => {
    scratch()
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "questions-session-recommended")!.onSelect?.()
    await harness.emit(asked(question({ id: "que_child", sessionID: "ses_child" })))
    await harness.emit(
      asked(
        question({
          id: "que_manual",
          sessionID: "ses_child",
          questions: [
            {
              header: "Choice",
              question: "Which option?",
              options: [{ label: "No default", description: "Requires a person" }],
            },
          ],
        }),
      ),
    )
    expect(harness.replies).toHaveLength(1)
  })

  test("goal setup defaults both limits to Unlimited", async () => {
    scratch()
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "goal-drive")!.onSelect?.()
    await harness.dialog!.onConfirm?.("")
    await harness.dialog!.onConfirm?.("")
    const goal = readState().goals.ses_root
    expect(goal).toMatchObject({ phase: "waiting-goal", mode: "drive", round: 0, continuations: 0 })
    expect(goal.maxRounds).toBeUndefined()
    expect(goal.maxMinutes).toBeUndefined()
    expect(formatLimit(goal.maxRounds)).toBe("Unlimited")
  })

  test("persists manual status visibility from /autopilot", async () => {
    scratch()
    const harness = await setup()
    const command = harness.commands.find((item) => item.name === "autopilot.open")!
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "status-show")!.onSelect?.()
    expect(readState().status.sessions.ses_root).toBe("show")
    expect(harness.broadcasts.at(-1)).toMatchObject({
      body: { type: "tui.command.execute", properties: { command: "autopilot.refresh" } },
    })
    await command.run()
    await harness.dialog!.options!.find((item) => item.value === "status-hide")!.onSelect?.()
    expect(readState().status.sessions.ses_root).toBe("hide")
    expect(readState().status.sessions.ses_child).toBeUndefined()
  })

})
