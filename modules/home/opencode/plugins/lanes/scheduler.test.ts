import { describe, expect, test } from "bun:test"

import type { Fields, Log } from "./log"
import { type AgentInfo, type Host, Lanes, type SessionInfo } from "./scheduler"
import { type Message, RESUME, type Run } from "./state"
import { readView, VIEW_KEY } from "./view"

interface FakeSession {
	info: SessionInfo
	agent?: string
	prompts: { text: string; delivery?: string }[]
	messages: Message[]
	waiters: (() => void)[]
	busy: boolean
}

type Outcome = "succeeded" | "failed" | "interrupted"

const opus = { providerID: "github-copilot", id: "claude-opus-5.5", variant: "medium" }
const sonnet = { providerID: "github-copilot", id: "claude-sonnet-5.5", variant: "medium" }

function fake(crew?: Record<string, string>) {
	const sessions = new Map<string, FakeSession>()
	const storage = new Map<string, unknown>()
	const notes: { sessionID: string; text: string; resume: boolean }[] = []
	const logs: { level: string; event: string; fields?: Fields }[] = []
	let next = 0
	const add = (id: string, info: Omit<SessionInfo, "id"> = {}) => {
		const session: FakeSession = { info: { id, ...info }, prompts: [], messages: [], waiters: [], busy: false }
		sessions.set(id, session)
		return session
	}
	add("origin", { metadata: crew ? { crew: { models: crew } } : { theme: "kept" }, model: opus })
	const agents: AgentInfo[] = [
		{ id: "dev", mode: "primary" },
		{ id: "planner", mode: "subagent", model: opus },
		{ id: "dev-junior", mode: "subagent", model: sonnet },
		{ id: "dev-senior", mode: "subagent" },
	]
	const session = (id: string) => {
		const found = sessions.get(id)
		if (!found) throw new Error(`no session ${id}`)
		return found
	}
	const release = (target: FakeSession) => {
		target.busy = false
		for (const resolve of target.waiters.splice(0)) resolve()
	}
	// Ends the session's execution the way OpenCode records it: the answer, then an `idle` record.
	const finish = (id: string, outcome: Outcome, text?: string, error?: string) => {
		const target = session(id)
		if (text !== undefined || error !== undefined)
			target.messages.push({
				type: "assistant",
				content: text ? [{ type: "text", text }] : [],
				...(error ? { error: { message: error } } : {}),
			})
		target.messages.push({ type: "idle", outcome })
		release(target)
	}
	// A shutdown stops the execution without an `idle` record.
	const shutdown = (id: string) => release(session(id))
	const record = (level: string) => (event: string, fields?: Fields) => {
		logs.push({ level, event, fields })
	}
	const log: Log = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") }
	const host: Host = {
		directory: "/repo",
		maxLanes: 8,
		log,
		settleMs: 5,
		publishDelayMs: 0,
		now: () => 1000,
		storage: {
			get: async (key) => storage.get(key),
			set: async (key, value) => {
				storage.set(key, value)
			},
			values: async (prefix) =>
				[...storage.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
		},
		session: {
			async create({ parentID, agent, model }) {
				const created = add(`s${++next}`, { parentID, model, metadata: session(parentID).info.metadata })
				created.agent = agent
				return { id: created.info.id }
			},
			async prompt({ sessionID, text, delivery }) {
				const target = session(sessionID)
				target.prompts.push({ text, delivery })
				target.messages.push({ type: "user", content: [{ type: "text", text }] })
				target.busy = true
			},
			async synthetic({ sessionID, text, resume }) {
				notes.push({ sessionID, text, resume })
			},
			wait: ({ sessionID }) => {
				const target = session(sessionID)
				return target.busy ? new Promise<void>((resolve) => target.waiters.push(resolve)) : Promise.resolve()
			},
			async interrupt({ sessionID }) {
				if (session(sessionID).busy) finish(sessionID, "interrupted")
			},
			get: async ({ sessionID }) => session(sessionID).info,
			async update({ sessionID, metadata }) {
				const target = session(sessionID)
				target.info = { ...target.info, metadata }
			},
			context: async ({ sessionID }) => session(sessionID).messages,
		},
		agents: async () => agents,
	}
	const settle = async () => {
		for (let index = 0; index < 30; index++) await new Promise((resolve) => setTimeout(resolve, 1))
	}
	const view = (id: string) => readView(session(id).info.metadata?.[VIEW_KEY])
	return { host, session, sessions, storage, notes, logs, finish, shutdown, settle, view }
}

const statuses = (run: Run) => Object.fromEntries(run.tasks.map((task) => [task.id, task.status]))
const task = (run: Run, id: string) => {
	const found = run.tasks.find((task) => task.id === id)
	if (!found) throw new Error(`no task ${id}`)
	return found
}
const worker = (run: Run, id: string) => task(run, id).sessionID as string

const four = [
	{ id: "a", title: "A", prompt: "Do A.", files: ["src/a.ts"] },
	{ id: "b", title: "B", prompt: "Do B.", files: ["src/a.ts"] },
	{ id: "c", title: "C", prompt: "Do C.", files: ["src/c.ts"], deps: ["a"] },
	{ id: "d", title: "D", prompt: "Do D.", files: ["docs/"], agent: "dev-senior" },
]

async function started(f: ReturnType<typeof fake>, input: Parameters<Lanes["start"]>[1]) {
	const lanes = new Lanes(f.host)
	const run = await lanes.start("origin", input)
	await f.settle()
	return { lanes, run, planner: run.planner as string }
}

describe("running tasks", () => {
	test("fills lanes in order, honoring dependencies and file overlap", async () => {
		const f = fake()
		const { run, planner } = await started(f, { goal: "Ship", lanes: 2, tasks: four })
		expect(statuses(run)).toEqual({ a: "running", b: "queued", c: "queued", d: "running" })
		expect(f.session(planner).agent).toBe("planner")
		expect(f.session(planner).info.parentID).toBe("origin")
		expect(f.session(planner).prompts[0]?.text).toContain("already queued these tasks")
		const session = f.session(worker(run, "a"))
		expect(session.info.parentID).toBe(planner)
		expect(session.prompts[0]?.text).toContain("Lane task a of run")
		expect(session.prompts[0]?.text).toContain("Context only, do not act on it")
	})

	test("refills a freed lane and keeps the worker's report", async () => {
		const f = fake()
		const { run, planner } = await started(f, { goal: "Ship", lanes: 2, tasks: four })
		f.finish(planner, "succeeded")
		f.finish(worker(run, "a"), "succeeded", "Changed src/a.ts.")
		await f.settle()
		expect(task(run, "a").report).toBe("Changed src/a.ts.")
		expect(statuses(run)).toEqual({ a: "done", b: "running", c: "queued", d: "running" })
		f.finish(worker(run, "d"), "succeeded", "Docs.")
		await f.settle()
		expect(statuses(run)).toEqual({ a: "done", b: "running", c: "running", d: "done" })
	})

	test("wakes the planner with results and reports the finished run", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship", lanes: 4, tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		f.finish(worker(run, "a"), "succeeded", "Changed src/a.ts.")
		await f.settle()
		expect(f.session(planner).prompts[1]?.text).toContain("a A [done]: Changed src/a.ts.")
		await lanes.finish(run, "All done; tests pass.")
		f.finish(planner, "succeeded")
		await f.settle()
		expect(run.status).toBe("done")
		expect(f.notes).toHaveLength(1)
		expect(f.notes[0]?.sessionID).toBe("origin")
		expect(f.notes[0]?.resume).toBe(false)
		expect(f.notes[0]?.text).toContain('state="done"')
		expect(f.notes[0]?.text).toContain("All done; tests pass.")
	})

	test("retries a failure once, then fails it and tells the orchestrator", async () => {
		const f = fake()
		const { run, planner } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		const session = worker(run, "a")
		f.finish(session, "failed", undefined, "rate limited")
		await f.settle()
		expect(f.session(session).prompts[1]?.text).toContain("ended with an error (rate limited)")
		expect(task(run, "a").status).toBe("running")
		f.finish(session, "failed", undefined, "rate limited again")
		await f.settle()
		expect(task(run, "a").status).toBe("failed")
		expect(task(run, "a").error).toBe("rate limited again")
		expect(f.notes[0]?.text).toContain('state="failed"')
		expect(f.session(planner).prompts[1]?.text).toContain("[failed]: rate limited again")
	})

	test("rejects finishing while tasks still run", async () => {
		const f = fake()
		const { lanes, run } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		await expect(lanes.finish(run, "Done.")).rejects.toThrow("a still running")
	})
})

