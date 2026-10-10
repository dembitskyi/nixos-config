// `lanes` server side (OpenCode V2): runs a goal as tasks in parallel worker
// sessions under a planner session while the orchestrator's own conversation
// stays quiet. See scheduler.ts for the loop, state.ts for the data model, and
// log.ts for the troubleshooting log.
import { defaultPath, fileLog, isLevel, type Log } from "./log"
import { type AgentInfo, type Host, Lanes, type Permission } from "./scheduler"
import { board, isRecord, taskReport } from "./state"

type Input = Record<string, unknown>

interface ToolInfo {
	name: string
	description: string
	input: Record<string, unknown>
	options: { codemode: false }
	execute(
		input: Input,
		context: { readonly sessionID: string; readonly signal?: AbortSignal },
	): Promise<{ content: string }>
}

export interface ServerContext {
	readonly options: Readonly<Record<string, unknown>>
	readonly location: { readonly directory: string }
	readonly agent: { list(): Promise<{ data: readonly AgentInfo[] }> }
	readonly event: {
		subscribe(input: { signal: AbortSignal }): AsyncIterable<{ readonly type: string; readonly data?: unknown }>
	}
	readonly storage: {
		get(key: string): Promise<unknown>
		set(key: string, value: unknown): Promise<void>
		scan(options: {
			prefix: string
			after?: string
		}): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
	}
	readonly session: Host["session"] & {
		hook(
			name: "context",
			callback: (event: { readonly sessionID: string; system: { type: "text"; text: string }[] }) => Promise<void>,
		): Promise<unknown>
	}
	readonly tool: { transform(callback: (editor: { add(tool: ToolInfo): void }) => void): Promise<unknown> }
}

const string = { type: "string" }
const strings = { type: "array", items: string }
const lanesCount = { type: "integer", minimum: 1 }
const tasks = {
	type: "array",
	minItems: 1,
	items: {
		type: "object",
		additionalProperties: false,
		required: ["title", "prompt"],
		properties: {
			id: {
				type: "string",
				description: "Short unique ID: lowercase letters, digits, dashes. Generated when omitted.",
			},
			title: { type: "string", description: "A few words naming the task." },
			prompt: {
				type: "string",
				description:
					"Self-contained instructions: what to change and where, the conventions to follow, and the checks to run.",
			},
			agent: {
				type: "string",
				description:
					"Worker subagent: dev-junior for small, well-specified work, dev-senior for complex work, dev-master for very tough problems, reviewer to review finished tasks (no files). Defaults to dev-junior.",
			},
			model: { type: "string", description: "Optional model override as provider/model#variant." },
			deps: { ...strings, description: "IDs of tasks that must finish first." },
			files: {
				...strings,
				description: "Files or directories the task edits; lanes never edit overlapping files at the same time.",
			},
		},
	},
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
const positive = (value: unknown, fallback: number) =>
	typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback

function isPermission(value: unknown): value is Permission {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.sessionID === "string" &&
		typeof value.action === "string" &&
		Array.isArray(value.resources)
	)
}

export function host(ctx: ServerContext, log: Log): Host {
	return {
		directory: ctx.location.directory,
		maxLanes: positive(ctx.options.maxLanes, 8),
		log,
		settleMs: 1000,
		publishDelayMs: 300,
		now: () => Date.now(),
		storage: {
			get: (key) => ctx.storage.get(key),
			set: (key, value) => ctx.storage.set(key, value),
			async values(prefix) {
				const values: unknown[] = []
				let after: string | undefined
				do {
					const page = await ctx.storage.scan({ prefix, ...(after ? { after } : {}) })
					values.push(...page.entries.map((entry) => entry.value))
					after = page.next
				} while (after)
				return values
			},
		},
		session: ctx.session,
		agents: async () => (await ctx.agent.list()).data,
	}
}

