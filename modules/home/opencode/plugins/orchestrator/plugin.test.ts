import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Redirect plugin logging to a scratch dir BEFORE importing the module: tests
// that construct the real plugin entry would otherwise append to the live
// ~/.local/share/opencode/log/orchestrator.log and corrupt real debugging.
process.env.OPENCODE_ORCHESTRATOR_LOG_DIR = mkdtempSync(join(tmpdir(), "orchestrator-test-"))

import * as mod from "./plugin"
import { ParallelOrchestrator } from "./plugin"

// ─── env-based test knobs ────────────────────────────────────────────────────
//
// The plugin exports exactly one runtime value (ParallelOrchestrator) — see
// the module doc for why. The fallback chain and the clock are therefore
// driven through environment variables the plugin reads lazily at call time
// (OPENCODE_ORCHESTRATOR_FALLBACK_CHAIN / OPENCODE_ORCHESTRATOR_CLOCK_MS)
// rather than through constructor injection of internal classes.

afterEach(() => {
  delete process.env.OPENCODE_ORCHESTRATOR_FALLBACK_CHAIN
  delete process.env.OPENCODE_ORCHESTRATOR_CLOCK_MS
})

const TEST_CHAIN = ["prov/a", "prov/b", "prov/c"]

function setClock(ms: number): void {
  process.env.OPENCODE_ORCHESTRATOR_CLOCK_MS = String(ms)
}

async function makePlugin(opts?: { client?: unknown; chain?: readonly string[] }) {
  if (opts?.chain) process.env.OPENCODE_ORCHESTRATOR_FALLBACK_CHAIN = opts.chain.join(",")
  const ctx = { client: opts?.client } as any
  return ParallelOrchestrator(ctx)
}

async function observe(
  hooks: Awaited<ReturnType<typeof ParallelOrchestrator>>,
  sessionID: string,
  agent: string,
) {
  await hooks["chat.message"]?.({ sessionID, agent } as any, {} as any)
}

async function fire(
  hooks: Awaited<ReturnType<typeof ParallelOrchestrator>>,
  type: string,
  properties: unknown,
) {
  await hooks.event?.({ event: { type, properties } } as any)
}

async function render(hooks: Awaited<ReturnType<typeof ParallelOrchestrator>>, msgs: any[]) {
  await hooks["experimental.chat.messages.transform"]?.({} as any, { messages: msgs } as any)
  return msgs
}

async function compact(hooks: Awaited<ReturnType<typeof ParallelOrchestrator>>, sessionID: string) {
  const output = { context: [] as string[], prompt: undefined as string | undefined }
  await hooks["experimental.session.compacting"]?.({ sessionID } as any, output as any)
  return output
}

const created = (id: string, parentID: string, title: string) =>
  ["session.created", { info: { id, parentID, title } }] as const
const idle = (sid: string) => ["session.idle", { sessionID: sid }] as const
const status = (sid: string, s: unknown) => ["session.status", { sessionID: sid, status: s }] as const
const errEv = (sid: string, error: unknown) => ["session.error", { sessionID: sid, error }] as const
const deleted = (id: string) => ["session.deleted", { info: { id } }] as const
const msgUpdated = (info: unknown) => ["message.updated", { info }] as const

const userMsg = (id: string, sessionID: string, agent: string, text: string) =>
  ({ info: { id, sessionID, role: "user", agent }, parts: [{ type: "text", text }] }) as any

function mockClient() {
  const calls = { abort: [] as any[], promptAsync: [] as any[], messages: [] as any[] }
  let messagesData: any[] = []
  const client = {
    session: {
      messages: async (o: any) => {
        calls.messages.push(o)
        return { data: messagesData }
      },
      abort: async (o: any) => {
        calls.abort.push(o)
      },
      promptAsync: async (o: any) => {
        calls.promptAsync.push(o)
      },
    },
  }
  return { client: client as any, calls, setMessages: (m: any[]) => (messagesData = m) }
}

