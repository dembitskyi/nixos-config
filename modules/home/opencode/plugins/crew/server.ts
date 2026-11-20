// `/crew` server side (OpenCode V2): injects model choices into subagent launches,
// tells the model its crew, applies the away rules to the session tree, and moves
// crews along their fallback chain when a provider refuses, returning home later.
import { execFile } from "node:child_process"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
	type AgentInfo,
	AWAY_ANSWER,
	AWAY_NOTE,
	available,
	classify,
	type Crew,
	type Chains,
	type Forbidden,
	formatModel,
	homeCrew,
	KEY,
	leftProvider,
	type ModelRef,
	nextFallback,
	note,
	type Presets,
	type Reason,
	parseModel,
	QUESTION,
	type RetryError,
	readCrew,
	readChainName,
	readChains,
	readForbidden,
	readPresets,
	type Rule,
	selectedChain,
	TOOL,
	toolDescription,
	usesProvider,
	withCrew,
} from "./policy"

interface SessionInfo {
	readonly id: string
	readonly parentID?: string
	readonly agent?: string
	readonly metadata?: Readonly<Record<string, unknown>>
	readonly permissions?: readonly Rule[]
}

export interface RetryEvent {
	readonly sessionID: string
	readonly agent: string
	readonly model: ModelRef
	readonly error: RetryError & { readonly message?: string }
	readonly attempt: number
	decision: { retry: false } | { retry: true; delay: number }
}

interface ContextEvent {
	readonly sessionID: string
	readonly agent: string
	readonly model: ModelRef
	system: { type: "text"; text: string }[]
	tools: Record<string, { description: string }>
}

interface ToolEvent {
	tool: string
	readonly sessionID: string
	input: unknown
}

interface PermissionEvent {
	readonly sessionID: string
	readonly action: string
	effect: "allow" | "ask" | "deny"
	message?: string
}

export interface SessionHooks {
	context: ContextEvent
	retry: RetryEvent
}

export interface ServerContext {
	readonly agent: {
		list(): Promise<{ data: readonly AgentInfo[] }>
	}
	readonly options?: Readonly<Record<string, unknown>>
	readonly session: {
		get(input: { sessionID: string }): Promise<SessionInfo>
		update?(input: { sessionID: string; metadata?: Record<string, unknown> }): Promise<unknown>
		switchModel?(input: { sessionID: string; model: ModelRef }): Promise<unknown>
		hook<Name extends keyof SessionHooks>(
			name: Name,
			callback: (event: SessionHooks[Name]) => Promise<void>,
		): Promise<unknown>
	}
	readonly storage?: {
		get(key: string): Promise<unknown>
		set(key: string, value: unknown): Promise<void>
		remove(key: string): Promise<void>
		scan(options: {
			prefix: string
			after?: string
		}): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
	}
	readonly tool: {
		hook(name: "execute.before", callback: (event: ToolEvent) => Promise<void>): Promise<unknown>
	}
	readonly permission: {
		hook(name: "evaluate", callback: (event: PermissionEvent) => Promise<void>): Promise<unknown>
	}
}

async function rootOf(ctx: ServerContext, session: SessionInfo): Promise<SessionInfo> {
	const seen = new Set<string>()
	while (session.parentID && !seen.has(session.id)) {
		seen.add(session.id)
		session = await ctx.session.get({ sessionID: session.parentID })
	}
	return session
}

export async function rootCrew(ctx: ServerContext, session: SessionInfo): Promise<Crew> {
	return readCrew((await rootOf(ctx, session)).metadata?.[KEY])
}

export type Log = (event: string, fields: Record<string, unknown>) => void

function fileLog(): Log {
	const path = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "log", "crew.log")
	let queue: Promise<unknown> = mkdir(join(path, ".."), { recursive: true }).catch(() => undefined)
	return (event, fields) => {
		const line = `${JSON.stringify({ time: new Date().toISOString(), level: "info", component: "server", event, ...fields })}\n`
		queue = queue.then(() => appendFile(path, line)).catch(() => undefined)
	}
}

export interface Readiness {
	ok: boolean
	message: string
}