describe("interrupts and restarts", () => {
	test("a user interrupt cancels the task without a retry and tells the planner", async () => {
		const f = fake()
		const { run, planner } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		const session = worker(run, "a")
		await f.host.session.interrupt({ sessionID: session, resume: false })
		await f.settle()
		expect(task(run, "a").status).toBe("cancelled")
		expect(task(run, "a").error).toBe("interrupted by the user")
		expect(f.session(session).prompts).toHaveLength(1)
		expect(f.session(planner).prompts[1]?.text).toContain("a A [cancelled]: interrupted by the user")
		expect(f.notes).toEqual([])
	})

	test("a shutdown leaves the task running, and the restarted plugin resumes it", async () => {
		const f = fake()
		const { run, planner } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		const session = worker(run, "a")
		f.shutdown(session)
		await f.settle()
		expect(task(run, "a").status).toBe("running")
		expect(f.logs.some((entry) => entry.event === "task.stopped")).toBe(true)

		const restarted = new Lanes(f.host)
		await restarted.load()
		await f.settle()
		expect(f.session(session).prompts.at(-1)?.text).toBe(RESUME)
		f.finish(session, "succeeded", "Done A.")
		await f.settle()
		const resumed = await restarted.find(run.id)
		expect(task(resumed, "a").status).toBe("done")
		expect(task(resumed, "a").report).toBe("Done A.")
	})

	test("a restart only watches workers that are still running", async () => {
		const f = fake()
		const { run, planner } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		await f.settle()
		const restarted = new Lanes(f.host)
		await restarted.load()
		await f.settle()
		expect(f.session(worker(run, "a")).prompts).toHaveLength(1)
		f.finish(worker(run, "a"), "succeeded", "Done A.")
		await f.settle()
		expect(task(await restarted.find(run.id), "a").status).toBe("done")
		expect(f.logs.some((entry) => entry.event === "runs.resumed")).toBe(true)
	})

	test("an interrupted planner pauses the run and tells the orchestrator", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship" })
		await f.host.session.interrupt({ sessionID: planner, resume: false })
		await f.settle()
		expect(run.stalled).toBe(true)
		expect(f.notes[0]?.text).toContain('state="paused"')
		expect(f.view(planner)?.planner).toBe("paused")
		expect(f.session(planner).prompts).toHaveLength(1)
		await lanes.tell(run, "Carry on.")
		await f.settle()
		expect(run.stalled).toBeUndefined()
		expect(f.session(planner).prompts.at(-1)?.text).toBe("Message from the orchestrator: Carry on.")
	})
})