const REMINDER_KEY = "orchestrator.reminder"
const BOARD_KEY = "orchestrator.board"
const tagged = (part: any, key: string) => part?.metadata?.[key] === true
const boardMsg = (msgs: any[]) => msgs.find((m) => m.parts?.some((p: any) => tagged(p, BOARD_KEY)))

// ─── LaneBoard, exercised through the plugin hooks ───────────────────────────

describe("LaneBoard (via plugin hooks)", () => {
  async function orchestratorPlugin() {
    const hooks = await makePlugin()
    await observe(hooks, "orch", "orchestrator")
    return hooks
  }

  test("running lane → trailing board message + reminder on the user message", async () => {
    const hooks = await orchestratorPlugin()
    await fire(hooks, ...created("c1", "orch", "map auth (@explorer subagent)"))
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "do it")])
    expect(msgs.length).toBe(2)
    expect(tagged(msgs[1].parts[0], BOARD_KEY)).toBe(true)
    expect(msgs[1].parts[0].text).toContain("Active lanes (1 running)")
    expect(msgs[1].parts[0].text).toContain("@explorer")
    expect(msgs[0].parts.some((p: any) => tagged(p, REMINDER_KEY))).toBe(true)
    expect(msgs[0].parts[0].text).toBe("do it")
  })

  test("reminder append-once; board never duplicates across turns", async () => {
    const hooks = await orchestratorPlugin()
    await fire(hooks, ...created("c1", "orch", "x (@explorer subagent)"))
    const msgs = [userMsg("m1", "orch", "orchestrator", "hi")]
    await render(hooks, msgs)
    await render(hooks, msgs)
    await render(hooks, msgs)
    expect(msgs[0].parts.filter((p: any) => tagged(p, REMINDER_KEY)).length).toBe(1)
    expect(msgs.filter((m) => m.parts.some((p: any) => tagged(p, BOARD_KEY))).length).toBe(1)
  })

  test("child idle → reusable session with its id", async () => {
    const hooks = await orchestratorPlugin()
    await fire(hooks, ...created("c1", "orch", "map auth (@explorer subagent)"))
    await fire(hooks, ...idle("c1"))
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "hi")])
    const text = boardMsg(msgs).parts[0].text
    expect(text).toContain("Reusable sessions")
    expect(text).toContain("c1")
  })

  test("keeps at most 2 done lanes per agent (evicts oldest)", async () => {
    const hooks = await orchestratorPlugin()
    for (const id of ["c1", "c2", "c3"]) {
      await fire(hooks, ...created(id, "orch", `t${id} (@fixer subagent)`))
      await fire(hooks, ...status(id, { type: "idle" }))
    }
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "hi")])
    const text = boardMsg(msgs).parts[0].text
    expect(text).toContain("c2")
    expect(text).toContain("c3")
    expect(text).not.toContain("c1")
  })

  test("non-orchestrator session gets no injection; non-orchestrator parent makes no lane", async () => {
    const hooks = await makePlugin()
    await observe(hooks, "build", "build")
    await fire(hooks, ...created("c1", "build", "x (@fixer subagent)"))
    const msgs = await render(hooks, [userMsg("m1", "build", "build", "hi")])
    expect(msgs.length).toBe(1)
  })

  test("session.deleted clears lanes", async () => {
    const hooks = await orchestratorPlugin()
    await fire(hooks, ...created("c1", "orch", "x (@explorer subagent)"))
    await fire(hooks, ...deleted("orch"))
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "hi")])
    expect(boardMsg(msgs)).toBeUndefined()
  })

  test("parseTitle tolerates parentheses in the description", async () => {
    const hooks = await orchestratorPlugin()
    await fire(hooks, ...created("c1", "orch", "fix foo(bar) helper (@fixer subagent)"))
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "hi")])
    const text = boardMsg(msgs).parts[0].text
    expect(text).toContain("@fixer")
    expect(text).toContain("fix foo(bar) helper")
  })

  test("a lane older than the stale threshold renders in a Stale section, no 'do not finalize'", async () => {
    setClock(0)
    const hooks = await orchestratorPlugin()
    await fire(hooks, ...created("c1", "orch", "long job (@explorer subagent)"))
    setClock(21 * 60_000) // past LANE_STALE_MS (20 min)
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "hi")])
    const text = boardMsg(msgs).parts[0].text
    expect(text).toContain("Stale")
    expect(text).toContain("c1")
    expect(text).toContain("stale 21m")
    expect(text).not.toContain("Do not finalize while lanes are running")
  })

  test("session.error marks the lane failed and it renders in a Failed section", async () => {
    const hooks = await orchestratorPlugin()
    await fire(hooks, ...created("c1", "orch", "risky job (@fixer subagent)"))
    await fire(hooks, ...errEv("c1", { message: "boom" }))
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "hi")])
    const text = boardMsg(msgs).parts[0].text
    expect(text).toContain("Failed")
    expect(text).toContain("c1")
  })

  test("a lane exceeding LANE_TURN_WARN turns is surfaced with its turn count and a cancel_task hint", async () => {
    const hooks = await orchestratorPlugin()
    await fire(hooks, ...created("c1", "orch", "chatty job (@fixer subagent)"))
    for (let i = 0; i < 151; i += 1) {
      await fire(hooks, ...msgUpdated({ role: "assistant", sessionID: "c1" }))
    }
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "hi")])
    const text = boardMsg(msgs).parts[0].text
    expect(text).toContain("Runaway")
    expect(text).toContain("c1")
    expect(text).toContain("151 turns")
    expect(text).toContain("cancel_task")
  })
})

