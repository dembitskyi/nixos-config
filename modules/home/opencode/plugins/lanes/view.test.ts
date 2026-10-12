import { describe, expect, test } from "bun:test"

import type { Run, TaskStatus } from "./state"
import { readView, rows, runStatus, toView, type View } from "./view"

const run: Run = {
	id: "r1",
	goal: "Ship the feature",
	origin: "origin",
	directory: "/repo",
	planner: "p1",
	lanes: 2,
	notes: [],
	status: "running",
	tasks: [
		{
			id: "a",
			title: "Alpha",
			prompt: "x",
			agent: "dev-junior",
			deps: [],
			files: [],
			status: "done",
			attempts: 1,
			sessionID: "w1",
		},
		{
			id: "b",
			title: "Beta",
			prompt: "x",
			agent: "dev-senior",
			deps: [],
			files: [],
			status: "running",
			attempts: 1,
			sessionID: "w2",
		},
		{
			id: "c",
			title: "Gamma",
			prompt: "x",
			agent: "dev-junior",
			deps: ["a"],
			files: [],
			status: "queued",
			attempts: 0,
		},
	],
	created: 10,
	updated: 10,
}

const view = (overrides: Partial<View> = {}): View => ({ ...toView(run, "idle"), ...overrides })

test("toView keeps what the tab shows and drops prompts and reports", () => {
	expect(toView(run, "thinking")).toEqual({
		v: 1,
		run: "r1",
		goal: "Ship the feature",
		status: "running",
		planner: "thinking",
		lanes: 2,
		created: 10,
		tasks: [
			{ id: "a", title: "Alpha", agent: "dev-junior", status: "done", session: "w1" },
			{ id: "b", title: "Beta", agent: "dev-senior", status: "running", session: "w2" },
			{ id: "c", title: "Gamma", agent: "dev-junior", status: "queued" },
		],
	})
})

test("readView accepts summaries and rejects anything else", () => {
	expect(readView(view())).toEqual(view())
	expect(readView(undefined)).toBeUndefined()
	expect(readView({ v: 2, run: "r1", tasks: [] })).toBeUndefined()
	expect(readView({ v: 1, run: "r1" })).toBeUndefined()
})

test("runStatus prefers the run's end, then the planner, then progress", () => {
	expect(runStatus(view())).toBe("1/3 done")
	expect(runStatus(view({ planner: "thinking" }))).toBe("Planning")
	expect(runStatus(view({ planner: "asking" }))).toBe("Asks you")
	expect(runStatus(view({ planner: "paused" }))).toBe("Paused")
	expect(runStatus(view({ status: "done", planner: "thinking" }))).toBe("Done")
	expect(runStatus(view({ status: "stopped" }))).toBe("Stopped")
})

describe("rows", () => {
	test("active lists each running run's planner, then its unfinished tasks as a tree", () => {
		expect(rows([{ planner: "p1", view: view({ planner: "thinking" }) }], true, "w2")).toEqual([
			{
				key: "p1",
				sessionID: "p1",
				prefix: "",
				label: "Lanes r1: Ship the feature",
				status: "Planning",
				running: true,
				current: false,
			},
			{
				key: "p1:b",
				sessionID: "w2",
				prefix: "├─ ",
				label: "Dev-senior: b · Beta",
				status: "Running",
				running: true,
				current: true,
			},
			{ key: "p1:c", prefix: "└─ ", label: "Dev-junior: c · Gamma", status: "Queued", running: false, current: false },
		])
	})

	test("finished lists a running run's finished tasks under its planner", () => {
		expect(rows([{ planner: "p1", view: view() }], false, "w1")).toEqual([
			{
				key: "p1",
				sessionID: "p1",
				prefix: "",
				label: "Lanes r1: Ship the feature",
				status: "1/3 done",
				running: false,
				current: false,
			},
			{
				key: "p1:a",
				sessionID: "w1",
				prefix: "└─ ",
				label: "Dev-junior: a · Alpha",
				status: "Done",
				running: false,
				current: true,
			},
		])
	})

	test("active keeps queued, running and blocked tasks; finished keeps done, failed and cancelled ones; newest first", () => {
		const task = (id: string, status: TaskStatus) => ({ id, title: id, agent: "dev-junior", status })
		const entries = [
			{ planner: "p1", view: view({ run: "r1", created: 1 }) },
			{ planner: "p2", view: view({ run: "r2", created: 2, tasks: [task("d", "blocked")] }) },
			{
				planner: "p3",
				view: view({
					run: "r3",
					created: 3,
					status: "stopped",
					tasks: [task("e", "done"), task("f", "failed"), task("g", "cancelled")],
				}),
			},
			{ planner: "p4", view: view({ run: "r4", created: 4, tasks: [] }) },
			{ planner: "p5", view: view({ run: "r5", created: 5, status: "done", tasks: [] }) },
		]
		const keys = (active: boolean) => rows(entries, active).map((row) => row.key)
		expect(keys(true)).toEqual(["p4", "p2", "p2:d", "p1", "p1:b", "p1:c"])
		expect(keys(false)).toEqual(["p5", "p3", "p3:e", "p3:f", "p3:g", "p1", "p1:a"])
	})
})