describe("the run summary", () => {
	test("is kept on the planner session next to its other metadata", async () => {
		const f = fake()
		const { run, planner } = await started(f, { goal: "Ship", lanes: 2, tasks: four })
		expect(f.session(planner).info.metadata?.theme).toBe("kept")
		expect(f.view(planner)).toMatchObject({
			v: 1,
			run: run.id,
			goal: "Ship",
			status: "running",
			planner: "thinking",
			lanes: 2,
		})
		expect(f.view(planner)?.tasks.map((item) => `${item.id}:${item.status}`)).toEqual([
			"a:running",
			"b:queued",
			"c:queued",
			"d:running",
		])
		expect(f.view(planner)?.tasks[0]?.session).toBe(worker(run, "a"))
		f.finish(planner, "succeeded")
		f.finish(worker(run, "a"), "succeeded", "Done A.")
		await f.settle()
		expect(f.view(planner)?.tasks[0]?.status).toBe("done")
	})
})

describe("permissions", () => {
	test("a request blocks the lane once and a reply unblocks it", async () => {
		const f = fake()
		const { lanes, run } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		const sessionID = worker(run, "a")
		const request = { id: "p1", sessionID, action: "shell", resources: ["rm -rf build"] }
		lanes.asked(request)
		lanes.asked(request)
		await f.settle()
		expect(task(run, "a").status).toBe("blocked")
		expect(f.notes).toHaveLength(1)
		expect(f.notes[0]?.text).toContain("waits for approval: shell rm -rf build")
		lanes.replied(sessionID)
		expect(task(run, "a").status).toBe("running")
	})
})