// ─── cancel_task tool (covers cancelLane behavior) ───────────────────────────

describe("cancel_task tool", () => {
  async function setup() {
    const mc = mockClient()
    const hooks = await makePlugin({ client: mc.client })
    const cancelTask = (hooks.tool as any).cancel_task
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...created("c1", "orch", "writer job (@fixer subagent)"))
    return { hooks, mc, cancelTask }
  }

  test("cancels a tracked id: calls session.abort, marks it cancelled, and notes it's not a rollback", async () => {
    const { hooks, mc, cancelTask } = await setup()
    const result = await cancelTask.execute({ task_id: "c1" }, {
      sessionID: "orch",
      agent: "orchestrator",
    } as any)
    expect(mc.calls.abort.length).toBe(1)
    expect(mc.calls.abort[0].path.id).toBe("c1")
    const text = typeof result === "string" ? result : result.output
    expect(text.toLowerCase()).toContain("not a rollback")

    // Cancelled lane renders in a Cancelled section with the not-a-rollback note.
    const msgs = await render(hooks, [userMsg("m1", "orch", "orchestrator", "hi")])
    const boardText = boardMsg(msgs).parts[0].text
    expect(boardText).toContain("Cancelled")
    expect(boardText).toContain("not a rollback")
  })

  test("unknown id: does not call abort, returns a helpful error listing valid ids", async () => {
    const { mc, cancelTask } = await setup()
    const result = await cancelTask.execute({ task_id: "nope" }, {
      sessionID: "orch",
      agent: "orchestrator",
    } as any)
    expect(mc.calls.abort.length).toBe(0)
    const text = typeof result === "string" ? result : result.output
    expect(text).toContain("Unknown task id")
    expect(text).toContain("c1")
  })

  test("refuses when invoked by a non-orchestrator agent", async () => {
    const { mc, cancelTask } = await setup()
    const result = await cancelTask.execute({ task_id: "c1" }, { sessionID: "orch", agent: "fixer" } as any)
    expect(mc.calls.abort.length).toBe(0)
    const text = typeof result === "string" ? result : result.output
    expect(text.toLowerCase()).toContain("refus")
  })

  test("missing task_id: returns an error string, does not throw", async () => {
    const { mc, cancelTask } = await setup()
    const result = await cancelTask.execute({} as any, { sessionID: "orch", agent: "orchestrator" } as any)
    expect(mc.calls.abort.length).toBe(0)
    const text = typeof result === "string" ? result : result.output
    expect(text.toLowerCase()).toContain("task_id")
  })

  test("empty-string task_id: returns an error string, does not throw", async () => {
    const { mc, cancelTask } = await setup()
    const result = await cancelTask.execute({ task_id: "" }, {
      sessionID: "orch",
      agent: "orchestrator",
    } as any)
    expect(mc.calls.abort.length).toBe(0)
    const text = typeof result === "string" ? result : result.output
    expect(text.toLowerCase()).toContain("task_id")
  })
})