export function tools(lanes: Lanes, log: Log, now: () => number): ToolInfo[] {
	const tool = (
		name: string,
		description: string,
		properties: Record<string, unknown>,
		required: string[],
		execute: (input: Input, context: { readonly sessionID: string; readonly signal?: AbortSignal }) => Promise<string>,
	): ToolInfo => ({
		name,
		description,
		input: { type: "object", additionalProperties: false, required, properties },
		options: { codemode: false },
		// Errors come back as text the model can act on.
		async execute(input, context) {
			const fields = { tool: name, session: context.sessionID, run: text(input.run) || undefined }
			log.info("tool.call", fields)
			try {
				return { content: await execute(input, context) }
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				log.warn("tool.error", { ...fields, error: message })
				return { content: `Error: ${message}` }
			}
		},
	})

	return [
		tool(
			"lanes_start",
			"Run a goal as parallel lanes: a planner splits it into tasks for worker subagents in their own sessions and keeps up to `lanes` of them busy until the goal is done. Returns at once; a status line in your context tracks the run and milestone notes arrive on their own, so do not poll. Pass `tasks` to queue work yourself.",
			{ goal: string, lanes: lanesCount, tasks, notes: strings },
			["goal"],
			async (input, { sessionID }) => {
				const run = await lanes.start(sessionID, input)
				const starting = run.tasks.filter((task) => task.status === "running").length
				const plan = run.tasks.length
					? `${run.tasks.length} tasks queued, ${starting} starting now`
					: "the planner is splitting the goal into tasks"
				return `Started run ${run.id} with ${run.lanes} lanes; ${plan}. Use lanes_status for details.`
			},
		),
		tool(
			"lanes_status",
			"Show a lanes run's board, or one task's report when `task` is given. Without `run`, shows the runs this session started that are still going.",
			{ run: string, task: string },
			[],
			async (input, { sessionID }) => {
				if (!text(input.run)) {
					const runs = lanes.running().filter((run) => run.origin === sessionID)
					return runs.length
						? runs.map((run) => board(run, now())).join("\n\n")
						: "No running lanes runs for this session."
				}
				const run = await lanes.find(text(input.run))
				if (!text(input.task)) return board(run, now())
				const task = run.tasks.find((task) => task.id === text(input.task))
				if (!task) throw new Error(`Run ${run.id} has no task "${text(input.task)}".`)
				return taskReport(run, task)
			},
		),
		tool(
			"lanes_update",
			"Add tasks or shared notes (decisions, conventions) to a running lanes run, or change its number of lanes. Notes reach every task that starts afterwards.",
			{ run: string, tasks, notes: strings, lanes: lanesCount },
			["run"],
			async (input) => {
				const run = await lanes.find(text(input.run))
				const { added, notes } = await lanes.update(run, input)
				const queued = added.length ? `queued ${added.map((task) => task.id).join(", ")}` : "no new tasks"
				return `Run ${run.id}: ${queued}; ${notes} notes added; ${run.lanes} lanes.`
			},
		),
		tool(
			"lanes_tell",
			"Message a lanes run's planner, for example to change priorities or scope. With `task`, message that task's worker instead: running tasks see it at their next step, finished ones take it as a follow-up. The messaged session first moves to the model /crew now assigns it.",
			{ run: string, text: string, task: string },
			["run", "text"],
			async (input) => {
				if (!text(input.text)) throw new Error("Give the message text.")
				return lanes.tell(await lanes.find(text(input.run)), text(input.text), text(input.task) || undefined)
			},
		),
		tool(
			"lanes_stop",
			"Stop a whole lanes run, or cancel one task when `task` is given.",
			{ run: string, task: string },
			["run"],
			async (input) => lanes.stop(await lanes.find(text(input.run)), text(input.task) || undefined),
		),
		tool(
			"lanes_wait",
			"Wait until a lanes run finishes or needs you (a planner question, a blocked lane, or a stalled or paused planner), for at most `minutes` (default 60). Use it when you work without the user, for example toward a /goal or while they are away, instead of polling lanes_status; in a normal conversation end your turn instead, and the run's notes arrive on their own.",
			{ run: string, minutes: { type: "integer", minimum: 1, maximum: 240 } },
			["run"],
			async (input, { signal }) => {
				const run = await lanes.find(text(input.run))
				return lanes.wait(run, Math.min(positive(input.minutes, 60), 240) * 60_000, signal)
			},
		),
		tool(
			"plan_add",
			"Queue tasks for the lanes run you plan. Each task runs in its own worker session: give it a self-contained prompt, the files it edits, and its dependencies.",
			{ tasks },
			["tasks"],
			async (input, { sessionID }) => {
				const run = lanes.planned(sessionID)
				const added = await lanes.plan(run, input.tasks)
				const busy = run.tasks.filter((task) => task.status === "running").length
				return `Queued ${added.map((task) => task.id).join(", ")}; ${busy}/${run.lanes} lanes busy.`
			},
		),
		tool(
			"plan_cancel",
			"Cancel queued or running tasks of the lanes run you plan.",
			{ tasks: strings, reason: string },
			["tasks"],
			async (input, { sessionID }) => {
				const cancelled = await lanes.drop(lanes.planned(sessionID), input.tasks, text(input.reason) || undefined)
				return `Cancelled ${cancelled.map((task) => task.id).join(", ") || "nothing"}.`
			},
		),
		tool(
			"plan_finish",
			"Finish the lanes run you plan with a short summary for the orchestrator: what was done, how it was verified, and open issues. Only works when no task is running.",
			{ summary: string },
			["summary"],
			async (input, { sessionID }) => {
				await lanes.finish(lanes.planned(sessionID), text(input.summary))
				return "Run finished; the orchestrator has your summary."
			},
		),
		tool(
			"plan_ask",
			"Ask the orchestrator for a decision you cannot make yourself, then end your turn; you are woken with the answer.",
			{ question: string },
			["question"],
			async (input, { sessionID }) => {
				if (!text(input.question)) throw new Error("Give the question.")
				await lanes.ask(lanes.planned(sessionID), text(input.question))
				return "Asked the orchestrator. End your turn; you will be woken with the answer."
			},
		),
	]
}