describe("the planner", () => {
	test("splits the goal, gets one nudge when idle, then the run is reported stalled", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship" })
		expect(f.session(planner).prompts[0]?.text).toContain("Add tasks with plan_add")
		await lanes.plan(run, [{ title: "A", prompt: "Do A." }])
		f.finish(planner, "succeeded")
		await f.settle()
		expect(statuses(run)).toEqual({ t1: "running" })
		f.finish(worker(run, "t1"), "succeeded", "Done A.")
		await f.settle()
		f.finish(planner, "succeeded")
		await f.settle()
		expect(f.session(planner).prompts[2]?.text).toContain("Nothing is running or queued")
		f.finish(planner, "succeeded")
		await f.settle()
		expect(run.stalled).toBe(true)
		expect(f.notes[0]?.text).toContain('state="stalled"')
	})

	test("asks the orchestrator and is woken with the answer", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship" })
		await lanes.ask(run, "Which API version?")
		f.finish(planner, "succeeded")
		await f.settle()
		expect(f.notes[0]?.text).toContain("The planner asks: Which API version?")
		expect(lanes.lines("origin")[0]).toContain("Planner asks: Which API version?")
		expect(f.view(planner)?.planner).toBe("asking")
		await lanes.tell(run, "Use v3.")
		await f.settle()
		expect(run.question).toBeUndefined()
		expect(f.session(planner).prompts.at(-1)?.text).toBe("Message from the orchestrator: Use v3.")
	})
})

describe("the orchestrator", () => {
	test("steers queued, running, and finished tasks", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship", lanes: 1, tasks: four.slice(0, 2) })
		f.finish(planner, "succeeded")
		await lanes.tell(run, "Keep the API.", "b")
		expect(task(run, "b").prompt).toContain("Update from the orchestrator: Keep the API.")
		const session = worker(run, "a")
		await lanes.tell(run, "Use tabs.", "a")
		expect(f.session(session).prompts.at(-1)).toEqual({
			text: "Update from the orchestrator: Use tabs.",
			delivery: "steer",
		})
		f.finish(session, "succeeded", "Done A.")
		await f.settle()
		await lanes.tell(run, "Also add a test.", "a")
		expect(task(run, "a").status).toBe("running")
		expect(f.session(session).prompts.at(-1)).toEqual({ text: "Follow-up from the orchestrator: Also add a test." })
	})

	test("adds tasks and notes, and stops tasks or the whole run", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship", lanes: 1, tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		await lanes.update(run, { tasks: [{ id: "e", title: "E", prompt: "Do E." }], notes: ["Use tabs."], lanes: 20 })
		await f.settle()
		expect(run.lanes).toBe(8)
		expect(run.notes).toEqual(["Use tabs."])
		expect(statuses(run)).toEqual({ a: "running", e: "running" })
		expect(f.session(worker(run, "e")).prompts[0]?.text).toContain("- Use tabs.")
		await lanes.stop(run, "a")
		await f.settle()
		expect(task(run, "a").status).toBe("cancelled")
		expect(await lanes.stop(run)).toBe(`Stopped run ${run.id}: 1 lanes interrupted.`)
		expect(statuses(run)).toEqual({ a: "cancelled", e: "cancelled" })
		expect(run.status).toBe("stopped")
	})
})