export interface FallbackSettings {
	presets: Presets
	chains: Chains
	minutes: number
	defaultChain?: string
	networkFailures: number
	forbidden: Forbidden
	homeChecks: Record<string, string>
	homeCheckMinutes: number
	ready: (command: string) => Promise<Readiness>
	now: () => number
	log: Log
}

const positive = (value: unknown, fallback: number) =>
	typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback

function readHomeChecks(value: unknown): Record<string, string> {
	const checks: Record<string, string> = {}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return checks
	for (const [provider, command] of Object.entries(value)) {
		if (provider && typeof command === "string" && command) checks[provider] = command
	}
	return checks
}

const CHECK_MS = 30_000

function runCheck(command: string): Promise<Readiness> {
	return new Promise((resolve) => {
		const done = (ok: boolean, output: string, fallback = "") => {
			const line = (output.trim() || fallback).split("\n")[0]?.trim() ?? ""
			resolve({ ok, message: line.slice(0, 200) })
		}
		try {
			execFile(command, [], { timeout: CHECK_MS }, (error, stdout, stderr) => {
				const output = `${stdout}`.trim() || `${stderr}`
				if (!error) return done(true, output)
				const reason = error.killed ? `timed out after ${CHECK_MS / 1000}s` : error.message
				done(false, output, reason)
			})
		} catch (error) {
			done(false, "", String(error))
		}
	})
}

export function fallbackSettings(options: Readonly<Record<string, unknown>> = {}): FallbackSettings {
	return {
		presets: readPresets(options.presets),
		chains: readChains(options.fallback),
		minutes: positive(options.fallbackMinutes, 30),
		defaultChain: readChainName(options.fallbackDefault),
		networkFailures: positive(options.networkFailures, 4),
		forbidden: readForbidden(options.forbidden),
		homeChecks: readHomeChecks(options.homeChecks),
		homeCheckMinutes: positive(options.homeCheckMinutes, 5),
		ready: runCheck,
		now: () => Date.now(),
		log: fileLog(),
	}
}

// Roots in a fallback, as `<prefix><rootID>`, so a reloaded plugin still switches them back.
export const PENDING = "crew/fallback/"

// An outage count lapses after this long without another failure.
const OUTAGE_MS = 10 * 60_000

