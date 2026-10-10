import { describe, expect, test } from "bun:test"

import {
	board,
	clampLanes,
	finalError,
	finalText,
	kickoff,
	line,
	overlaps,
	parseModel,
	type Run,
	readTasks,
	startable,
	stuck,
	type Task,
	taskReport,
	wake,
	workerPrompt,
} from "./state"

const agents = new Set(["dev-junior", "dev-senior"])

function run(tasks: Partial<Task>[] = [], lanes = 2): Run {
	return {
		id: "r1",
		goal: "Ship the feature",
		origin: "origin",
		directory: "/repo",
		lanes,
		notes: [],
		status: "running",
		tasks: tasks.map((task, index) => ({
			id: `t${index + 1}`,
			title: `Task ${index + 1}`,
			prompt: "Do it.",
			agent: "dev-junior",
			deps: [],
			files: [],
			status: "queued",
			attempts: 0,
			...task,
		})),
		created: 0,
		updated: 0,
	}
}

describe("readTasks", () => {
	test("generates IDs and fills defaults", () => {
		const { tasks, errors } = readTasks([{ title: "A", prompt: "Do A." }], run([{}]), agents)
		expect(errors).toEqual([])
		expect(tasks).toEqual([
			{
				id: "t2",
				title: "A",
				prompt: "Do A.",
				agent: "dev-junior",
				deps: [],
				files: [],
				status: "queued",
				attempts: 0,
			},
		])
	})

	test("reports every invalid field", () => {
		const { errors } = readTasks(
			[
				{ title: "", prompt: "x" },
				{ id: "Bad ID", title: "B", prompt: "x" },
				{ id: "t1", title: "C", prompt: "x" },
				{ title: "D", prompt: "x", agent: "nobody", model: "nope" },
				{ title: "E", prompt: "x", deps: ["missing"] },
			],
			run([{}]),
			agents,
		)
		expect(errors).toEqual([
			"task 1: title and prompt are required.",
			'task 2: id "Bad ID" must be lowercase letters, digits, and dashes.',
			'task 3: id "t1" is already used.',
			'task 4: unknown agent "nobody".',
			"task 4: model must look like provider/model#variant.",
			't4: unknown dependency "missing".',
		])
	})

	test("rejects an empty list", () => {
		expect(readTasks([], run(), agents).errors).toEqual(["Give at least one task."])
	})
})

test("overlaps treats a directory as covering its files", () => {
	expect(overlaps(["src/a.ts"], ["./src/a.ts"])).toBe(true)
	expect(overlaps(["src/"], ["src/lib/b.ts"])).toBe(true)
	expect(overlaps(["src/a.ts"], ["src/ab.ts"])).toBe(false)
	expect(overlaps([], ["src/a.ts"])).toBe(false)
})

describe("startable", () => {
	test("fills free lanes in order, honoring dependencies and file overlap", () => {
		const r = run([
			{ files: ["src/a.ts"] },
			{ files: ["src/a.ts"] },
			{ deps: ["t1"] },
			{ files: ["docs/"] },
			{ files: ["src/c.ts"] },
		])
		expect(startable(r).map((task) => task.id)).toEqual(["t1", "t4"])
		r.tasks[0].status = "done"
		r.tasks[3].status = "running"
		expect(startable(r).map((task) => task.id)).toEqual(["t2"])
	})

	test("stuck lists tasks behind failed or cancelled dependencies", () => {
		const r = run([{ status: "failed" }, { deps: ["t1"] }, { status: "cancelled" }, { deps: ["t3"] }])
		expect(stuck(r).map((task) => task.id)).toEqual(["t2", "t4"])
		expect(startable(r)).toEqual([])
	})
})

test("parseModel and clampLanes", () => {
	expect(parseModel("openrouter/anthropic/claude#high")).toEqual({
		providerID: "openrouter",
		id: "anthropic/claude",
		variant: "high",
	})
	expect(parseModel("bad")).toBeUndefined()
	expect(clampLanes(12, 8)).toBe(8)
	expect(clampLanes(0, 8)).toBe(1)
	expect(clampLanes(undefined, 8)).toBe(8)
})

test("finalText takes the last error-free answer; finalError the failure", () => {
	const messages = [
		{ type: "assistant", content: [{ type: "text", text: "First." }] },
		{ type: "user", content: [{ type: "text", text: "Again." }] },
		{ type: "assistant", content: [{ type: "reasoning" }, { type: "text", text: "Done." }] },
		{ type: "assistant", content: [], error: { message: "rate limited" } },
	]
	expect(finalText(messages)).toBe("Done.")
	expect(finalError(messages)).toBe("rate limited")
	expect(finalError(messages.slice(0, 3))).toBeUndefined()
})

describe("text for models", () => {
	const r = run([
		{ status: "done", report: "## Changed a\nDetails.", title: "Alpha" },
		{ status: "running", started: 0 },
		{ status: "blocked", blocked: "shell rm -rf build", sessionID: "s3" },
		{ status: "failed", error: "tests fail" },
		{},
	])

	test("line summarizes counts and a pending question", () => {
		expect(line(r)).toBe("Lanes run r1 (Ship the feature): 1/5 done · 1 running · 1 blocked · 1 queued · 1 failed.")
		expect(line({ ...r, question: "Which API?" })).toContain("Planner asks: Which API? (answer with lanes_tell).")
	})

	test("board lists lanes by state", () => {
		const text = board(r, 120000)
		expect(text).toContain("Run r1 · running · 2 lanes · 5 tasks: 1 done, 1 running, 1 blocked, 1 queued, 1 failed")
		expect(text).toContain("Running: t2 Task 2 (dev-junior, 2m)")
		expect(text).toContain("Blocked: t3 Task 3 waits for shell rm -rf build (session s3)")
		expect(text).toContain("Failed: t4 Task 4: tests fail")
		expect(text).toContain("Queued: t5")
	})

	test("taskReport shows the report of a finished task", () => {
		expect(taskReport(r, r.tasks[0])).toBe("Task t1 of run r1 · done · dev-junior\n\n## Changed a\nDetails.")
	})

	test("workerPrompt carries scope, notes, and the goal", () => {
		const text = workerPrompt({ ...r, notes: ["Use tabs."] }, { ...r.tasks[4], files: ["src/a.ts"] })
		expect(text).toContain("Lane task t5 of run r1: Task 5")
		expect(text).toContain("Files in scope: src/a.ts.")
		expect(text).toContain("Shared notes:\n- Use tabs.")
		expect(text).toContain("Context only, do not act on it")
		expect(text).toContain("The run's goal: Ship the feature")
	})

	test("kickoff and wake tell the planner what to do", () => {
		expect(kickoff(run())).toContain("Add tasks with plan_add")
		expect(kickoff(r)).toContain("already queued these tasks")
		const text = wake(r)
		expect(text).toContain("t1 Alpha [done]: ## Changed a")
		expect(text).toContain("t4 Task 4 [failed]: tests fail")
		expect(text).toContain("plan_finish")
	})
})
