// The lane loop: keeps each run's lanes busy with worker sessions, wakes the
// planner when new results need decisions, and reports milestones to the
// orchestrator. OpenCode is reached through `Host`, so the loop can be tested
// with fakes. Every transition is logged; see log.ts.
//
// How a session ended comes from the `idle` record OpenCode appends when an
// execution ends: `succeeded`, `failed`, or `interrupted` (someone stopped
// it). A shutdown appends none, so such sessions are resumed after a restart.
import type { Log } from "./log"
import {
	active,
	cap,
	clampLanes,
	counts,
	finalError,
	finalText,
	finished,
	formatModel,
	isModelRef,
	isRecord,
	kickoff,
	line,
	type Message,
	type ModelRef,
	NUDGE,
	newID,
	noteBlocked,
	noteDone,
	noteFailed,
	notePaused,
	noteQuestion,
	noteStalled,
	PLANNER,
	parseModel,
	REPORT_LIMIT,
	RESUME,
	type Run,
	readStrings,
	readTasks,
	startable,
	stuck,
	type Task,
	wake,
	workerPrompt,
} from "./state"
import { type PlannerState, toView, VIEW_KEY } from "./view"

export interface AgentInfo {
	id: string
	mode: "subagent" | "primary" | "all"
	model?: ModelRef
}

export interface SessionInfo {
	id: string
	parentID?: string
	metadata?: Readonly<Record<string, unknown>>
	model?: ModelRef
}

export interface Permission {
	id: string
	sessionID: string
	action: string
	resources: readonly string[]
}

export interface Host {
	readonly directory: string
	readonly maxLanes: number
	readonly log: Log
	// How long a session may take to report idle before it counts as still running.
	readonly settleMs: number
	// Coalesces run summary writes to the planner session.
	readonly publishDelayMs: number
	now(): number
	readonly storage: {
		get(key: string): Promise<unknown>
		set(key: string, value: unknown): Promise<void>
		values(prefix: string): Promise<readonly unknown[]>
	}
	readonly session: {
		create(input: { parentID: string; title: string; agent: string; model?: ModelRef }): Promise<{ id: string }>
		prompt(input: { sessionID: string; text: string; delivery?: "steer" }): Promise<unknown>
		synthetic(input: {
			sessionID: string
			text: string
			description: string
			resume: false
			metadata: Record<string, unknown>
		}): Promise<unknown>
		wait(input: { sessionID: string }): Promise<void>
		interrupt(input: { sessionID: string; resume: false }): Promise<unknown>
		get(input: { sessionID: string }): Promise<SessionInfo>
		update(input: { sessionID: string; metadata: Record<string, unknown> }): Promise<unknown>
		context(input: { sessionID: string }): Promise<readonly Message[]>
	}
	agents(): Promise<readonly AgentInfo[]>
}

const RETRIES = 1
// Notes that need the orchestrator: a waiting lanes_wait call receives them instead of the chat.
const RELEASES = new Set(["done", "question", "blocked", "stalled", "paused"])
const key = (id: string) => `run:${id}`
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
const ids = (tasks: readonly Task[]) => tasks.map((task) => task.id)
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function readRun(value: unknown): Run | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.origin !== "string") return undefined
	if (!Array.isArray(value.tasks)) return undefined
	return value as unknown as Run
}

type Wake = "kickoff" | "results" | "message" | "nudge"

export class Lanes {
	private readonly runs = new Map<string, Run>()
	private readonly watched = new Set<string>()
	private readonly planning = new Set<string>()
	private readonly writes = new Map<string, Promise<void>>()
	private readonly views = new Map<string, Promise<void>>()
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
	private readonly reported = new Set<string>()
	private readonly waiters = new Map<string, Set<(text: string) => void>>()
	private readonly log: Log

	constructor(private readonly host: Host) {
		this.log = host.log
	}

