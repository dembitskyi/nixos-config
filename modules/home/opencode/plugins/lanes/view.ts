// The run summary the lanes plugin keeps on each planner session (metadata
// key `lanes`), and the rows of the composer's Lanes tab built from it. The
// server writes summaries; the terminal plugin only reads them.
import { cap, isRecord, type Run, type RunStatus, type TaskStatus } from "./state"

export const VIEW_KEY = "lanes"

export type PlannerState = "thinking" | "idle" | "asking" | "paused"

export interface ViewTask {
	id: string
	title: string
	agent: string
	status: TaskStatus
	session?: string
}

export interface View {
	v: 1
	run: string
	goal: string
	status: RunStatus
	planner: PlannerState
	lanes: number
	created: number
	tasks: ViewTask[]
}

export interface Row {
	key: string
	// Absent for tasks that have not started.
	sessionID?: string
	prefix: string
	label: string
	status: string
	// The session is working, so the row can be interrupted.
	running: boolean
	current: boolean
}

export function toView(run: Run, planner: PlannerState): View {
	return {
		v: 1,
		run: run.id,
		goal: cap(run.goal, 120),
		status: run.status,
		planner,
		lanes: run.lanes,
		created: run.created,
		tasks: run.tasks.map((task) => ({
			id: task.id,
			title: cap(task.title, 80),
			agent: task.agent,
			status: task.status,
			...(task.sessionID ? { session: task.sessionID } : {}),
		})),
	}
}

export function readView(value: unknown): View | undefined {
	if (!isRecord(value) || value.v !== 1 || typeof value.run !== "string" || !Array.isArray(value.tasks))
		return undefined
	return value as unknown as View
}

const TASK_STATUS: Record<TaskStatus, string> = {
	queued: "Queued",
	running: "Running",
	blocked: "Blocked",
	done: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
}

const titlecase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

export function runStatus(view: View) {
	if (view.status === "done") return "Done"
	if (view.status === "stopped") return "Stopped"
	if (view.planner === "thinking") return "Planning"
	if (view.planner === "asking") return "Asks you"
	if (view.planner === "paused") return "Paused"
	const done = view.tasks.filter((task) => task.status === "done").length
	return `${done}/${view.tasks.length} done`
}

/** One row per run (its planner) followed by its tasks, newest run first; `active` keeps running runs, else finished ones. */
export function rows(entries: readonly { planner: string; view: View }[], active: boolean, current?: string): Row[] {
	return entries
		.filter(({ view }) => (view.status === "running") === active)
		.toSorted((a, b) => b.view.created - a.view.created)
		.flatMap(({ planner, view }) => [
			{
				key: planner,
				sessionID: planner,
				prefix: "",
				label: `Lanes ${view.run}: ${view.goal}`,
				status: runStatus(view),
				running: view.status === "running" && view.planner === "thinking",
				current: planner === current,
			},
			...view.tasks.map((task, index) => ({
				key: `${planner}:${task.id}`,
				...(task.session ? { sessionID: task.session } : {}),
				prefix: index === view.tasks.length - 1 ? "└─ " : "├─ ",
				label: `${titlecase(task.agent)}: ${task.id} · ${task.title}`,
				status: TASK_STATUS[task.status],
				running: task.status === "running" || task.status === "blocked",
				current: task.session !== undefined && task.session === current,
			})),
		])
}
