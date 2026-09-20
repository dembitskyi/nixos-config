import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Level = "debug" | "info" | "warn" | "error";

export type Log = {
	debug(event: string, data?: Record<string, unknown>): void;
	info(event: string, data?: Record<string, unknown>): void;
	warn(event: string, data?: Record<string, unknown>): void;
	error(event: string, data?: Record<string, unknown>): void;
};

export function logPath(): string {
	const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(
		process.env.OPENCODE_SESSION_CONTROLS_LOG_DIR ??
			join(data, "opencode", "log"),
		"session-controls.log",
	);
}

export function createLog(component: "server" | "tui"): Log {
	const write = (
		level: Level,
		event: string,
		data: Record<string, unknown> = {},
	) => {
		try {
			const file = logPath();
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			appendFileSync(
				file,
				`${JSON.stringify({ time: new Date().toISOString(), level, component, event, ...sanitize(data) })}\n`,
				{ mode: 0o600 },
			);
		} catch (error) {
			console.error("[session-controls] failed to write log", error);
		}
	};
	return {
		debug: (event, data) => write("debug", event, data),
		info: (event, data) => write("info", event, data),
		warn: (event, data) => write("warn", event, data),
		error: (event, data) => write("error", event, data),
	};
}

function sanitize(data: Record<string, unknown>): Record<string, unknown> {
	const seen = new WeakSet<object>();

	function clean(key: string, value: unknown): unknown {
		if (/token|secret|password|authorization|cookie/i.test(key))
			return "[redacted]";
		if (typeof value === "string")
			return value.length > 500 ? `${value.slice(0, 500)}…` : value;
		if (!value || typeof value !== "object") return value;
		if (seen.has(value)) return "[circular]";
		seen.add(value);
		if (Array.isArray(value)) return value.map((item) => clean("", item));
		if (value instanceof Error)
			return clean("", { name: value.name, message: value.message });
		return Object.fromEntries(
			Object.entries(value).map(([childKey, child]) => [
				childKey,
				clean(childKey, child),
			]),
		);
	}

	return clean("", data) as Record<string, unknown>;
}