/** Switches crews whose provider refuses to their fallback preset, and back home once checks pass. */
export function fallbacks(ctx: ServerContext, settings: FallbackSettings) {
	const { presets, log } = settings
	const queues = new Map<string, Promise<unknown>>()
	const locked = <T>(root: string, work: () => Promise<T>): Promise<T> => {
		const run = (queues.get(root) ?? Promise.resolve()).then(work, work)
		const tail = run.catch(() => undefined)
		queues.set(root, tail)
		void tail.then(() => queues.get(root) === tail && queues.delete(root))
		return run
	}

	// Consecutive outage failures per session; restarts on a retry's attempt 2, a provider change, or after OUTAGE_MS.
	const outages = new Map<string, { providerID: string; count: number; last: number }>()
	const countOutage = (sessionID: string, providerID: string, attempt: number) => {
		const now = settings.now()
		for (const [id, entry] of outages) if (now - entry.last > OUTAGE_MS) outages.delete(id)
		const entry = outages.get(sessionID)
		const count = entry?.providerID === providerID && attempt > 2 ? entry.count + 1 : 1
		outages.set(sessionID, { providerID, count, last: now })
		return count
	}

	const switchTo = async (sessionID: string, ref: string | undefined) => {
		const model = ref ? parseModel(ref) : undefined
		if (!model || !ctx.session.switchModel) return false
		await ctx.session.switchModel({ sessionID, model })
		outages.delete(sessionID)
		return true
	}

	/** Moves the root's crew onto `target`; gives up if its preset or fallback changed since `seen`. */
	const save = async (rootID: string, seen: Crew, target: Crew) => {
		const root = await ctx.session.get({ sessionID: rootID })
		const current = readCrew(root.metadata?.[KEY])
		if (current.preset !== seen.preset || current.fallback?.since !== seen.fallback?.since) return false
		const crew: Crew = { ...current, models: target.models, preset: target.preset, fallback: target.fallback }
		await ctx.session.update?.({ sessionID: rootID, metadata: withCrew(root.metadata, crew) })
		return true
	}

	async function retry(event: RetryEvent) {
		const kind = classify(event.error, settings.forbidden)
		if (!kind) return
		// Brief outages are left to OpenCode's own retries until they persist.
		if (kind.repeated && event.decision.retry) {
			const count = countOutage(event.sessionID, event.model.providerID, event.attempt)
			if (count < settings.networkFailures) return
		}
		try {
			await apply(event, kind.reason)
		} catch (error) {
			log("fallback.error", { session: event.sessionID, reason: kind.reason, error: String(error) })
		}
	}

	async function apply(event: RetryEvent, reason: Reason) {
		const failing = await ctx.session.get({ sessionID: event.sessionID })
		const rootID = (await rootOf(ctx, failing)).id
		await locked(rootID, async () => {
			const root = await ctx.session.get({ sessionID: rootID })
			const crew = readCrew(root.metadata?.[KEY])
			const chain = selectedChain(crew, settings.chains, settings.defaultChain)
			if (!chain || !crew.preset || !presets[crew.preset]) return
			const fields = {
				session: event.sessionID,
				root: rootID,
				agent: event.agent,
				model: formatModel(event.model),
				reason,
				chain,
			}
			if (!usesProvider(crew, event.model.providerID)) {
				// Another session already moved the crew on from this provider: follow it.
				// Any other model was chosen on purpose, so it is left alone.
				if (!crew.fallback || !leftProvider(crew, presets, event.model.providerID)) return
				if (await switchTo(event.sessionID, crew.models[event.agent])) {
					event.decision = { retry: true, delay: 0 }
					log("fallback.follow", { ...fields, preset: crew.preset, to: crew.models[event.agent] })
				}
				return
			}
			const next = nextFallback(crew, presets, settings.chains[chain] ?? {}, reason, settings.now())
			if (!next?.preset) return
			// Stored first, so a switch back is never missed; a stale entry is dropped by check().
			const rootAgent = root.agent ?? (event.sessionID === rootID ? event.agent : undefined)
			await ctx.storage?.set(`${PENDING}${rootID}`, {
				since: next.fallback?.since ?? settings.now(),
				...(rootAgent ? { agent: rootAgent } : {}),
			})
			if (!(await save(rootID, crew, next))) return
			const rootSwitched = rootAgent ? await switchTo(rootID, next.models[rootAgent]) : false
			const switched =
				event.sessionID === rootID ? rootSwitched : await switchTo(event.sessionID, next.models[event.agent])
			if (switched) event.decision = { retry: true, delay: 0 }
			log("fallback.switch", {
				...fields,
				from: crew.preset,
				to: next.preset,
				home: next.fallback?.home,
				status: event.error.status,
				error: event.error.message,
				retry: switched,
			})
		})
	}

	const waits = new Map<string, { since: number; at: number }>()

	const checkHome = (home: Crew) => {
		const providers = new Set(Object.values(home.models).map((ref) => parseModel(ref)?.providerID))
		const checked = [...providers].filter(
			(provider): provider is string => !!provider && Object.hasOwn(settings.homeChecks, provider),
		)
		return Promise.all(
			checked.map(async (provider) => {
				const result = await settings
					.ready(settings.homeChecks[provider] as string)
					.catch((error): Readiness => ({ ok: false, message: String(error) }))
				return { provider, ...result }
			}),
		)
	}

	/** Switches roots whose fallback time is up back home once checks pass; checks run outside the root's lock. */
	async function check() {
		if (!ctx.storage) return
		const entries: { key: string; value: unknown }[] = []
		let after: string | undefined
		do {
			const page = await ctx.storage.scan({ prefix: PENDING, ...(after ? { after } : {}) })
			entries.push(...page.entries)
			after = page.next
		} while (after)
		for (const { key, value } of entries) {
			const rootID = key.slice(PENDING.length)
			try {
				const due = await locked(rootID, async () => {
					// A removed session has nothing left to switch back.
					const root = await ctx.session.get({ sessionID: rootID }).catch(() => undefined)
					const crew = root && readCrew(root.metadata?.[KEY])
					// The return home does not depend on the chain, which may have changed or gone.
					if (!root || !crew?.fallback) {
						waits.delete(rootID)
						await ctx.storage?.remove(key)
						return undefined
					}
					const { since } = crew.fallback
					if (settings.now() < since + settings.minutes * 60_000) return undefined
					const wait = waits.get(rootID)
					if (wait?.since === since && settings.now() < wait.at) return undefined
					return { root, crew, fallback: crew.fallback }
				})
				if (!due) continue
				const { root, crew, fallback } = due
				// Without its home preset the crew stays where it is, out of the fallback.
				const home = homeCrew(crew, presets)
				const checks = home ? await checkHome(home) : []
				const failed = checks.find((result) => !result.ok)
				if (failed) {
					waits.set(rootID, { since: fallback.since, at: settings.now() + settings.homeCheckMinutes * 60_000 })
					log("fallback.wait", {
						root: rootID,
						from: crew.preset,
						to: fallback.home,
						provider: failed.provider,
						reason: failed.message,
					})
					continue
				}
				await locked(rootID, async () => {
					waits.delete(rootID)
					// Other plugin instances share the storage and may switch back first.
					if (!(await save(rootID, crew, home ?? { ...crew, fallback: undefined }))) return
					const stored = (value as { agent?: unknown } | undefined)?.agent
					const rootAgent = root.agent ?? (typeof stored === "string" ? stored : undefined)
					if (home && rootAgent) await switchTo(rootID, home.models[rootAgent])
					await ctx.storage?.remove(key)
					log("fallback.home", {
						root: rootID,
						from: crew.preset,
						to: fallback.home,
						restored: !!home,
						...(checks.length > 0
							? { checks: Object.fromEntries(checks.map((result) => [result.provider, result.message])) }
							: {}),
					})
				})
			} catch (error) {
				log("fallback.error", { root: rootID, error: String(error) })
			}
		}
	}

	return { retry, check }
}