// ─── experimental.session.compacting hook (LaneBoard.compactionContext) ─────

describe("experimental.session.compacting hook", () => {
  test("running lane + done lane → contains both child ids and the resume-via-task_id instruction", async () => {
    const hooks = await makePlugin()
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...created("c1", "orch", "map auth (@explorer subagent)"))
    await fire(hooks, ...created("c2", "orch", "fix bug (@fixer subagent)"))
    await fire(hooks, ...idle("c2"))
    const output = await compact(hooks, "orch")
    expect(output.context.length).toBe(1)
    const text = output.context[0]
    expect(text).toContain("c1")
    expect(text).toContain("c2")
    expect(text).toContain("task_id")
    expect(text).toContain("Delegated Lanes")
    expect(output.prompt).toBeUndefined()
  })

  test("non-orchestrator session → nothing pushed", async () => {
    const hooks = await makePlugin()
    await observe(hooks, "build", "build")
    await fire(hooks, ...created("c1", "build", "x (@fixer subagent)"))
    const output = await compact(hooks, "build")
    expect(output.context.length).toBe(0)
    expect(output.prompt).toBeUndefined()
  })

  test("orchestrator session with zero lanes → nothing pushed", async () => {
    const hooks = await makePlugin()
    await observe(hooks, "orch", "orchestrator")
    const output = await compact(hooks, "orch")
    expect(output.context.length).toBe(0)
  })

  test("stale lane is marked STALE in the output", async () => {
    setClock(0)
    const hooks = await makePlugin()
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...created("c1", "orch", "long job (@explorer subagent)"))
    setClock(21 * 60_000)
    const output = await compact(hooks, "orch")
    expect(output.context[0]).toContain("STALE")
    expect(output.context[0]).toContain("c1")
  })

  test("failed lane appears with its id", async () => {
    const hooks = await makePlugin()
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...created("c1", "orch", "risky job (@fixer subagent)"))
    await fire(hooks, ...errEv("c1", { message: "boom" }))
    const output = await compact(hooks, "orch")
    expect(output.context[0]).toContain("c1")
    expect(output.context[0]).toContain("failed")
  })

  test("lists every lane — ids are never dropped", async () => {
    const hooks = await makePlugin()
    await observe(hooks, "orch", "orchestrator")
    for (let i = 0; i < 30; i += 1) {
      await fire(hooks, ...created(`c${i}`, "orch", `job ${i} (@fixer subagent)`))
    }
    const output = await compact(hooks, "orch")
    for (let i = 0; i < 30; i += 1) {
      expect(output.context[0]).toContain(`c${i}`)
    }
  })

  test("determinism: unchanged lane state produces byte-identical output", async () => {
    const hooks = await makePlugin()
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...created("c1", "orch", "map auth (@explorer subagent)"))
    const a = await compact(hooks, "orch")
    const b = await compact(hooks, "orch")
    expect(a.context[0]).toBe(b.context[0])
  })
})

// ─── ModelFailover, exercised through the plugin's event hook ───────────────

