// Lane runs: a goal split into tasks that worker sessions execute in parallel
// lanes, refilled as tasks finish, with a planner session re-planning between
// batches. This module holds the pure parts: the data model, task parsing,
// the scheduling choice, and the text shown to models.

export type TaskStatus = "queued" | "running" | "blocked" | "done" | "failed" | "cancelled"
export type RunStatus = "running" | "done" | "stopped"

export interface Task {
	id: string
	title: string
	prompt: string
	agent: string
	model?: string
	deps: string[]
	files: string[]
	status: TaskStatus
	sessionID?: string
	attempts: number
	report?: string
	error?: string
	blocked?: string
	started?: number
	ended?: number
	// Already shown to the planner in a wake-up.
	seen?: boolean
}

export interface Run {
	id: string
	goal: string
	origin: string
	directory: string
	planner?: string
	lanes: number
	notes: string[]
	status: RunStatus
	tasks: Task[]
	question?: string
	summary?: string
	// The planner went quiet after a nudge; it is only woken again by the orchestrator.
	stalled?: boolean
	created: number
	updated: number
}

export interface ModelRef {
	providerID: string
	id: string
	variant?: string
}

export interface Message {
	type: string
	content?: readonly { type: string; text?: string }[]
	error?: { message?: string } | string
	// Set on the `idle` record OpenCode appends when an execution ends; a shutdown appends none.
	outcome?: string
}

export const DEFAULT_AGENT = "dev-junior"
export const PLANNER = "planner"
export const REPORT_LIMIT = 6000