export default {
	id: "lanes",
	async setup(ctx: ServerContext) {
		const path = text(ctx.options.logFile) || defaultPath("lanes")
		const level = isLevel(ctx.options.logLevel) ? ctx.options.logLevel : "info"
		const log = fileLog(path, level)
		const lanes = new Lanes(host(ctx, log))
		log.info("plugin.setup", {
			directory: ctx.location.directory,
			maxLanes: positive(ctx.options.maxLanes, 8),
			level,
			path,
		})

		await ctx.tool.transform((editor) => {
			for (const info of tools(lanes, log, () => Date.now())) editor.add(info)
		})
		// The status lines are logged when they change, as evidence the orchestrator sees them.
		const shown = new Map<string, string>()
		await ctx.session.hook("context", async (event) => {
			const lines = lanes.lines(event.sessionID)
			for (const line of lines) event.system.push({ type: "text", text: line })
			const joined = lines.join("\n")
			if ((shown.get(event.sessionID) ?? "") === joined) return
			if (joined) shown.set(event.sessionID, joined)
			else shown.delete(event.sessionID)
			log.info("context.lines", { session: event.sessionID, lines })
		})

		const abort = new AbortController()
		void (async () => {
			log.info("events.subscribed", { directory: ctx.location.directory })
			for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
				if (event.type === "permission.asked" && isPermission(event.data)) lanes.asked(event.data)
				else if (
					event.type === "permission.replied" &&
					isRecord(event.data) &&
					typeof event.data.sessionID === "string"
				)
					lanes.replied(event.data.sessionID)
			}
			if (!abort.signal.aborted) log.warn("events.ended", { directory: ctx.location.directory })
		})().catch((error) => {
			if (!abort.signal.aborted) log.error("events.failed", { directory: ctx.location.directory, error })
		})

		// Setup must not wait on sessions: prompts wait for every plugin to finish activating.
		void lanes.load().catch((error) => log.error("runs.resume-failed", { directory: ctx.location.directory, error }))
		return () => {
			log.info("plugin.cleanup", { directory: ctx.location.directory })
			abort.abort()
			return log.flush()
		}
	},
}
