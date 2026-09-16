import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import server from "./server"
import { putGoal, readState, type Goal } from "./state"

afterEach(() => {
  delete process.env.XDG_DATA_HOME
  delete process.env.OPENCODE_AUTOPILOT_LOG_DIR
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "autopilot-server-test-"))
  process.env.XDG_DATA_HOME = root
  process.env.OPENCODE_AUTOPILOT_LOG_DIR = join(root, "log")
  return root
}

function goal(patch: Partial<Goal> = {}): Goal {
  return {
    workerSessionID: "ses_worker",
    directory: "/workspace",
    text: "Implement the feature",
    criteria: ["Tests pass", "Typecheck passes"],
    mode: "drive",
    phase: "working",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    round: 0,
    continuations: 0,
    noProgressLimit: 2,
    noProgressRounds: 0,
    revision: 1,
    workerAgent: "build",
    ...patch,
  }
}

async function setup(
  verdict: "complete" | "adjust" = "adjust",
  initialize = true,
  pending: { questions?: Array<{ id: string; sessionID: string }>; permissions?: Array<{ id: string; sessionID: string }> } = {},
) {
  const calls = {
    create: [] as any[],
    prompt: [] as any[],
    promptAsync: [] as any[],
    publish: [] as any[],
  }
  const worker = {
    id: "ses_worker",
    directory: "/workspace",
    title: "Worker",
    agent: "build",
    model: { providerID: "provider", id: "model", variant: "high" },
  }
  const verifier = { id: "ses_verifier", parentID: worker.id, directory: "/workspace", title: "Verifier" }
  const workerMessages = [
    {
      info: {
        id: "msg_user",
        sessionID: worker.id,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
      parts: [{ type: "text", text: "Implement the feature" }],
    },
    {
      info: {
        id: "msg_assistant",
        sessionID: worker.id,
        role: "assistant",
        time: { created: 2, completed: 3 },
        parentID: "msg_user",
        providerID: "provider",
        modelID: "model",
        mode: "build",
        agent: "build",
        path: { cwd: "/workspace", root: "/workspace" },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [{ type: "text", text: "Implemented part of it." }],
    },
  ]
  let hooks: any
  const transport = {
    get: async ({ url }: { url: string }) => ({
      data: url === "/question" ? (pending.questions ?? []) : (pending.permissions ?? []),
    }),
  }
  const client = {
    _client: transport,
    tui: {
      publish: async (input: any) => {
        calls.publish.push(input)
        return {}
      },
    },
    session: {
      get: async ({ path }: any) => ({ data: path.id === worker.id ? worker : verifier }),
      create: async (input: any) => {
        calls.create.push(input)
        return { data: verifier }
      },
      update: async () => ({}),
      children: async () => ({ data: [] }),
      todo: async () => ({ data: [{ content: "Typecheck", status: "pending", priority: "high" }] }),
      diff: async () => ({ data: [{ file: "src/a.ts", additions: 1, deletions: 0 }] }),
      messages: async ({ path }: any) => ({ data: path.id === worker.id ? workerMessages : [] }),
      status: async () => ({ data: { [worker.id]: { type: "idle" } } }),
      prompt: async (input: any) => {
        calls.prompt.push(input)
        await hooks.tool.autopilot_submit.execute(
          {
            verdict,
            confidence: 0.95,
            verified: ["Implementation exists"],
            missing: verdict === "complete" ? [] : ["Typecheck evidence"],
            instruction: verdict === "complete" ? "" : "Run the package typecheck.",
          },
          { sessionID: verifier.id, agent: "autopilot-verifier" },
        )
        return {
          data: {
            info: {
              id: "msg_verdict",
              sessionID: verifier.id,
              role: "assistant",
              time: { created: 4, completed: 5 },
              parentID: "msg_verifier_user",
              providerID: "provider",
              modelID: "model",
              mode: "autopilot-verifier",
              agent: "autopilot-verifier",
              path: { cwd: "/workspace", root: "/workspace" },
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            },
            parts: [],
          },
        }
      },
      promptAsync: async (input: any) => {
        calls.promptAsync.push(input)
        return {}
      },
    },
  }
  if (initialize) hooks = await (server.server as any)({ client, directory: "/workspace" })
  const start = async () => {
    hooks = await (server.server as any)({ client, directory: "/workspace" })
    return hooks
  }
  return { hooks, calls, start }
}

describe("autopilot server", () => {
  test("captures the next build message as the goal and exposes Unlimited limits", async () => {
    scratch()
    putGoal(goal({ text: undefined, criteria: [], phase: "waiting-goal", startedAt: undefined, revision: 0 }))
    const { hooks } = await setup()
    const output = {
      message: { agent: "build" },
      parts: [{ type: "text", text: "Implement it.\n\nDone when:\n- Tests pass\n- Typecheck passes" }],
    }

    await hooks["chat.message"](
      {
        sessionID: "ses_worker",
        messageID: "msg_goal",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
      output,
    )

    expect(readState().goals.ses_worker).toMatchObject({
      phase: "working",
      criteria: ["Tests pass", "Typecheck passes"],
      verifier: { providerID: "provider", modelID: "model", variant: "high" },
    })
    const contract = output.parts.at(-1)
    expect(contract?.type).toBe("text")
    if (contract?.type !== "text") throw new Error("Autopilot did not append its goal contract")
    expect(contract.text).toContain("Continuation rounds: Unlimited")
    expect(contract.text).toContain("Resolved verifier: provider/model · high")
    const visible = { text: "Starting implementation." }
    await hooks["experimental.text.complete"](
      { sessionID: "ses_worker", messageID: "msg_assistant", partID: "prt_text" },
      visible,
    )
    expect(visible.text).toContain("Autopilot armed")
    expect(visible.text).toContain("Continuation rounds: Unlimited")
    await hooks.dispose()
  })

  test("uses the worker model for verification and injects a visible corrective continuation", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust")
    putGoal(goal())

    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_worker", status: { type: "idle" } } },
    })

    expect(calls.create[0].body.parentID).toBe("ses_worker")
    expect(calls.prompt[0].body).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      agent: "autopilot-verifier",
    })
    expect(calls.promptAsync[0].body).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      agent: "build",
      noReply: false,
    })
    expect(calls.promptAsync[0].body.parts[0].text).toContain("Verdict: ADJUST")
    expect(calls.promptAsync[0].body.parts[0].text).toContain("Run the package typecheck")
    expect(calls.publish.at(-1).body).toEqual({
      type: "tui.command.execute",
      properties: { command: "autopilot.refresh" },
    })
    expect(readState().goals.ses_worker).toMatchObject({ phase: "continuing", round: 1, continuations: 1 })
    await hooks.dispose()
  })

  test("records completion visibly without starting another build turn", async () => {
    scratch()
    const { hooks, calls } = await setup("complete")
    putGoal(goal())

    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_worker", status: { type: "idle" } } },
    })

    expect(calls.promptAsync).toHaveLength(1)
    expect(calls.promptAsync[0].body.noReply).toBe(true)
    expect(calls.promptAsync[0].body.parts[0].text).toContain("Verdict: COMPLETE")
    expect(readState().goals.ses_worker.phase).toBe("complete")
    await hooks.dispose()
  })

  test("restores active goals as paused after server restart", async () => {
    scratch()
    putGoal(goal({ phase: "verifying" }))
    const harness = await setup("adjust", false)
    const hooks = await harness.start()
    expect(readState().goals.ses_worker.phase).toBe("paused")
    expect(readState().goals.ses_worker.lastCheckpoint).toContain("server plugin restarted")
    await hooks.dispose()
  })

  test("waits until every pending question is resolved", async () => {
    scratch()
    const { hooks, calls } = await setup("complete")
    putGoal(goal())

    await hooks.event({
      event: {
        type: "question.asked",
        properties: { id: "que_one", sessionID: "ses_worker", questions: [] },
      },
    })
    await hooks.event({
      event: {
        type: "question.asked",
        properties: { id: "que_two", sessionID: "ses_worker", questions: [] },
      },
    })
    await hooks.event({
      event: {
        type: "question.replied",
        properties: { sessionID: "ses_worker", requestID: "que_one", answers: [] },
      },
    })
    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_worker", status: { type: "idle" } } },
    })

    expect(calls.prompt).toHaveLength(0)
    expect(readState().goals.ses_worker.phase).toBe("working")
    await hooks.dispose()
  })

  test("hydrates pending requests before supervising a goal", async () => {
    scratch()
    const { hooks, calls } = await setup("complete", true, {
      questions: [{ id: "que_existing", sessionID: "ses_worker" }],
    })
    putGoal(goal())

    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_worker", status: { type: "idle" } } },
    })

    expect(calls.prompt).toHaveLength(0)
    expect(readState().goals.ses_worker.phase).toBe("working")
    await hooks.dispose()
  })

  test("does not block plugin startup while pending-request endpoints initialize", async () => {
    const root = scratch()
    const never = new Promise<never>(() => {})
    const client = {
      _client: { get: async () => never },
      session: {
        status: async () => ({ data: {} }),
      },
    }

    const hooks = await Promise.race([
      (server.server as any)({ client, directory: "/workspace" }),
      Bun.sleep(100).then(() => {
        throw new Error("Autopilot plugin startup timed out")
      }),
    ])

    expect(hooks).toBeDefined()
    const events = readFileSync(join(root, "log", "autopilot.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event)
    expect(events).toEqual([
      "startup.begin",
      "startup.recovery-complete",
      "pending.bootstrap-scheduled",
      "startup.ready",
    ])
    await hooks.dispose()
  })

  test("does not treat synthetic user messages as human steering", async () => {
    scratch()
    const { hooks } = await setup()
    putGoal(goal())
    const output = {
      message: { agent: "build" },
      parts: [{ type: "text", text: "Internal continuation", synthetic: true }],
    }

    await hooks["chat.message"](
      {
        sessionID: "ses_worker",
        messageID: "msg_synthetic",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
      output,
    )

    expect(readState().goals.ses_worker).toMatchObject({ phase: "working", revision: 1 })
    await hooks.dispose()
  })
})
