import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fileLog } from "./log"

test("fileLog appends JSON lines at or above its level, with errors as message and stack", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lanes-log-"))
	try {
		const path = join(dir, "nested", "lanes.log")
		const log = fileLog(path, "info")
		log.debug("hidden", { a: 1 })
		log.info("run.started", { run: "r1", skipped: undefined })
		log.error("task.failed", { run: "r1", error: new Error("boom") })
		await log.flush()
		const lines = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(lines).toHaveLength(2)
		expect(lines[0]).toMatchObject({ level: "info", component: "server", event: "run.started", run: "r1" })
		expect(lines[0]).not.toHaveProperty("skipped")
		expect(typeof lines[0].time).toBe("string")
		expect(lines[1]).toMatchObject({ level: "error", event: "task.failed", error: { message: "boom" } })
		expect(lines[1].error.stack).toContain("boom")
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