describe("ModelFailover (via plugin hooks)", () => {
  // All eligible by default: chat.message observes "orch" as the
  // orchestrator agent before events are fired, same as production wiring.
  async function make() {
    const mc = mockClient()
    mc.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "please build" }] }])
    const hooks = await makePlugin({ client: mc.client, chain: TEST_CHAIN })
    await observe(hooks, "orch", "orchestrator")
    return { mc, hooks }
  }

  test("session.error rate-limit → one promptAsync, no abort, correct {path,body}", async () => {
    const { mc, hooks } = await make()
    await fire(hooks, ...errEv("orch", { statusCode: 429, message: "rate limit exceeded" }))
    expect(mc.calls.abort.length).toBe(0)
    expect(mc.calls.promptAsync.length).toBe(1)
    expect(mc.calls.promptAsync[0].path.id).toBe("orch")
    expect(mc.calls.promptAsync[0].body.model).toEqual({ providerID: "prov", modelID: "a" })
    expect(mc.calls.promptAsync[0].body.parts[0]).toEqual({ type: "text", text: "please build" })
  })

  test("session.status retry → aborts then re-prompts", async () => {
    const { mc, hooks } = await make()
    await fire(hooks, ...status("orch", { type: "retry", message: "429 too many requests" }))
    expect(mc.calls.abort.length).toBe(1)
    expect(mc.calls.promptAsync.length).toBe(1)
  })

  test("dedups a burst and skips the current model", async () => {
    const { mc, hooks } = await make()
    await fire(
      hooks,
      ...msgUpdated({ sessionID: "orch", role: "assistant", providerID: "prov", modelID: "a" }),
    )
    await fire(hooks, ...errEv("orch", { message: "rate limit" }))
    await fire(hooks, ...errEv("orch", { message: "rate limit" }))
    expect(mc.calls.promptAsync.length).toBe(1)
    expect(mc.calls.promptAsync[0].body.model).toEqual({ providerID: "prov", modelID: "b" })
  })

  test("lastUserText skips a trailing synthetic board message", async () => {
    const mc = mockClient()
    mc.setMessages([
      { info: { role: "user" }, parts: [{ type: "text", text: "the real request" }] },
      {
        info: { role: "user" },
        parts: [{ type: "text", synthetic: true, text: "### Background Job Board" }],
      },
    ])
    const hooks = await makePlugin({ client: mc.client, chain: TEST_CHAIN })
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...errEv("orch", { message: "429" }))
    expect(mc.calls.promptAsync[0].body.parts[0].text).toBe("the real request")
  })

  test("non-retryable error does not fail over", async () => {
    const { mc, hooks } = await make()
    await fire(hooks, ...errEv("orch", { statusCode: 400, message: "bad request" }))
    expect(mc.calls.promptAsync.length).toBe(0)
  })

  test("empty chain disables failover", async () => {
    const mc = mockClient()
    mc.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q" }] }])
    process.env.OPENCODE_ORCHESTRATOR_FALLBACK_CHAIN = ""
    const hooks = await makePlugin({ client: mc.client })
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...errEv("orch", { message: "429" }))
    expect(mc.calls.promptAsync.length).toBe(0)
  })

  test("cascade advances a→b→c then stops when exhausted (fake clock, no real sleeps)", async () => {
    const { mc, hooks } = await make()
    setClock(0)
    await fire(hooks, ...errEv("orch", { message: "rate limit" }))
    setClock(5_100)
    await fire(hooks, ...errEv("orch", { message: "rate limit" }))
    setClock(10_200)
    await fire(hooks, ...errEv("orch", { message: "rate limit" }))
    setClock(15_300)
    await fire(hooks, ...errEv("orch", { message: "rate limit" }))
    expect(mc.calls.promptAsync.map((c) => c.body.model.modelID)).toEqual(["a", "b", "c"])
  })

  test("tried-set is not reset by elapsed time: a huge gap does not restart the chain", async () => {
    const { mc, hooks } = await make()
    let t = 0
    setClock(t)
    await fire(hooks, ...errEv("orch", { message: "rate limit" })) // -> a
    t += 10 * 60_000 // 10 minutes later (far past the old 60s reset window)
    setClock(t)
    await fire(hooks, ...errEv("orch", { message: "rate limit" })) // -> b (not a again)
    t += 10 * 60_000
    setClock(t)
    await fire(hooks, ...errEv("orch", { message: "rate limit" })) // -> c
    t += 10 * 60_000
    setClock(t)
    await fire(hooks, ...errEv("orch", { message: "rate limit" })) // chain exhausted, no more replays
    t += 10 * 60_000
    setClock(t)
    await fire(hooks, ...errEv("orch", { message: "rate limit" }))
    expect(mc.calls.promptAsync.map((c) => c.body.model.modelID)).toEqual(["a", "b", "c"])
    expect(mc.calls.promptAsync.length).toBeLessThanOrEqual(TEST_CHAIN.length)
  })

  test("does NOT fail over a non-orchestrator session (e.g. a pinned councillor-gpt seat)", async () => {
    const mc = mockClient()
    mc.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "please build" }] }])
    const hooks = await makePlugin({ client: mc.client, chain: TEST_CHAIN })
    await observe(hooks, "s9", "councillor-gpt")
    await fire(hooks, ...errEv("s9", { message: "rate limit" }))
    expect(mc.calls.promptAsync.length).toBe(0)
  })

  test("DOES fail over an orchestrator session", async () => {
    const mc = mockClient()
    mc.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "please build" }] }])
    const hooks = await makePlugin({ client: mc.client, chain: TEST_CHAIN })
    await observe(hooks, "s10", "orchestrator")
    await fire(hooks, ...errEv("s10", { message: "rate limit" }))
    expect(mc.calls.promptAsync.length).toBe(1)
  })

  test("fail-closed: unknown agent (never observed) does not fail over", async () => {
    const mc = mockClient()
    mc.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "please build" }] }])
    const hooks = await makePlugin({ client: mc.client, chain: TEST_CHAIN })
    await fire(hooks, ...errEv("s11", { message: "rate limit" }))
    expect(mc.calls.promptAsync.length).toBe(0)
  })

  test("replays a file attachment alongside text", async () => {
    const mc = mockClient()
    mc.setMessages([
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "look at this" },
          { type: "file", mime: "image/png", filename: "shot.png", url: "file:///tmp/shot.png" },
        ],
      },
    ])
    const hooks = await makePlugin({ client: mc.client, chain: TEST_CHAIN })
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...errEv("orch", { message: "429" }))
    const parts = mc.calls.promptAsync[0].body.parts
    expect(parts).toEqual([
      { type: "text", text: "look at this" },
      { type: "file", mime: "image/png", filename: "shot.png", url: "file:///tmp/shot.png" },
    ])
  })

  test("does NOT replay when a message has an unreconstructable part type", async () => {
    const mc = mockClient()
    mc.setMessages([
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "hi" },
          { type: "reasoning", text: "internal chain of thought" },
        ],
      },
    ])
    const hooks = await makePlugin({ client: mc.client, chain: TEST_CHAIN })
    await observe(hooks, "orch", "orchestrator")
    await fire(hooks, ...errEv("orch", { message: "429" }))
    expect(mc.calls.promptAsync.length).toBe(0)
  })
})

