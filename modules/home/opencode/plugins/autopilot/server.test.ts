import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import server from "./server"
import { AUTOPILOT_RUNTIME, runtimeRequest } from "./runtime"
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
    questionPolicy: "hybrid",
    phase: "working",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    round: 0,
    continuations: 0,
    noProgressLimit: 2,
    noProgressRounds: 0,
    revision: 1,
    workerAgent: "build",
    runtime: AUTOPILOT_RUNTIME,
    ...patch,
  }
}

// A server instance whose database does not hold the goal's worker session,
// i.e. the sibling opencode instance sharing the same autopilot state file.
function foreignClient(): any {
  return {
    _client: { get: async () => ({ data: [] }) },
    tui: { publish: async () => ({}) },
    session: {
      get: async () => ({
        error: { name: "NotFoundError", data: { message: "Session not found: ses_worker" } },
      }),
      status: async () => ({ data: {} }),
    },
  }
}

async function setup(
  verdict: "complete" | "adjust" | ((input: any, hooks: any) => Promise<any>) = "adjust",
  initialize = true,
  pending: {
    questions?: Array<{ id: string; sessionID: string }>
    permissions?: Array<{ id: string; sessionID: string }>
  } = {},
  chooserAnswers: unknown = [["Safe"]],
  workerError?: { name: string; data?: { message?: string } },
) {
  const calls = {
    create: [] as any[],
    questionReply: [] as any[],
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
  const verifier = {
    id: "ses_verifier",
    parentID: worker.id,
    directory: "/workspace",
    title: "Verifier",
  }
  const chooser = {
    id: "ses_chooser",
    parentID: worker.id,
    directory: "/workspace",
    title: "Chooser",
  }
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
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: "stop",
        error: workerError,
      },
      parts: [{ type: "text", text: "Implemented part of it." }],
    },
  ]
  let hooks: any
  const transport = {
    get: async ({ url }: { url: string }) => ({
      data: url === "/question" ? (pending.questions ?? []) : (pending.permissions ?? []),
    }),
    post: async (input: any) => {
      calls.questionReply.push(input)
      return { data: true }
    },
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
      get: async ({ path }: any) => ({
        data: path.id === worker.id ? worker : path.id === chooser.id ? chooser : verifier,
      }),
      create: async (input: any) => {
        calls.create.push(input)
        return {
          data: input.body.title.startsWith("Autopilot Question Chooser") ? chooser : verifier,
        }
      },
      update: async () => ({}),
      children: async () => ({ data: [] }),
      todo: async () => ({
        data: [{ content: "Typecheck", status: "pending", priority: "high" }],
      }),
      diff: async () => ({
        data: [{ file: "src/a.ts", additions: 1, deletions: 0 }],
      }),
      messages: async ({ path }: any) => ({
        data: path.id === worker.id ? workerMessages : [],
      }),
      status: async () => ({ data: { [worker.id]: { type: "idle" } } }),
      prompt: async (input: any) => {
        calls.prompt.push(input)
        if (input.path.id === chooser.id) {
          return {
            data: {
              info: {
                id: "msg_choice",
                sessionID: chooser.id,
                role: "assistant",
                time: { created: 4, completed: 5 },
                parentID: "msg_choice_user",
                providerID: "provider",
                modelID: "model",
                mode: "autopilot-chooser",
                agent: "autopilot-chooser",
                path: { cwd: "/workspace", root: "/workspace" },
                cost: 0,
                tokens: {
                  input: 1,
                  output: 1,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                structured: { answers: chooserAnswers, reason: "Best fit" },
                finish: "stop",
              },
              parts: [],
            },
          }
        }
        if (typeof verdict === "function") return verdict(input, hooks)
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
              tokens: {
                input: 1,
                output: 1,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
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
    putGoal(
      goal({
        text: undefined,
        criteria: [],
        phase: "waiting-goal",
        startedAt: undefined,
        revision: 0,
      }),
    )
    const { hooks } = await setup()
    const output = {
      message: { agent: "build" },
      parts: [
        {
          type: "text",
          text: "Implement it.\n\nDone when:\n- Tests pass\n- Typecheck passes",
        },
      ],
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
      reviewModel: { providerID: "provider", modelID: "model", variant: "high" },
    })
    const contract = output.parts.at(-1)
    expect(contract?.type).toBe("text")
    if (contract?.type !== "text") throw new Error("Autopilot did not append its goal contract")
    expect(contract.text).toContain("Autopilot checkpoints: Unlimited")
    expect(contract.text).toContain("Review model: provider/model · high")
    const visible = { text: "Starting implementation." }
    await hooks["experimental.text.complete"](
      {
        sessionID: "ses_worker",
        messageID: "msg_assistant",
        partID: "prt_text",
      },
      visible,
    )
    expect(visible.text).toContain("Autopilot armed")
    expect(visible.text).toContain("Autopilot checkpoints: Unlimited")
    await hooks.dispose()
  })

  test("answers the TUI runtime handshake with the exact server identity", async () => {
    scratch()
    const { hooks, calls } = await setup()
    const request = runtimeRequest()

    await hooks.event({
      event: { type: "tui.command.execute", properties: { command: request.command } },
    })

    expect(calls.publish.at(-1).body.properties.command).toContain(`:${request.nonce}:`)
    expect(calls.publish.at(-1).body.properties.command).toEndWith(
      `:${AUTOPILOT_RUNTIME.protocol}:${AUTOPILOT_RUNTIME.fingerprint}`,
    )
    await hooks.dispose()
  })

  test("fails closed when a goal was created by a mismatched TUI runtime", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust")
    putGoal(
      goal({
        runtime: { protocol: AUTOPILOT_RUNTIME.protocol, fingerprint: "0".repeat(64) },
      }),
    )

    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_worker", status: { type: "idle" } } },
    })

    expect(calls.prompt).toHaveLength(0)
    expect(calls.promptAsync).toHaveLength(0)
    expect(readState().goals.ses_worker).toMatchObject({
      phase: "blocked",
      recovery: { kind: "autopilot-error", summary: "Autopilot TUI/server version mismatch." },
    })
    await hooks.dispose()
  })

  test("keeps the build model unchanged when the review model differs", async () => {
    scratch()
    const selected = {
      providerID: "selected-provider",
      modelID: "selected-model",
      variant: "max",
    }
    putGoal(
      goal({
        text: undefined,
        criteria: [],
        phase: "waiting-goal",
        startedAt: undefined,
        revision: 0,
        reviewModel: selected,
      }),
    )
    const { hooks, calls } = await setup()
    const output = {
      message: {
        agent: "build",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
      parts: [{ type: "text", text: "Implement the selected-model goal" }],
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

    expect(output.message.model).toEqual({
      providerID: "provider",
      modelID: "model",
      variant: "high",
    })
    expect(readState().goals.ses_worker).toMatchObject({
      phase: "working",
      reviewModel: selected,
    })
    expect(readState().goals.ses_worker.verifier).toBeUndefined()
    await hooks.dispose()
  })

  test("defaults review to the build model and injects a visible corrective continuation", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust")
    putGoal(goal())

    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_worker", status: { type: "idle" } },
      },
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
    expect(readState().goals.ses_worker).toMatchObject({
      phase: "continuing",
      round: 1,
      continuations: 1,
    })
    await hooks.dispose()
  })

  test("uses the review model for verifier and chooser while preserving the build model for continuation", async () => {
    scratch()
    const selected = {
      providerID: "selected-provider",
      modelID: "selected-model",
      variant: "max",
    }
    const { hooks, calls } = await setup("adjust")
    putGoal(goal({ reviewModel: selected, questionPolicy: "hybrid" }))

    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "que_selected",
          sessionID: "ses_worker",
          questions: [
            {
              header: "Approach",
              question: "Which approach?",
              options: [{ label: "Safe", description: "Preferred" }],
            },
          ],
        },
      },
    })
    await Bun.sleep(0)
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_worker", status: { type: "idle" } },
      },
    })

    expect(calls.prompt[0].body).toMatchObject({
      model: { providerID: "selected-provider", modelID: "selected-model" },
      variant: "max",
      agent: "autopilot-chooser",
    })
    expect(calls.prompt[1].body).toMatchObject({
      model: { providerID: "selected-provider", modelID: "selected-model" },
      variant: "max",
      agent: "autopilot-verifier",
    })
    expect(calls.promptAsync.at(-1).body).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      agent: "build",
    })
    await hooks.dispose()
  })

  test("resolves and persists the build model as the review default for a legacy goal", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust")
    putGoal(goal({ reviewModel: undefined }))

    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_worker", status: { type: "idle" } },
      },
    })

    expect(readState().goals.ses_worker.reviewModel).toEqual({
      providerID: "provider",
      modelID: "model",
      variant: "high",
    })
    expect(calls.prompt[0].body).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
    })
    await hooks.dispose()
  })

  test("finishes an active review on its captured model and keeps the build model for continuation", async () => {
    scratch()
    const original = {
      providerID: "review-provider",
      modelID: "review-model",
      variant: "high",
    }
    const next = {
      providerID: "next-provider",
      modelID: "next-model",
      variant: "max",
    }
    const { hooks, calls } = await setup(async (input, activeHooks) => {
      putGoal(
        goal({
          ...readState().goals.ses_worker,
          reviewModel: next,
          phase: "verifying",
        }),
      )
      await activeHooks.tool.autopilot_submit.execute(
        {
          verdict: "adjust",
          confidence: 0.95,
          verified: ["Implementation exists"],
          missing: ["Typecheck evidence"],
          instruction: "Run the package typecheck.",
        },
        { sessionID: input.path.id, agent: "autopilot-verifier" },
      )
      return {
        data: {
          info: {
            id: "msg_verdict",
            sessionID: input.path.id,
            role: "assistant",
            time: { created: 4, completed: 5 },
            parentID: "msg_verifier_user",
            providerID: original.providerID,
            modelID: original.modelID,
            mode: "autopilot-verifier",
            agent: "autopilot-verifier",
            path: { cwd: "/workspace", root: "/workspace" },
            cost: 0,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: "stop",
          },
          parts: [],
        },
      }
    })
    putGoal(goal({ reviewModel: original }))

    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_worker", status: { type: "idle" } },
      },
    })

    expect(calls.prompt[0].body).toMatchObject({
      model: { providerID: original.providerID, modelID: original.modelID },
      variant: original.variant,
    })
    expect(calls.promptAsync[0].body).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      noReply: false,
    })
    expect(readState().goals.ses_worker).toMatchObject({ reviewModel: next, phase: "continuing", round: 1 })
    await hooks.dispose()
  })

  test("keeps selected review models independent across goals", async () => {
    scratch()
    putGoal(goal({ reviewModel: { providerID: "one", modelID: "first" } }))
    putGoal(
      goal({
        workerSessionID: "ses_other",
        reviewModel: { providerID: "two", modelID: "second", variant: "high" },
      }),
    )

    expect(readState().goals.ses_worker.reviewModel).toEqual({
      providerID: "one",
      modelID: "first",
    })
    expect(readState().goals.ses_other.reviewModel).toEqual({
      providerID: "two",
      modelID: "second",
      variant: "high",
    })
  })

  test("records completion visibly without starting another build turn", async () => {
    scratch()
    const { hooks, calls } = await setup("complete")
    putGoal(goal())

    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_worker", status: { type: "idle" } },
      },
    })

    expect(calls.promptAsync).toHaveLength(1)
    expect(calls.promptAsync[0].body.noReply).toBe(true)
    expect(calls.promptAsync[0].body.parts[0].text).toContain("Verdict: COMPLETE")
    expect(readState().goals.ses_worker.phase).toBe("complete")
    await hooks.dispose()
  })

  test("treats an intentionally interrupted worker turn as a recoverable pause", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust", true, {}, [["Safe"]], {
      name: "MessageAbortedError",
      data: { message: "The operation was aborted." },
    })
    putGoal(goal())

    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_worker", status: { type: "idle" } } },
    })

    expect(calls.prompt).toHaveLength(0)
    expect(readState().goals.ses_worker).toMatchObject({
      phase: "paused",
      recovery: {
        kind: "interrupted",
        errorName: "MessageAbortedError",
        messageID: "msg_assistant",
        detail: "The operation was aborted.",
      },
    })
    expect(readState().goals.ses_worker.lastCheckpoint).toContain("Worker turn interrupted: The operation was aborted.")
    expect(readState().goals.ses_worker.lastCheckpoint).not.toContain("[object Object]")
    await hooks.dispose()
  })

  test("keeps genuine worker failures blocked with their structured error detail", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust", true, {}, [["Safe"]], {
      name: "APIError",
      data: { message: "Provider quota exhausted" },
    })
    putGoal(goal())

    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_worker", status: { type: "idle" } } },
    })

    expect(calls.prompt).toHaveLength(0)
    expect(readState().goals.ses_worker).toMatchObject({
      phase: "blocked",
      recovery: {
        kind: "worker-error",
        errorName: "APIError",
        detail: "Provider quota exhausted",
      },
    })
    expect(readState().goals.ses_worker.lastCheckpoint).toContain("APIError: Provider quota exhausted")
    expect(readState().goals.ses_worker.lastCheckpoint).not.toContain("[object Object]")
    await hooks.dispose()
  })

  test("enforces the configured limit on checkpoints, not continuations", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust")
    putGoal(goal({ round: 4, continuations: 1, maxCheckpoints: 5 }))

    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_worker", status: { type: "idle" } },
      },
    })

    expect(readState().goals.ses_worker).toMatchObject({
      phase: "exhausted",
      round: 5,
      continuations: 1,
    })
    expect(calls.promptAsync.at(-1).body.parts[0].text).toContain("Maximum Autopilot checkpoints reached (5)")
    await hooks.dispose()
  })

  test("restores active goals as paused after server restart", async () => {
    scratch()
    putGoal(goal({ phase: "verifying" }))
    const harness = await setup("adjust", false)
    const hooks = await harness.start()
    // Recovery is deferred so ownership can be confirmed over the transport.
    await Bun.sleep(5)
    expect(readState().goals.ses_worker.phase).toBe("paused")
    expect(readState().goals.ses_worker.lastCheckpoint).toContain("server plugin restarted")
    await hooks.dispose()
  })

  test("does not pause another instance's goal during restart recovery", async () => {
    scratch()
    putGoal(goal({ phase: "verifying" }))
    const hooks = await (server.server as any)({
      client: foreignClient(),
      directory: "/workspace",
    })
    await Bun.sleep(5)

    expect(readState().goals.ses_worker.phase).toBe("verifying")
    await hooks.dispose()
  })

  test("ignores goals whose worker session belongs to another opencode instance", async () => {
    scratch()
    const prompts: any[] = []
    const client = foreignClient()
    client.session.prompt = async (input: any) => {
      prompts.push(input)
      return {}
    }
    const hooks = await (server.server as any)({ client, directory: "/workspace" })
    putGoal(goal())

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_worker" } },
    })

    expect(readState().goals.ses_worker.phase).toBe("working")
    expect(prompts).toHaveLength(0)
    await hooks.dispose()
  })

  test("keeps a goal running when the worker session lookup fails transiently", async () => {
    scratch()
    let attempts = 0
    const client: any = {
      _client: { get: async () => ({ data: [] }) },
      tui: { publish: async () => ({}) },
      session: {
        // The first lookup establishes ownership; the next one fails hard.
        get: async () => {
          attempts += 1
          if (attempts === 1) {
            return {
              data: {
                id: "ses_worker",
                directory: "/workspace",
                title: "Worker",
                agent: "build",
              },
            }
          }
          throw new Error("connection reset")
        },
        status: async () => ({ data: {} }),
      },
    }
    const hooks = await (server.server as any)({ client, directory: "/workspace" })
    putGoal(goal())

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_worker" } },
    })

    expect(attempts).toBeGreaterThan(1)
    expect(readState().goals.ses_worker.phase).toBe("working")
    await hooks.dispose()
  })

  test("waits until every pending question is resolved", async () => {
    scratch()
    const { hooks, calls } = await setup("complete")
    putGoal(goal({ questionPolicy: "manual" }))

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
        properties: {
          sessionID: "ses_worker",
          requestID: "que_one",
          answers: [],
        },
      },
    })
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_worker", status: { type: "idle" } },
      },
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
    putGoal(goal({ questionPolicy: "manual" }))

    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_worker", status: { type: "idle" } },
      },
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

    expect(readState().goals.ses_worker).toMatchObject({
      phase: "working",
      revision: 1,
    })
    await hooks.dispose()
  })

  test("auto-answers an explicit recommendation for an active goal", async () => {
    scratch()
    const { hooks, calls } = await setup()
    putGoal(goal({ questionPolicy: "hybrid" }))

    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "que_recommended",
          sessionID: "ses_worker",
          questions: [
            {
              header: "Approach",
              question: "Which approach?",
              options: [
                { label: "Safe (Recommended)", description: "Preferred" },
                { label: "Risky", description: "Alternative" },
              ],
            },
          ],
        },
      },
    })
    await Bun.sleep(0)

    expect(calls.questionReply).toHaveLength(1)
    expect(calls.questionReply[0]).toMatchObject({
      path: { requestID: "que_recommended" },
      body: { answers: [["Safe (Recommended)"]] },
    })
    expect(calls.create).toHaveLength(0)
    await hooks.dispose()
  })

  test("uses the review model to choose an unmarked best-fit answer", async () => {
    scratch()
    const { hooks, calls } = await setup()
    putGoal(goal({ questionPolicy: "hybrid" }))

    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "que_best_fit",
          sessionID: "ses_worker",
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
        },
      },
    })
    await Bun.sleep(0)

    expect(calls.create[0].body.title).toStartWith("Autopilot Question Chooser")
    expect(calls.prompt[0].body).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      agent: "autopilot-chooser",
      format: { type: "json_schema" },
    })
    expect(calls.questionReply[0].body.answers).toEqual([["Safe"]])
    expect(readState().goals.ses_worker.chooserSessionID).toBe("ses_chooser")
    await hooks.dispose()
  })

  test("preserves explicit recommendations while choosing unresolved questions", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust", true, {}, [["Fast"]])
    putGoal(goal({ questionPolicy: "hybrid" }))

    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "que_mixed",
          sessionID: "ses_worker",
          questions: [
            {
              header: "Approach",
              question: "Which approach?",
              options: [
                { label: "Safe (Recommended)", description: "Preferred" },
                { label: "Risky", description: "Alternative" },
              ],
            },
            {
              header: "Speed",
              question: "Which speed?",
              options: [
                { label: "Fast", description: "Move quickly" },
                { label: "Slow", description: "Move carefully" },
              ],
            },
          ],
        },
      },
    })
    await Bun.sleep(0)

    expect(calls.prompt[0].body.parts[0].text).toContain('"header": "Speed"')
    expect(calls.prompt[0].body.parts[0].text).not.toContain('"header": "Approach"')
    expect(calls.questionReply[0].body.answers).toEqual([["Safe (Recommended)"], ["Fast"]])
    await hooks.dispose()
  })

  test("applies the active root goal policy to child-session questions", async () => {
    scratch()
    const { hooks, calls } = await setup()
    putGoal(goal({ questionPolicy: "hybrid" }))

    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "que_child",
          sessionID: "ses_verifier",
          questions: [
            {
              header: "Approach",
              question: "Which approach?",
              options: [{ label: "Safe (Recommended)", description: "Preferred" }],
            },
          ],
        },
      },
    })
    await Bun.sleep(0)

    expect(calls.questionReply[0]).toMatchObject({
      path: { requestID: "que_child" },
      body: { answers: [["Safe (Recommended)"]] },
    })
    await hooks.dispose()
  })

  test("blocks safely when the chooser returns an invalid option", async () => {
    scratch()
    const { hooks, calls } = await setup("adjust", true, {}, [["Invented"]])
    putGoal(goal({ questionPolicy: "hybrid" }))

    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "que_invalid",
          sessionID: "ses_worker",
          questions: [
            {
              header: "Approach",
              question: "Which approach?",
              options: [{ label: "Safe", description: "Preferred" }],
            },
          ],
        },
      },
    })
    await Bun.sleep(0)

    expect(calls.questionReply).toHaveLength(0)
    expect(readState().goals.ses_worker.phase).toBe("blocked")
    expect(readState().goals.ses_worker.lastCheckpoint).toContain("could not select a valid listed answer")
    await hooks.dispose()
  })

  test("leaves unmarked questions manual in recommended-only mode", async () => {
    scratch()
    const { hooks, calls } = await setup()
    putGoal(goal({ questionPolicy: "recommended" }))

    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "que_manual",
          sessionID: "ses_worker",
          questions: [
            {
              header: "Approach",
              question: "Which approach?",
              options: [{ label: "Safe", description: "No recommendation marker" }],
            },
          ],
        },
      },
    })
    await Bun.sleep(0)

    expect(calls.questionReply).toHaveLength(0)
    expect(calls.create).toHaveLength(0)
    expect(readState().goals.ses_worker.phase).toBe("waiting-user")
    await hooks.dispose()
  })

  test("resumes recommended-only supervision after the user answers", async () => {
    scratch()
    const { hooks } = await setup()
    putGoal(goal({ questionPolicy: "recommended" }))
    const request = {
      id: "que_user",
      sessionID: "ses_worker",
      questions: [
        {
          header: "Approach",
          question: "Which approach?",
          options: [{ label: "Safe", description: "No recommendation marker" }],
        },
      ],
    }
    await hooks.event({
      event: { type: "question.asked", properties: request },
    })
    await Bun.sleep(0)
    expect(readState().goals.ses_worker.phase).toBe("waiting-user")

    await hooks.event({
      event: {
        type: "question.replied",
        properties: {
          sessionID: "ses_worker",
          requestID: request.id,
          answers: [["Safe"]],
        },
      },
    })

    expect(readState().goals.ses_worker.phase).toBe("working")
    expect(readState().goals.ses_worker.lastCheckpoint).toContain("was settled")
    await hooks.dispose()
  })
})