export default {
	id: "crew",
	async setup(ctx: ServerContext) {
		await ctx.tool.hook("execute.before", async (event) => {
			if (event.tool !== TOOL) return
			const input = event.input as { agent?: unknown; model?: unknown } | undefined
			if (typeof input?.agent !== "string") return
			// A model the user asked for in the conversation wins.
			if (typeof input.model === "string" && input.model !== "") return
			const session = await ctx.session.get({ sessionID: event.sessionID })
			const model = (await rootCrew(ctx, session)).models[input.agent]
			if (model) event.input = { ...input, model }
		})

		await ctx.session.hook("context", async (event) => {
			const [{ data: agents }, session] = await Promise.all([
				ctx.agent.list(),
				ctx.session.get({ sessionID: event.sessionID }),
			])
			const crew = await rootCrew(ctx, session)
			const own = agents.find((agent) => agent.id === event.agent)?.permissions ?? []
			const configured = available(agents, own)
			// Children copy the root's session rules when created, but /crew only
			// steers the root, so they keep their configured access.
			const effective = session.parentID ? configured : available(agents, [...own, ...(session.permissions ?? [])])
			const tool = event.tools[TOOL]
			if (tool && effective.length === 0) delete event.tools[TOOL]
			else if (tool) tool.description = toolDescription(tool.description, effective, crew, formatModel(event.model))
			const text = session.parentID ? undefined : note(configured, effective)
			if (text) event.system.push({ type: "text", text })
			if (crew.away) {
				delete event.tools[QUESTION]
				event.system.push({ type: "text", text: AWAY_NOTE })
			}
		})

		// Only prompts and questions matter here, so other checks skip the session lookup.
		await ctx.permission.hook("evaluate", async (event) => {
			if (event.effect !== "ask" && event.action !== QUESTION) return
			const crew = await rootCrew(ctx, await ctx.session.get({ sessionID: event.sessionID }))
			if (!crew.away) return
			if (event.action === QUESTION) {
				event.effect = "deny"
				event.message = AWAY_ANSWER
			} else event.effect = "allow"
		})

		const settings = fallbackSettings(ctx.options)
		if (Object.keys(settings.chains).length === 0) return
		const fallback = fallbacks(ctx, settings)
		await ctx.session.hook("retry", fallback.retry)
		let checking = false
		const timer = setInterval(() => {
			if (checking) return
			checking = true
			void fallback.check().finally(() => {
				checking = false
			})
		}, 60_000)
		timer.unref?.()
		return () => clearInterval(timer)
	},
}