	/** Picks up this directory's unfinished runs after a restart or plugin reload. */
	async load() {
		const resumed: string[] = []
		for (const value of await this.host.storage.values("run:")) {
			const run = readRun(value)
			if (!run || run.directory !== this.host.directory || run.status !== "running" || this.runs.has(run.id)) continue
			this.runs.set(run.id, run)
			resumed.push(run.id)
			for (const task of run.tasks) {
				// Launched but never given a session: start it again.
				if (active(task) && !task.sessionID) task.status = "queued"
				else if (active(task)) void this.resume(run, task)
			}
			this.log.info("run.resumed", { run: run.id, ...counts(run) })
			this.after(run)
		}
		this.log.info("runs.resumed", { directory: this.host.directory, runs: resumed })
	}

	/** Status lines for the runs a session started that are still going. */
	lines(origin: string) {
		return this.running()
			.filter((run) => run.origin === origin)
			.map(line)
	}

	running() {
		return [...this.runs.values()].filter((run) => run.status === "running")
	}

	/** A run by ID, including finished ones kept in storage. */
	async find(id: string) {
		const run = this.runs.get(id) ?? readRun(await this.host.storage.get(key(id)))
		if (!run) throw new Error(`No lanes run "${id}".`)
		return run
	}

	/** The running run that `sessionID` plans. */
	planned(sessionID: string) {
		const run = this.running().find((run) => run.planner === sessionID)
		if (!run) throw new Error("This session does not plan a running lanes run.")
		return run
	}