test("models come from the task, then /crew, the agent, and the orchestrator", async () => {
	const f = fake({ "dev-senior": "acme/claude-opus#high" })
	const { run, planner } = await started(f, {
		goal: "Ship",
		lanes: 4,
		tasks: [
			{ id: "x", title: "X", prompt: "x", agent: "dev-senior" },
			{ id: "y", title: "Y", prompt: "y" },
			{ id: "z", title: "Z", prompt: "z", model: "github-copilot/gpt-6-luna#xhigh" },
		],
	})
	const model = (id: string) => f.session(worker(run, id)).info.model
	expect(model("x")).toEqual({ providerID: "acme", id: "claude-opus", variant: "high" })
	expect(model("y")).toEqual(sonnet)
	expect(model("z")).toEqual({ providerID: "github-copilot", id: "gpt-6-luna", variant: "xhigh" })
	expect(f.session(planner).info.model).toEqual(opus)
	const g = fake()
	const other = await started(g, { goal: "Ship", tasks: [{ id: "x", title: "X", prompt: "x", agent: "dev-senior" }] })
	expect(g.session(worker(other.run, "x")).info.model).toEqual(opus)
})

test("the orchestrator sees a status line and the log records each step", async () => {
	const f = fake()
	const { lanes, run, planner } = await started(f, { goal: "Ship", lanes: 2, tasks: four })
	expect(lanes.lines("origin")).toEqual([`Lanes run ${run.id} (Ship): 0/4 done · 2 running · 2 queued.`])
	expect(lanes.lines("someone-else")).toEqual([])
	f.finish(planner, "succeeded")
	f.finish(worker(run, "a"), "succeeded", "Done A.")
	await f.settle()
	const events = f.logs.map((entry) => entry.event)
	for (const event of ["run.started", "planner.wake", "task.launching", "task.session", "task.idle", "task.done"])
		expect(events).toContain(event)
})

describe("lanes_wait", () => {
	test("hands the done note to the waiter instead of the chat", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		const waiting = lanes.wait(run, 60_000)
		f.finish(worker(run, "a"), "succeeded", "Done A.")
		await f.settle()
		await lanes.finish(run, "All done.")
		expect(await waiting).toContain('state="done"')
		expect(await waiting).toContain("All done.")
		expect(f.notes).toEqual([])
		expect(await lanes.wait(run, 60_000)).toContain('state="done"')
	})

	test("returns a planner question, but not a failure the planner handles", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		let result: string | undefined
		void lanes.wait(run, 60_000).then((text) => {
			result = text
		})
		f.finish(worker(run, "a"), "failed", undefined, "boom")
		await f.settle()
		f.finish(worker(run, "a"), "failed", undefined, "boom again")
		await f.settle()
		expect(result).toBeUndefined()
		expect(f.notes.map((note) => note.text).join("\n")).toContain('state="failed"')
		await lanes.ask(run, "Which branch?")
		await f.settle()
		expect(result).toContain("The planner asks: Which branch?")
	})

	test("ends on its time limit, an interrupted turn, or a stopped run", async () => {
		const f = fake()
		const { lanes, run, planner } = await started(f, { goal: "Ship", tasks: four.slice(0, 1) })
		f.finish(planner, "succeeded")
		expect(await lanes.wait(run, 5)).toStartWith("Still running after 0 seconds. Lanes run")
		const abort = new AbortController()
		const interrupted = lanes.wait(run, 60_000, abort.signal)
		abort.abort()
		expect(await interrupted).toBe("Stopped waiting: the turn was interrupted.")
		const stopping = lanes.wait(run, 60_000)
		await lanes.stop(run)
		expect(await stopping).toStartWith(`Run ${run.id} was stopped.`)
	})
})
