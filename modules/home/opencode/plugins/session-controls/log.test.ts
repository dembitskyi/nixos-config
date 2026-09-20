import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLog, logPath } from "./log";

afterEach(() => {
	delete process.env.OPENCODE_SESSION_CONTROLS_LOG_DIR;
});

describe("session controls log", () => {
	test("writes JSONL and redacts secret-shaped fields", () => {
		process.env.OPENCODE_SESSION_CONTROLS_LOG_DIR = mkdtempSync(
			join(tmpdir(), "session-controls-log-test-"),
		);
		createLog("server").info("model.override-applied", {
			sessionID: "ses_test",
			token: "secret",
			nested: { authorization: "Bearer secret" },
		});

		const entry = JSON.parse(readFileSync(logPath(), "utf8").trim());
		expect(entry).toMatchObject({
			level: "info",
			component: "server",
			event: "model.override-applied",
			sessionID: "ses_test",
			token: "[redacted]",
			nested: { authorization: "[redacted]" },
		});
	});
});