	/** Waits until the run ends or needs the orchestrator, at most `ms`. */
	wait(run: Run, ms: number, signal?: AbortSignal): Promise<string> {
		if (run.status === "done") return Promise.resolve(noteDone(run))
		if (run.status === "stopped") return Promise.resolve(`Run ${run.id} was stopped. ${line(run)}`)
		return new Promise((resolve) => {
			const waiting = this.waiters.get(run.id) ?? new Set<(text: string) => void>()
			this.waiters.set(run.id, waiting)
			const span = ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`
			const finish = (text: string) => {
				clearTimeout(timer)
				signal?.removeEventListener("abort", aborted)
				waiting.delete(finish)
				if (waiting.size === 0) this.waiters.delete(run.id)
				this.log.info("wait.ended", { run: run.id, waited: span, result: cap(text.split("\n")[0] ?? "", 120) })
				resolve(text)
			}
			const timer = setTimeout(() => finish(`Still running after ${span}. ${line(run)}`), ms)
			const aborted = () => finish("Stopped waiting: the turn was interrupted.")
			signal?.addEventListener("abort", aborted, { once: true })
			waiting.add(finish)
			this.log.info("wait.started", { run: run.id, limit: span })
		})
	}

	// --- Orchestrator actions ---

	async start(origin: string, input: { goal?: unknown; lanes?: unknown; tasks?: unknown; notes?: unknown }) {
		const goal = typeof input.goal === "string" ? input.goal.trim() : ""
		if (!goal) throw new Error("Give the run a goal.")
		const now = this.host.now()
		const run: Run = {
			id: newID("r", new Set(this.runs.keys())),
			goal,
			origin,
			directory: this.host.directory,
			lanes: clampLanes(input.lanes, this.host.maxLanes),
			notes: readStrings(input.notes),
			status: "running",
			tasks: [],
			created: now,
			updated: now,
		}
		if (input.tasks !== undefined) run.tasks.push(...(await this.validate(run, input.tasks)))
		const planner = await this.host.session.create({
			parentID: origin,
			title: `Lanes ${run.id}: ${cap(goal, 60)}`,
			agent: PLANNER,
			model: await this.modelFor(run, PLANNER),
		})
		run.planner = planner.id
		this.runs.set(run.id, run)
		this.log.info("run.started", {
			run: run.id,
			origin,
			planner: planner.id,
			lanes: run.lanes,
			requestedLanes: input.lanes,
			goal: cap(goal, 300),
			tasks: ids(run.tasks),
			notes: run.notes.length,
		})
		this.pump(run)
		await this.save(run)
		void this.wakePlanner(run, kickoff(run), "kickoff")
		return run
	}

	async update(run: Run, input: { tasks?: unknown; notes?: unknown; lanes?: unknown }) {
		this.assertRunning(run)
		const added = input.tasks === undefined ? [] : await this.validate(run, input.tasks)
		run.tasks.push(...added)
		const notes = readStrings(input.notes)
		run.notes.push(...notes)
		if (input.lanes !== undefined) run.lanes = clampLanes(input.lanes, this.host.maxLanes)
		run.stalled = undefined
		this.log.info("run.updated", { run: run.id, added: ids(added), notes: notes.length, lanes: run.lanes })
		this.after(run)
		await this.save(run)
		return { added, notes: notes.length }
	}

	async tell(run: Run, text: string, taskID?: string) {
		this.assertRunning(run)
		if (!taskID) {
			run.question = undefined
			run.stalled = undefined
			await this.save(run)
			const message = `Message from the orchestrator: ${text}`
			const steer = Boolean(run.planner && this.planning.has(run.id))
			this.log.info("tell.planner", { run: run.id, planner: run.planner, steer, chars: text.length })
			if (run.planner && steer)
				await this.host.session.prompt({ sessionID: run.planner, text: message, delivery: "steer" })
			else void this.wakePlanner(run, message, "message")
			return "Sent to the planner."
		}
		const task = this.task(run, taskID)
		if (task.status === "queued") {
			task.prompt = `${task.prompt}\n\nUpdate from the orchestrator: ${text}`
			await this.save(run)
			this.log.info("tell.task", { run: run.id, task: task.id, mode: "amend" })
			return `Updated ${task.id}'s instructions before it starts.`
		}
		if (!task.sessionID) throw new Error(`${task.id} never started; add a new task instead.`)
		if (active(task)) {
			this.log.info("tell.task", { run: run.id, task: task.id, session: task.sessionID, mode: "steer" })
			await this.host.session.prompt({
				sessionID: task.sessionID,
				text: `Update from the orchestrator: ${text}`,
				delivery: "steer",
			})
			return `Sent to ${task.id}; it sees the message at its next step.`
		}
		// A finished task takes the follow-up in its own session, in a lane again.
		task.status = "running"
		task.attempts = 1
		task.started = this.host.now()
		task.ended = undefined
		task.error = undefined
		await this.save(run)
		this.log.info("tell.task", { run: run.id, task: task.id, session: task.sessionID, mode: "follow-up" })
		await this.host.session.prompt({ sessionID: task.sessionID, text: `Follow-up from the orchestrator: ${text}` })
		void this.watch(run, task)
		return `${task.id} is working on the follow-up.`
	}

	async stop(run: Run, taskID?: string) {
		this.assertRunning(run)
		if (taskID) {
			const task = this.task(run, taskID)
			if (finished(task)) return `${task.id} is already ${task.status}.`
			await this.cancel(run, task, false, "orchestrator")
			this.after(run)
			await this.save(run)
			return `Cancelled ${task.id}.`
		}
		run.status = "stopped"
		const busy = run.tasks.filter(active).length
		for (const task of run.tasks.filter((task) => !finished(task))) await this.cancel(run, task, true, "orchestrator")
		if (run.planner && this.planning.has(run.id))
			await this.host.session
				.interrupt({ sessionID: run.planner, resume: false })
				.catch((error) => this.log.error("planner.interrupt-failed", { run: run.id, planner: run.planner, error }))
		await this.save(run)
		this.log.info("run.stopped", { run: run.id, interrupted: busy, ...counts(run) })
		this.release(run, `Run ${run.id} was stopped. ${line(run)}`)
		return `Stopped run ${run.id}: ${busy} lanes interrupted.`
	}

	// --- Planner actions ---

	async plan(run: Run, tasks: unknown) {
		const added = await this.validate(run, tasks)
		run.tasks.push(...added)
		run.stalled = undefined
		this.log.info("plan.added", {
			run: run.id,
			tasks: added.map((task) => ({ id: task.id, agent: task.agent, deps: task.deps, files: task.files })),
		})
		this.pump(run)
		await this.save(run)
		return added
	}

	async drop(run: Run, value: unknown, why?: string) {
		const tasks = readStrings(value).map((id) => this.task(run, id))
		for (const task of tasks.filter((task) => !finished(task))) {
			await this.cancel(run, task, true, "planner")
			if (why) task.error = cap(why, 300)
		}
		this.log.info("plan.cancelled", { run: run.id, tasks: ids(tasks), reason: why })
		this.pump(run)
		await this.save(run)
		return tasks
	}

	async finish(run: Run, summary: string) {
		const busy = run.tasks.filter(active)
		if (busy.length) {
			this.log.warn("plan.finish-rejected", { run: run.id, busy: ids(busy) })
			throw new Error(`${ids(busy).join(", ")} still running; wait for their results.`)
		}
		for (const task of run.tasks.filter((task) => task.status === "queued")) {
			task.status = "cancelled"
			task.ended = this.host.now()
			task.seen = true
		}
		run.status = "done"
		run.summary = cap(summary.trim() || "Finished.", 2000)
		await this.save(run)
		this.log.info("run.done", { run: run.id, ...counts(run), summaryChars: run.summary.length })
		await this.note(run, noteDone(run), "done")
	}

	async ask(run: Run, question: string) {
		run.question = cap(question.trim(), 1000)
		await this.save(run)
		this.log.info("run.question", { run: run.id, question: cap(run.question, 300) })
		await this.note(run, noteQuestion(run), "question")
	}

	// --- Permission events ---

	asked(request: Permission) {
		const found = this.owner(request.sessionID)
		if (!found || this.reported.has(request.id)) return
		this.reported.add(request.id)
		const what = cap(`${request.action} ${request.resources.join(" ")}`.trim(), 200)
		if (found.task && active(found.task)) {
			found.task.status = "blocked"
			found.task.blocked = what
			void this.save(found.run)
		}
		this.log.warn("task.blocked", {
			run: found.run.id,
			task: found.task?.id ?? PLANNER,
			session: request.sessionID,
			request: request.id,
			permission: what,
		})
		void this.note(found.run, noteBlocked(found.run, found.task, what, request.sessionID), "blocked")
	}

	replied(sessionID: string) {
		const found = this.owner(sessionID)
		if (found?.task?.status !== "blocked") return
		found.task.status = "running"
		found.task.blocked = undefined
		this.log.info("task.unblocked", { run: found.run.id, task: found.task.id, session: sessionID })
		void this.save(found.run)
	}

	// --- Internals ---

	private owner(sessionID: string): { run: Run; task?: Task } | undefined {
		for (const run of this.running()) {
			if (run.planner === sessionID) return { run }
			const task = run.tasks.find((task) => task.sessionID === sessionID)
			if (task) return { run, task }
		}
		return undefined
	}

	private assertRunning(run: Run) {
		if (run.status !== "running") throw new Error(`Run ${run.id} is ${run.status}.`)
	}

	private task(run: Run, id: string) {
		const task = run.tasks.find((task) => task.id === id)
		if (!task) throw new Error(`Run ${run.id} has no task "${id}".`)
		return task
	}

	private async validate(run: Run, value: unknown) {
		const agents = (await this.host.agents()).filter((agent) => agent.mode !== "primary" && agent.id !== PLANNER)
		const { tasks, errors } = readTasks(value, run, new Set(agents.map((agent) => agent.id)))
		if (errors.length) {
			this.log.warn("tasks.rejected", { run: run.id, errors })
			throw new Error(errors.join("\n"))
		}
		return tasks
	}

	private async crewModels(origin: string) {
		const seen = new Set<string>()
		let session = await this.host.session.get({ sessionID: origin })
		while (session.parentID && !seen.has(session.id)) {
			seen.add(session.id)
			session = await this.host.session.get({ sessionID: session.parentID })
		}
		const crew = session.metadata?.crew
		const models = isRecord(crew) && isRecord(crew.models) ? crew.models : {}
		return new Map(Object.entries(models).filter((entry): entry is [string, string] => isModelRef(entry[1])))
	}

	/** An explicit model wins, then the session's /crew choice, the agent's own, and the orchestrator's. */
	private async modelFor(run: Run, agent: string, explicit?: string) {
		const crew = explicit ? undefined : (await this.crewModels(run.origin)).get(agent)
		const chosen = explicit ?? crew
		const own = chosen ? undefined : (await this.host.agents()).find((info) => info.id === agent)?.model
		const model = chosen ? parseModel(chosen) : (own ?? (await this.host.session.get({ sessionID: run.origin })).model)
		const source = explicit ? "task" : crew ? "crew" : own ? "agent" : "orchestrator"
		this.log.debug("model.resolved", { run: run.id, agent, model: model && formatModel(model), source })
		return model
	}

	private plannerState(run: Run): PlannerState {
		if (this.planning.has(run.id)) return "thinking"
		if (run.question) return "asking"
		if (run.stalled) return "paused"
		return "idle"
	}

	private save(run: Run) {
		run.updated = this.host.now()
		this.publish(run)
		const snapshot: unknown = JSON.parse(JSON.stringify(run))
		const next = (this.writes.get(run.id) ?? Promise.resolve())
			.then(() => this.host.storage.set(key(run.id), snapshot))
			.catch((error) => this.log.error("storage.save-failed", { run: run.id, error }))
		this.writes.set(run.id, next)
		return next
	}

	/** Schedules a write of the run's summary to its planner session, which the terminal's Lanes tab reads. */
	private publish(run: Run) {
		if (!run.planner || this.timers.has(run.id)) return
		const timer = setTimeout(() => {
			this.timers.delete(run.id)
			const next = (this.views.get(run.id) ?? Promise.resolve()).then(() => this.writeView(run))
			this.views.set(run.id, next)
		}, this.host.publishDelayMs)
		this.timers.set(run.id, timer)
	}

	private async writeView(run: Run) {
		const sessionID = run.planner
		if (!sessionID) return
		try {
			const info = await this.host.session.get({ sessionID })
			const view = toView(run, this.plannerState(run))
			await this.host.session.update({ sessionID, metadata: { ...info.metadata, [VIEW_KEY]: view } })
			this.log.debug("view.published", { run: run.id, planner: sessionID, status: view.status, state: view.planner })
		} catch (error) {
			this.log.warn("view.publish-failed", { run: run.id, planner: sessionID, error })
		}
	}

	private pump(run: Run) {
		if (run.status !== "running") return
		const tasks = startable(run)
		for (const task of tasks) {
			task.status = "running"
			task.started = this.host.now()
			task.attempts = 1
			void this.launch(run, task)
		}
		if (tasks.length)
			this.log.debug("lanes.filled", {
				run: run.id,
				started: ids(tasks),
				busy: run.tasks.filter(active).length,
				lanes: run.lanes,
			})
	}

	private async launch(run: Run, task: Task) {
		try {
			const model = await this.modelFor(run, task.agent, task.model)
			this.log.info("task.launching", {
				run: run.id,
				task: task.id,
				agent: task.agent,
				model: model && formatModel(model),
			})
			const session = await this.host.session.create({
				parentID: run.planner ?? run.origin,
				title: `${task.id} · ${cap(task.title, 50)}`,
				agent: task.agent,
				model,
			})
			task.sessionID = session.id
			await this.save(run)
			this.log.info("task.session", { run: run.id, task: task.id, session: session.id })
			if (!active(task)) return
			await this.host.session.prompt({ sessionID: session.id, text: workerPrompt(run, task) })
			this.log.debug("task.prompted", { run: run.id, task: task.id, session: session.id })
		} catch (error) {
			this.log.error("task.launch-failed", { run: run.id, task: task.id, error })
			await this.fail(run, task, `could not start: ${reason(error)}`)
			return
		}
		await this.watch(run, task)
	}

	/** After a restart: workers OpenCode stopped mid-task are told to continue; still-running ones are just watched again. */
	private async resume(run: Run, task: Task) {
		const sessionID = task.sessionID
		if (!sessionID) return
		try {
			const idle = await Promise.race([
				this.host.session.wait({ sessionID }).then(() => true),
				delay(this.host.settleMs).then(() => false),
			])
			if (idle && (await this.host.session.context({ sessionID })).at(-1)?.type !== "idle") {
				this.log.info("task.resumed", { run: run.id, task: task.id, session: sessionID })
				await this.host.session.prompt({ sessionID, text: RESUME })
			}
		} catch (error) {
			this.log.error("task.resume-failed", { run: run.id, task: task.id, session: sessionID, error })
		}
		await this.watch(run, task)
	}

	private async watch(run: Run, task: Task) {
		const sessionID = task.sessionID
		if (!sessionID || this.watched.has(sessionID)) return
		this.watched.add(sessionID)
		let ending: "succeeded" | "failed" | "interrupted" | undefined
		let failure: string | undefined
		let rechecked = false
		try {
			for (;;) {
				await this.host.session.wait({ sessionID })
				if (!active(task) || run.status !== "running") {
					this.log.debug("task.watch-ended", { run: run.id, task: task.id, status: task.status, runStatus: run.status })
					return
				}
				const messages = await this.host.session.context({ sessionID })
				const last = messages.at(-1)
				if (last?.type !== "idle") {
					// No ending recorded yet: check once more, then treat it as a shutdown, which load() resumes.
					if (!rechecked) {
						rechecked = true
						await delay(this.host.settleMs)
						continue
					}
					this.log.warn("task.stopped", { run: run.id, task: task.id, session: sessionID })
					return
				}
				rechecked = false
				this.log.info("task.idle", { run: run.id, task: task.id, session: sessionID, outcome: last.outcome })
				if (last.outcome === "succeeded") {
					const report = finalText(messages)
					task.report = report === undefined ? undefined : cap(report, REPORT_LIMIT)
					ending = "succeeded"
					break
				}
				if (last.outcome === "interrupted") {
					ending = "interrupted"
					break
				}
				const error = finalError(messages) ?? "the session failed"
				if (task.attempts > RETRIES) {
					ending = "failed"
					failure = error
					break
				}
				task.attempts++
				this.log.warn("task.retry", { run: run.id, task: task.id, session: sessionID, attempt: task.attempts, error })
				await this.host.session.prompt({
					sessionID,
					text: `The previous attempt ended with an error (${error}). Continue the task from where it stopped.`,
				})
			}
		} catch (error) {
			this.log.error("task.lost", { run: run.id, task: task.id, session: sessionID, error })
			return
		} finally {
			this.watched.delete(sessionID)
		}
		if (ending === "failed") return this.fail(run, task, failure ?? "the session failed")
		task.ended = this.host.now()
		task.seen = false
		task.blocked = undefined
		if (ending === "interrupted") {
			task.status = "cancelled"
			task.error = "interrupted by the user"
			this.log.info("task.interrupted", { run: run.id, task: task.id, session: sessionID })
		} else {
			task.status = "done"
			task.error = undefined
			this.log.info("task.done", {
				run: run.id,
				task: task.id,
				session: sessionID,
				ms: task.started === undefined ? undefined : task.ended - task.started,
				reportChars: task.report?.length ?? 0,
			})
		}
		await this.save(run)
		this.after(run)
	}

	private async fail(run: Run, task: Task, error: string) {
		task.status = "failed"
		task.error = cap(error, 500)
		task.ended = this.host.now()
		task.seen = false
		task.blocked = undefined
		this.log.error("task.failed", { run: run.id, task: task.id, session: task.sessionID, error: task.error })
		await this.save(run)
		await this.note(run, noteFailed(run, task), "failed")
		this.after(run)
	}

	private async cancel(run: Run, task: Task, seen: boolean, by: "orchestrator" | "planner") {
		const sessionID = active(task) ? task.sessionID : undefined
		task.status = "cancelled"
		task.ended = this.host.now()
		task.seen = seen
		this.log.info("task.cancelled", { run: run.id, task: task.id, session: sessionID, by })
		if (sessionID)
			await this.host.session
				.interrupt({ sessionID, resume: false })
				.catch((error) =>
					this.log.error("task.interrupt-failed", { run: run.id, task: task.id, session: sessionID, error }),
				)
	}

	/** Refills lanes, then wakes the planner once nothing queued can still run and there is news or idleness. */
	private after(run: Run) {
		if (run.status !== "running") return
		this.pump(run)
		void this.save(run)
		if (this.planning.has(run.id) || run.question || run.stalled) return
		const blocked = new Set(ids(stuck(run)))
		if (run.tasks.some((task) => task.status === "queued" && !blocked.has(task.id))) return
		const fresh = run.tasks.some((task) => finished(task) && !task.seen)
		if (fresh || !run.tasks.some(active)) void this.wakePlanner(run, wake(run), "results")
	}

	private async wakePlanner(run: Run, text: string, why: Wake): Promise<void> {
		const planner = run.planner
		if (!planner || run.status !== "running" || this.planning.has(run.id)) return
		this.planning.add(run.id)
		const fresh = run.tasks.filter((task) => finished(task) && !task.seen)
		for (const task of run.tasks.filter(finished)) task.seen = true
		await this.save(run)
		const started = this.host.now()
		this.log.info("planner.wake", { run: run.id, planner, reason: why, fresh: ids(fresh), ...counts(run) })
		let ending: string | undefined
		try {
			await this.host.session.prompt({ sessionID: planner, text })
			await this.host.session.wait({ sessionID: planner })
			const last = (await this.host.session.context({ sessionID: planner })).at(-1)
			ending = last?.type === "idle" ? last.outcome : undefined
			this.log.info("planner.idle", { run: run.id, planner, ms: this.host.now() - started, outcome: ending })
		} catch (error) {
			this.log.error("planner.failed", { run: run.id, planner, error })
		} finally {
			this.planning.delete(run.id)
			this.publish(run)
		}
		if (run.status !== "running" || run.question) return
		if (ending === "interrupted") {
			// Stopped by someone: lanes keep running, but nothing new is planned until the orchestrator writes.
			run.stalled = true
			await this.save(run)
			this.log.warn("planner.paused", { run: run.id, planner, ...counts(run) })
			await this.note(run, notePaused(run), "paused")
			return
		}
		const blocked = new Set(ids(stuck(run)))
		const progressing = run.tasks.some((task) => active(task) || (task.status === "queued" && !blocked.has(task.id)))
		if (progressing || run.tasks.some((task) => finished(task) && !task.seen)) return this.after(run)
		// Idle with nothing left to run and no summary: nudge once, then report a stall.
		if (why !== "nudge") {
			this.log.warn("planner.nudged", { run: run.id, planner })
			return this.wakePlanner(run, NUDGE, "nudge")
		}
		run.stalled = true
		await this.save(run)
		this.log.warn("run.stalled", { run: run.id, planner, ...counts(run) })
		await this.note(run, noteStalled(run), "stalled")
	}

	/** Hands `text` to every lanes_wait call on the run; returns whether there was one. */
	private release(run: Run, text: string) {
		const waiting = this.waiters.get(run.id)
		if (!waiting?.size) return false
		for (const finish of [...waiting]) finish(text)
		return true
	}

	private async note(run: Run, text: string, kind: string) {
		if (RELEASES.has(kind) && this.release(run, text)) {
			this.log.info("note.handed", { run: run.id, origin: run.origin, kind })
			return
		}
		try {
			await this.host.session.synthetic({
				sessionID: run.origin,
				text,
				description: "lanes",
				resume: false,
				metadata: { source: "lanes", run: run.id },
			})
			this.log.info("note.sent", { run: run.id, origin: run.origin, kind })
		} catch (error) {
			this.log.error("note.failed", { run: run.id, origin: run.origin, kind, error })
		}
	}
}