// ─── DelegateRetry, exercised through the tool.execute.after hook ───────────

describe("DelegateRetry (via tool.execute.after hook)", () => {
  async function apply(output: string) {
    const hooks = await makePlugin()
    const out = { output }
    await hooks["tool.execute.after"]?.({ tool: "task" } as any, out as any)
    return out.output
  }

  test("hints on invalid subagent_type", async () => {
    expect(await apply("Unknown agent type: foo is not a valid agent type")).toContain("valid subagent_type")
  })
  test("hints on subagent depth limit", async () => {
    expect(await apply("Subagent depth limit reached (1).")).toContain("cannot nest deeper")
  })
  test("ignores non-task tools", async () => {
    const hooks = await makePlugin()
    const out = { output: "is not a valid agent type" }
    await hooks["tool.execute.after"]?.({ tool: "read" } as any, out as any)
    expect(out.output).toBe("is not a valid agent type")
  })
  test("ignores a successful task result", async () => {
    const ok = '<task state="completed"><task_result>done</task_result></task>'
    expect(await apply(ok)).toBe(ok)
  })
})

// ─── loader shape (regression for the "Cannot call a class constructor
// ... without |new|" production crash) ───────────────────────────────────────

describe("plugin module loader shape", () => {
  /**
   * Minimal replica of opencode's `getLegacyPlugins`
   * (packages/opencode/src/plugin/index.ts:95-107): iterate every runtime
   * export and call it as a plugin factory. A class is `typeof ===
   * "function"`, so it would be called WITHOUT `new` here too — this is
   * exactly what previously crashed load with `DelegateRetry` exported.
   */
  test("every runtime export is a plain function callable without `new`, and there is exactly one: ParallelOrchestrator", () => {
    const entries = Object.entries(mod)
    expect(entries.length).toBe(1)
    expect(entries[0][0]).toBe("ParallelOrchestrator")
    for (const [, value] of entries) {
      expect(typeof value).toBe("function")
      // A class throws "Cannot call a class constructor ... without |new|"
      // when invoked this way; a plugin factory function must not.
      expect(() => (value as (...args: unknown[]) => unknown)({}, undefined)).not.toThrow()
    }
    expect((mod as { default?: unknown }).default).toBeUndefined()
  })

  test("ParallelOrchestrator(ctx) resolves to hooks containing tool.cancel_task", async () => {
    const hooks = await (mod.ParallelOrchestrator as any)({}, undefined)
    expect(typeof (hooks.tool as any).cancel_task.execute).toBe("function")
  })
})