const MODEL_REF = /^[^/#\s]+\/[^#\s]+(#[^#\s]+)?$/
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

export const active = (task: Task) => task.status === "running" || task.status === "blocked"
export const finished = (task: Task) =>
	task.status === "done" || task.status === "failed" || task.status === "cancelled"

export function isModelRef(value: unknown): value is string {
	return typeof value === "string" && MODEL_REF.test(value)
}

export function parseModel(ref: string): ModelRef | undefined {
	if (!isModelRef(ref)) return undefined
	const [path, variant] = ref.split("#")
	const slash = path.indexOf("/")
	return { providerID: path.slice(0, slash), id: path.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export function formatModel(ref: ModelRef) {
	return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`
}

export function clampLanes(value: unknown, max: number) {
	const lanes = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : max
	return Math.min(Math.max(lanes, 1), max)
}

export function newID(prefix: string, taken: ReadonlySet<string> = new Set()) {
	for (;;) {
		const id = `${prefix}${Math.random().toString(36).slice(2, 6)}`
		if (!taken.has(id)) return id
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const readStrings = (value: unknown) =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : []

/** Validates new tasks against the run; IDs are generated when omitted. */
export function readTasks(value: unknown, run: Run, agents: ReadonlySet<string>) {
	const tasks: Task[] = []
	const errors: string[] = []
	if (!Array.isArray(value) || value.length === 0) return { tasks, errors: ["Give at least one task."] }
	const ids = new Set(run.tasks.map((task) => task.id))
	let next = run.tasks.length + 1
	for (const [index, item] of value.entries()) {
		const where = `task ${index + 1}`
		if (!isRecord(item)) {
			errors.push(`${where}: not an object.`)
			continue
		}
		const title = typeof item.title === "string" ? item.title.trim() : ""
		const prompt = typeof item.prompt === "string" ? item.prompt.trim() : ""
		if (!title || !prompt) errors.push(`${where}: title and prompt are required.`)
		let id = typeof item.id === "string" ? item.id.trim() : ""
		if (id && !TASK_ID.test(id)) errors.push(`${where}: id "${id}" must be lowercase letters, digits, and dashes.`)
		if (id && ids.has(id)) errors.push(`${where}: id "${id}" is already used.`)
		if (!id) {
			while (ids.has(`t${next}`)) next++
			id = `t${next}`
		}
		ids.add(id)
		const agent = typeof item.agent === "string" && item.agent ? item.agent : DEFAULT_AGENT
		if (!agents.has(agent)) errors.push(`${where}: unknown agent "${agent}".`)
		const model = typeof item.model === "string" && item.model ? item.model : undefined
		if (model !== undefined && !isModelRef(model)) errors.push(`${where}: model must look like provider/model#variant.`)
		tasks.push({
			id,
			title,
			prompt,
			agent,
			...(model ? { model } : {}),
			deps: readStrings(item.deps),
			files: readStrings(item.files),
			status: "queued",
			attempts: 0,
		})
	}
	for (const task of tasks) {
		for (const dep of task.deps) {
			if (!ids.has(dep)) errors.push(`${task.id}: unknown dependency "${dep}".`)
		}
	}
	return { tasks, errors }
}

function normalize(path: string) {
	return path.replace(/^\.\//, "").replace(/\/+$/, "")
}

/** Whether two file scopes touch the same file; a path also covers everything below it. */
export function overlaps(a: readonly string[], b: readonly string[]) {
	return a.some((left) =>
		b.some((right) => {
			const [x, y] = [normalize(left), normalize(right)]
			return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
		}),
	)
}

/** Queued tasks to launch now: dependencies done, files clear of other lanes, within the free lanes. */
export function startable(run: Run) {
	const byID = new Map(run.tasks.map((task) => [task.id, task]))
	const busy = run.tasks.filter(active)
	const picked: Task[] = []
	for (const task of run.tasks) {
		if (busy.length + picked.length >= run.lanes) break
		if (task.status !== "queued") continue
		if (!task.deps.every((dep) => byID.get(dep)?.status === "done")) continue
		if ([...busy, ...picked].some((other) => overlaps(task.files, other.files))) continue
		picked.push(task)
	}
	return picked
}

/** Queued tasks that can never start because a dependency failed or was cancelled. */
export function stuck(run: Run) {
	const byID = new Map(run.tasks.map((task) => [task.id, task]))
	return run.tasks.filter(
		(task) =>
			task.status === "queued" &&
			task.deps.some((dep) => {
				const status = byID.get(dep)?.status
				return status === "failed" || status === "cancelled"
			}),
	)
}

export function counts(run: Run) {
	const count = (status: TaskStatus) => run.tasks.filter((task) => task.status === status).length
	return {
		total: run.tasks.length,
		done: count("done"),
		running: count("running"),
		blocked: count("blocked"),
		queued: count("queued"),
		failed: count("failed"),
		cancelled: count("cancelled"),
	}
}

export function cap(text: string, limit: number) {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** First non-empty line of a report, for compact listings. */
export function gist(text: string | undefined, limit = 120) {
	const line = text?.split("\n").find((part) => part.trim() !== "") ?? ""
	return cap(line.replace(/^[#*\-\s]+/, "").trim(), limit)
}

/** The last error-free answer of a session: its text parts joined. */
export function finalText(messages: readonly Message[]) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.type !== "assistant" || message.error) continue
		const text = (message.content ?? [])
			.filter((part) => part.type === "text" && part.text)
			.map((part) => part.text)
			.join("\n\n")
			.trim()
		if (text) return text
	}
	return undefined
}

/** The error of the last assistant message, if it failed. */
export function finalError(messages: readonly Message[]) {
	const last = messages.findLast((message) => message.type === "assistant")
	if (!last?.error) return undefined
	return typeof last.error === "string" ? last.error : last.error.message
}

/** One line per run for the orchestrator's context. */
export function line(run: Run) {
	const c = counts(run)
	const parts = [`${c.done}/${c.total} done`]
	if (c.running) parts.push(`${c.running} running`)
	if (c.blocked) parts.push(`${c.blocked} blocked`)
	if (c.queued) parts.push(`${c.queued} queued`)
	if (c.failed) parts.push(`${c.failed} failed`)
	const question = run.question ? ` Planner asks: ${cap(run.question, 160)} (answer with lanes_tell).` : ""
	return `Lanes run ${run.id} (${cap(run.goal, 60)}): ${parts.join(" · ")}.${question}`
}

const minutes = (from: number | undefined, to: number) =>
	from === undefined ? "" : `${Math.max(0, Math.round((to - from) / 60000))}m`

/** The compact board `lanes_status` returns. */
export function board(run: Run, now: number) {
	const c = counts(run)
	const ids = (status: TaskStatus) =>
		run.tasks
			.filter((task) => task.status === status)
			.map((task) => task.id)
			.join(", ")
	const lines = [
		`Run ${run.id} · ${run.status} · ${run.lanes} lanes · ${c.total} tasks: ${c.done} done, ${c.running} running, ${c.blocked} blocked, ${c.queued} queued, ${c.failed} failed`,
		`Goal: ${cap(run.goal, 200)}`,
	]
	const running = run.tasks.filter((task) => task.status === "running")
	if (running.length)
		lines.push(
			`Running: ${running.map((task) => `${task.id} ${cap(task.title, 40)} (${task.agent}, ${minutes(task.started, now)})`).join(" · ")}`,
		)
	for (const task of run.tasks.filter((task) => task.status === "blocked"))
		lines.push(
			`Blocked: ${task.id} ${cap(task.title, 40)} waits for ${task.blocked ?? "approval"} (session ${task.sessionID})`,
		)
	for (const task of run.tasks.filter((task) => task.status === "failed"))
		lines.push(`Failed: ${task.id} ${cap(task.title, 40)}: ${cap(task.error ?? "unknown error", 120)}`)
	const done = run.tasks.filter((task) => task.status === "done")
	if (done.length) lines.push(`Done: ${done.map((task) => `${task.id} ${cap(task.title, 40)}`).join(" · ")}`)
	if (c.queued) lines.push(`Queued: ${ids("queued")}`)
	if (run.question) lines.push(`Planner asks: ${run.question}`)
	if (run.summary) lines.push(`Summary: ${run.summary}`)
	lines.push("Use lanes_status with a task ID for its report.")
	return lines.join("\n")
}

/** What `lanes_status` returns for one task. */
export function taskReport(run: Run, task: Task) {
	const head = `Task ${task.id} of run ${run.id} · ${task.status} · ${task.agent}${task.model ? ` (${task.model})` : ""}${task.sessionID ? ` · session ${task.sessionID}` : ""}`
	const body =
		task.status === "done"
			? (task.report ?? "(no report)")
			: task.status === "failed"
				? `Error: ${task.error ?? "unknown"}${task.report ? `\n\n${task.report}` : ""}`
				: task.status === "blocked"
					? `Waiting for ${task.blocked ?? "approval"}.`
					: `Title: ${task.title}`
	return `${head}\n\n${body}`
}

/** The prompt a worker session starts with. */
export function workerPrompt(run: Run, task: Task) {
	const sections = [`Lane task ${task.id} of run ${run.id}: ${task.title}`, task.prompt]
	if (task.files.length)
		sections.push(
			`Files in scope: ${task.files.join(", ")}. Other lanes edit other files in the same working tree at the same time; only touch files outside this scope when the task requires it, and say so in your report.`,
		)
	if (run.notes.length) sections.push(`Shared notes:\n${run.notes.map((note) => `- ${note}`).join("\n")}`)
	sections.push(
		`Context only, do not act on it: this task is one part of a run that a separate planner splits and finishes, so leave everything outside the task to the planner. The run's goal: ${run.goal}`,
	)
	return sections.join("\n\n")
}

export const RESUME =
	"OpenCode restarted while you were working on this task. Continue where you stopped, then report as instructed."

const describeTask = (task: Task) =>
	`- ${task.id} [${task.status}] ${task.title} (${task.agent}${task.deps.length ? `, after ${task.deps.join(", ")}` : ""}${task.files.length ? `, files ${task.files.join(", ")}` : ""})`

/** The planner's first message. */
export function kickoff(run: Run) {
	const sections = [`Run ${run.id}: plan this goal for up to ${run.lanes} parallel lanes.`, `Goal: ${run.goal}`]
	if (run.notes.length)
		sections.push(`Notes from the orchestrator:\n${run.notes.map((note) => `- ${note}`).join("\n")}`)
	if (run.tasks.length)
		sections.push(
			`The orchestrator already queued these tasks; they start right away:\n${run.tasks.map(describeTask).join("\n")}`,
			"Add only what is missing with plan_add, or end your turn and wait for their results.",
		)
	else sections.push("Add tasks with plan_add; lanes start as soon as tasks arrive.")
	return sections.join("\n\n")
}

export const NUDGE =
	"Nothing is running or queued. Add tasks with plan_add, call plan_finish if the goal is met, or plan_ask if you need a decision."

/** The planner's wake-up after a batch: new results, stuck tasks, and what to do next. */
export function wake(run: Run) {
	const fresh = run.tasks.filter((task) => finished(task) && !task.seen)
	const sections = [`Run ${run.id}: ${line(run).replace(/^Lanes run \S+ /, "")}`]
	if (fresh.length)
		sections.push(
			`New results:\n${fresh
				.map(
					(task) =>
						`- ${task.id} ${task.title} [${task.status}]: ${
							task.status === "done" ? cap(task.report ?? "(no report)", 1500) : cap(task.error ?? "", 400)
						}`,
				)
				.join("\n")}`,
		)
	const blocked = stuck(run)
	if (blocked.length)
		sections.push(`Stuck behind a failed or cancelled dependency: ${blocked.map((task) => task.id).join(", ")}.`)
	sections.push(
		"Check the results against the goal. Add follow-up or fix tasks with plan_add, cancel obsolete or stuck ones with plan_cancel, or call plan_finish when the goal is met.",
	)
	return sections.join("\n\n")
}

const tag = (run: Run, state: string, task?: Task) =>
	`<lanes run="${run.id}"${task ? ` task="${task.id}"` : ""} state="${state}">`

export function noteDone(run: Run) {
	const c = counts(run)
	return `${tag(run, "done")}\n${run.summary ?? "Finished."}\n${c.done}/${c.total} tasks done${c.failed ? `, ${c.failed} failed` : ""}. Details: lanes_status({ run: "${run.id}" }).\n</lanes>`
}

export function noteFailed(run: Run, task: Task) {
	return `${tag(run, "failed", task)}\n${task.id} "${cap(task.title, 60)}" failed: ${cap(task.error ?? "unknown error", 200)}. The planner is re-planning.\n</lanes>`
}

export function noteBlocked(run: Run, task: Task | undefined, what: string, sessionID: string) {
	const who = task ? `${task.id} "${cap(task.title, 60)}"` : "The planner"
	return `${tag(run, "blocked", task)}\n${who} waits for approval: ${cap(what, 200)}. Open session ${sessionID} to answer.\n</lanes>`
}

export function noteQuestion(run: Run) {
	return `${tag(run, "question")}\nThe planner asks: ${run.question}\nAnswer with lanes_tell({ run: "${run.id}", text }).\n</lanes>`
}

export function noteStalled(run: Run) {
	return `${tag(run, "stalled")}\nThe planner stopped without new tasks or a summary; ${line(run)} Steer it with lanes_tell or stop the run with lanes_stop.\n</lanes>`
}

export function notePaused(run: Run) {
	return `${tag(run, "paused")}\nThe planner was interrupted, so nothing new is planned; running lanes continue. ${line(run)} Resume it with lanes_tell or stop the run with lanes_stop.\n</lanes>`
}
