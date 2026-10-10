// JSON-lines log for troubleshooting lanes, next to OpenCode's own logs in
// $XDG_DATA_HOME/opencode/log, in the same shape as the other plugin logs
// there. Writes are queued in order and never throw; past MAX_BYTES the file
// rotates to `<name>.1`.
import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Level = "debug" | "info" | "warn" | "error"
export type Fields = Record<string, unknown>

export interface Log {
	debug(event: string, fields?: Fields): void
	info(event: string, fields?: Fields): void
	warn(event: string, fields?: Fields): void
	error(event: string, fields?: Fields): void
}

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const MAX_BYTES = 5 * 1024 * 1024

export function isLevel(value: unknown): value is Level {
	return typeof value === "string" && value in RANK
}

export function defaultPath(name: string) {
	const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
	return join(data, "opencode", "log", `${name}.log`)
}

/** Errors become their message and stack; everything else is kept as is. */
function plain(value: unknown): unknown {
	if (value instanceof Error) return value.stack ? { message: value.message, stack: value.stack } : value.message
	return value
}

export function fileLog(path: string, minimum: Level = "info", component = "server"): Log & { flush(): Promise<void> } {
	let size: number | undefined
	let queue: Promise<void> = mkdir(dirname(path), { recursive: true }).then(
		() => undefined,
		() => undefined,
	)
	const write = (level: Level, event: string, fields: Fields = {}) => {
		if (RANK[level] < RANK[minimum]) return
		const entry: Fields = { time: new Date().toISOString(), level, component, event }
		for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry[key] = plain(value)
		let line: string
		try {
			line = `${JSON.stringify(entry)}\n`
		} catch {
			line = `${JSON.stringify({ time: entry.time, level, component, event, note: "fields could not be serialized" })}\n`
		}
		const bytes = Buffer.byteLength(line)
		queue = queue.then(async () => {
			try {
				size ??= await stat(path).then(
					(info) => info.size,
					() => 0,
				)
				if (size + bytes > MAX_BYTES) {
					await rename(path, `${path}.1`).catch(() => undefined)
					size = 0
				}
				await appendFile(path, line, { mode: 0o600 })
				size += bytes
			} catch {
				// Logging must never break the plugin.
			}
		})
	}
	return {
		debug: (event, fields) => write("debug", event, fields),
		info: (event, fields) => write("info", event, fields),
		warn: (event, fields) => write("warn", event, fields),
		error: (event, fields) => write("error", event, fields),
		flush: () => queue,
	}
}