// ─── no runtime import of @opencode-ai/plugin (regression for the plugin
// silently failing to load: ResolveMessage "Cannot find module
// '@opencode-ai/plugin'" thrown from a standalone file in the Nix store with
// no node_modules next to it) ────────────────────────────────────────────────

describe("plugin.ts has no runtime package imports", () => {
  const source = readFileSync(join(__dirname, "plugin.ts"), "utf8")
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) && /["']@opencode-ai\/plugin["']/.test(line))

  test("every import of @opencode-ai/plugin is type-only", () => {
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) {
      expect(
        /^\s*import\s+type\b/.test(line),
        `"${line.trim()}" must be "import type ..." — this file is loaded standalone from the Nix ` +
          "store with no node_modules/@opencode-ai/plugin next to it, so any runtime import of that " +
          "package throws ResolveMessage and silently aborts plugin load (surfaced only as a client " +
          "toast, never in opencode.log).",
      ).toBe(true)
    }
  })

  test("the only bare-specifier imports are node: builtins or type-only", () => {
    const bareImports = source.split("\n").filter((line) => /^\s*import\b.*\bfrom\s+["'][^./]/.test(line))
    for (const line of bareImports) {
      const isTypeOnly = /^\s*import\s+type\b/.test(line)
      const isNodeBuiltin = /from\s+["']node:/.test(line)
      expect(
        isTypeOnly || isNodeBuiltin,
        `"${line.trim()}" is a runtime import of a bare (non node:) specifier — this standalone ` +
          "plugin file cannot resolve packages at runtime.",
      ).toBe(true)
    }
  })
})

// ─── cancel_task tool shape (regression for opencode's isPluginTool /
// fromPlugin structural check: registry.ts:350-366) ──────────────────────────

describe("cancel_task tool structural shape (isPluginTool / legacyJsonSchema)", () => {
  test("is a plain object with description/args/execute matching the legacy JSON-Schema form", async () => {
    const hooks = await (mod.ParallelOrchestrator as any)({}, undefined)
    const cancelTask = (hooks.tool as any).cancel_task
    expect(typeof cancelTask.description).toBe("string")
    expect(typeof cancelTask.args).toBe("object")
    expect(typeof cancelTask.execute).toBe("function")
    expect(typeof cancelTask.args.task_id).toBe("object")
    expect(cancelTask.args.task_id.type).toBe("string")
    expect(typeof cancelTask.args.task_id.description).toBe("string")
    // Must NOT be a Zod schema (fromPlugin picks Zod vs. legacy JSON Schema
    // based on this): a plain JSON-Schema field has no `.parse`/`._def`.
    expect((cancelTask.args.task_id as { parse?: unknown }).parse).toBeUndefined()
  })
})
