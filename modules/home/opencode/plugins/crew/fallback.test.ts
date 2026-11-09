import { afterAll, describe, expect, test } from "bun:test"

import {
	type Crew,
	type Chains,
	chainText,
	classify,
	type Fallbacks,
	type Forbidden,
	fallbackText,
	KEY,
	type ModelRef,
	type Presets,
	readChainName,
	readChains,
	readCrew,
	routeText,
	selectedChain,
	withChain,
	withCrew,
} from "./policy"
import plugin, { fallbacks, type FallbackSettings, PENDING, type RetryEvent, type ServerContext } from "./server"

const presets: Presets = {
	main: { dev: "main/opus#medium", general: "main/opus", explore: "main/haiku" },
	backup: { dev: "backup/opus#medium", general: "backup/opus" },
	spare: { dev: "spare/opus#medium", general: "spare/opus", explore: "spare/haiku" },
}

const via: Fallbacks = {
	main: { quota: "backup", auth: "backup", network: "spare" },
	backup: { quota: "spare", auth: "spare", network: "spare" },
}

type Session = { parentID?: string; agent?: string; model?: ModelRef; metadata?: Record<string, unknown> }

const spareOnly: Fallbacks = { main: { quota: "spare", auth: "spare", network: "spare" } }
const chains: Chains = { "via-backup": via, "spare-only": spareOnly }

function crewOn(preset: string, extra: Partial<Crew> = {}): Crew {
	return {
		delegation: "default",
		access: {},
		models: { ...presets[preset] },
		preset,
		fallbackChain: "via-backup",
		...extra,
	}
}

function fake(
	root: Crew | undefined,
	input: { minutes?: number; defaultChain?: string; chains?: Chains; forbidden?: Forbidden } = {},
) {
	const clock = { now: 1_000_000 }
	const sessions: Record<string, Session> = {
		root: { agent: "dev", metadata: { title: "keep", ...(root ? { [KEY]: root } : {}) } },
		child: { parentID: "root", agent: "general" },
		other: { parentID: "root", agent: "explore" },
	}
	const switches: { sessionID: string; model: string }[] = []
	const store = new Map<string, unknown>()
	const logs: string[] = []
	const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
	const ctx: ServerContext = {
		agent: { list: async () => ({ data: [] }) },
		session: {
			get: async ({ sessionID }) => {
				await tick()
				return { id: sessionID, ...structuredClone(sessions[sessionID]) }
			},
			update: async ({ sessionID, metadata }) => {
				await tick()
				const session = sessions[sessionID]
				if (session && metadata) session.metadata = structuredClone(metadata)
			},
			switchModel: async ({ sessionID, model }) => {
				switches.push({
					sessionID,
					model: `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`,
				})
			},
			hook: async () => undefined,
		},
		tool: { hook: async () => undefined },
		permission: { hook: async () => undefined },
		storage: {
			get: async (key) => store.get(key),
			set: async (key, value) => void store.set(key, value),
			remove: async (key) => void store.delete(key),
			scan: async ({ prefix }) => ({
				entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
			}),
		},
	}
	const settings: FallbackSettings = {
		presets,
		chains: input.chains ?? chains,
		minutes: input.minutes ?? 30,
		defaultChain: input.defaultChain,
		networkFailures: 4,
		forbidden: input.forbidden ?? "auth",
		now: () => clock.now,
		log: (event) => logs.push(event),
	}
	const crew = () => readCrew(sessions.root?.metadata?.[KEY])
	return { ctx, settings, sessions, switches, store, logs, clock, crew, ...fallbacks(ctx, settings) }
}

function refusal(
	sessionID: string,
	agent: string,
	model: string,
	type = "provider.quota",
	status = 429,
	// OpenCode reports the next attempt, so the first refusal of a step is attempt 2.
	attempt = 2,
	retry = false,
): RetryEvent {
	const [providerID, id] = model.split("/") as [string, string]
	return {
		sessionID,
		agent,
		model: { providerID, id },
		error: { type, status, message: "refused" },
		attempt,
		decision: retry ? { retry: true, delay: 2000 } : { retry: false },
	}
}

describe("classify", () => {
	const cases: [string, number | undefined, string | undefined, boolean?][] = [
		["provider.quota", 429, "quota"],
		["provider.auth", 401, "auth"],
		["provider.auth", 403, "auth"],
		["provider.auth", undefined, undefined],
		["provider.internal", 502, "network", true],
		["provider.internal", 503, "network", true],
		["provider.transport", undefined, "network", true],
		["provider.timeout", undefined, "network", true],
		["provider.invalid-request", 404, "network", true],
		["provider.invalid-request", 400, undefined],
		["provider.rate-limit", 429, undefined],
		["provider.unknown", undefined, undefined],
		["other", 500, undefined],
	]
	for (const [type, status, reason, repeated = false] of cases)
		test(`${type} ${status ?? "-"} → ${reason ?? "none"}${repeated ? " when repeated" : ""}`, () => {
			expect(classify({ type, status }, "auth")).toEqual((reason ? { reason, repeated } : undefined) as never)
		})

	test("a 403 counts as a network refusal when configured", () => {
		expect(classify({ type: "provider.auth", status: 403 }, "network")).toEqual({ reason: "network", repeated: false })
		expect(classify({ type: "provider.auth", status: 401 }, "network")).toEqual({ reason: "auth", repeated: false })
	})

	test("describes an episode's reasons in order", () => {
		const crew = crewOn("spare", {
			fallback: { home: "main", reasons: ["quota", "network", "network"], since: 0, visited: ["main"] },
		})
		expect(fallbackText(crew, 30)).toStartWith("spare — fallback from main (quota, then network) at ")
	})

	test("describes a preset's chain by target", () => {
		expect(chainText(via, "main")).toBe("main → backup (quota, token), spare (network)")
		expect(chainText(via, "backup")).toBe("backup → spare")
		expect(chainText(via, "spare")).toBeUndefined()
		expect(routeText(via, "main")).toBe("main → backup (quota, token), spare (network); backup → spare")
		expect(routeText(spareOnly, "main")).toBe("main → spare")
		expect(routeText(spareOnly, "backup")).toBeUndefined()
	})
})

describe("chains", () => {
	test("read the Nix option shape, dropping unset reasons and malformed entries", () => {
		expect(
			readChains({
				"via-backup": { main: { quota: "backup", auth: "backup", network: "spare" }, backup: { quota: "spare" } },
				"spare-only": { main: { quota: "spare", auth: null, network: "main" } },
				empty: {},
				"": { main: { quota: "spare" } },
				bad: "x",
			}),
		).toEqual({
			"via-backup": { main: { quota: "backup", auth: "backup", network: "spare" }, backup: { quota: "spare" } },
			"spare-only": { main: { quota: "spare" } },
			empty: {},
		})
		expect(readChains(undefined)).toEqual({})
		expect(readChainName("via-backup")).toBe("via-backup")
		for (const value of [undefined, null, "", 1]) expect(readChainName(value)).toBeUndefined()
	})

	const stored = (fields: Record<string, unknown>) =>
		readCrew({ delegation: "default", access: {}, models: {}, ...fields })

	test("map the earlier on/off switch", () => {
		const on = stored({ autoFallback: true })
		expect(selectedChain(on, chains, "via-backup")).toBe("via-backup")
		expect(selectedChain(on, chains)).toBe("spare-only")
		expect(selectedChain(on, chains, "removed")).toBe("spare-only")
		const off = stored({ autoFallback: false })
		expect(off.fallbackChain).toBe(false)
		expect(selectedChain(off, chains, "via-backup")).toBeUndefined()
		const absent = stored({})
		expect(selectedChain(absent, chains)).toBeUndefined()
		expect(selectedChain(absent, chains, "spare-only")).toBe("spare-only")
	})

	test("read a chosen chain; unknown chains are off", () => {
		expect(selectedChain(stored({ fallbackChain: "spare-only" }), chains, "via-backup")).toBe("spare-only")
		expect(selectedChain(stored({ fallbackChain: "removed" }), chains, "via-backup")).toBeUndefined()
		expect(selectedChain(stored({ fallbackChain: false }), chains, "via-backup")).toBeUndefined()
	})

	test("store a choice and replace the earlier switch", () => {
		const legacy = stored({ autoFallback: true })
		expect(withCrew({}, withChain(legacy, "via-backup"))).toEqual({
			[KEY]: { delegation: "default", access: {}, models: {}, fallbackChain: "via-backup" },
		})
		expect(withCrew({}, withChain(legacy, undefined))).toEqual({})
		expect(withChain(legacy, undefined, "via-backup").fallbackChain).toBe(false)
		expect(withChain(legacy, "via-backup", "via-backup").fallbackChain).toBeUndefined()
		expect(withChain(legacy, "spare-only", "via-backup").fallbackChain).toBe("spare-only")
	})
})

describe("retry", () => {
	test("off by default: a quota refusal changes nothing", async () => {
		const run = fake(crewOn("main", { fallbackChain: undefined }))
		const event = refusal("child", "general", "main/opus")
		await run.retry(event)
		expect(event.decision).toEqual({ retry: false })
		expect(run.crew().preset).toBe("main")
		expect(run.switches).toEqual([])
		expect(run.store.size).toBe(0)
	})

	test("explicitly off wins over the default", async () => {
		const run = fake(crewOn("main", { fallbackChain: false }), { defaultChain: "via-backup" })
		await run.retry(refusal("child", "general", "main/opus"))
		expect(run.crew().preset).toBe("main")
	})

	test("the default chain applies to a fresh crew", async () => {
		const run = fake(crewOn("main", { fallbackChain: undefined }), { defaultChain: "spare-only" })
		const event = refusal("child", "general", "main/opus")
		await run.retry(event)
		expect(run.crew().preset).toBe("spare")
		expect(event.decision).toEqual({ retry: true, delay: 0 })
	})

	test("an unknown chain is off", async () => {
		const run = fake(crewOn("main", { fallbackChain: "removed" }), { defaultChain: "via-backup" })
		await run.retry(refusal("child", "general", "main/opus"))
		expect(run.crew().preset).toBe("main")
	})

	test("the selected chain decides the route", async () => {
		const direct = fake(crewOn("main", { fallbackChain: "spare-only" }))
		await direct.retry(refusal("child", "general", "main/opus"))
		expect(direct.crew().preset).toBe("spare")
		expect(direct.crew().fallback?.visited).toEqual(["main", "spare"])

		const stepped = fake(crewOn("main"))
		await stepped.retry(refusal("child", "general", "main/opus"))
		expect(stepped.crew().preset).toBe("backup")
		await stepped.retry(refusal("child", "general", "backup/opus"))
		expect(stepped.crew().fallback?.visited).toEqual(["main", "backup", "spare"])
	})

	test("a chain changed mid-fallback keeps the fallback and takes the next hop", async () => {
		const run = fake(crewOn("main"), {
			chains: { ...chains, "back-only": { main: { quota: "backup" } }, onward: { backup: { quota: "spare" } } },
		})
		const root = run.sessions.root as Session
		root.metadata = { [KEY]: crewOn("main", { fallbackChain: "back-only" }) }
		await run.retry(refusal("child", "general", "main/opus"))
		expect(run.crew().preset).toBe("backup")
		const event = refusal("child", "general", "backup/opus")
		await run.retry(event)
		expect(run.crew().preset).toBe("backup")
		expect(event.decision).toEqual({ retry: false })

		root.metadata = { [KEY]: { ...run.crew(), fallbackChain: "onward" } }
		await run.retry(refusal("child", "general", "backup/opus"))
		expect(run.crew()).toMatchObject({
			preset: "spare",
			fallbackChain: "onward",
			fallback: { home: "main", visited: ["main", "backup", "spare"] },
		})
		run.clock.now += 30 * 60_000
		await run.check()
		expect(run.crew().preset).toBe("main")
	})

	test("first fallback switches the crew, the root and the failing session and retries at once", async () => {
		const run = fake(crewOn("main", { away: true, access: { explore: "deny" } }))
		const event = refusal("child", "general", "main/opus")
		await run.retry(event)
		expect(event.decision).toEqual({ retry: true, delay: 0 })
		expect(run.sessions.root?.metadata?.title).toBe("keep")
		expect(run.crew()).toEqual({
			delegation: "default",
			access: { explore: "deny" },
			models: presets.backup as Record<string, string>,
			preset: "backup",
			away: true,
			fallbackChain: "via-backup",
			fallback: { home: "main", reasons: ["quota"], since: 1_000_000, visited: ["main", "backup"] },
		})
		expect(run.switches).toEqual([
			{ sessionID: "root", model: "backup/opus#medium" },
			{ sessionID: "child", model: "backup/opus" },
		])
		expect([...run.store.keys()]).toEqual([`${PENDING}root`])
		expect(run.logs).toEqual(["fallback.switch"])
	})

	test("a failing root session retries on its new model", async () => {
		const run = fake(crewOn("main"))
		const event = refusal("root", "dev", "main/opus", "provider.auth", 401)
		await run.retry(event)
		expect(run.crew().fallback?.reasons).toEqual(["auth"])
		expect(run.switches).toEqual([{ sessionID: "root", model: "backup/opus#medium" }])
		expect(event.decision).toEqual({ retry: true, delay: 0 })
	})

	test("a later session on the old provider follows the current preset", async () => {
		const run = fake(crewOn("main"))
		await run.retry(refusal("child", "general", "main/opus"))
		run.switches.length = 0
		const event = refusal("other", "general", "main/opus")
		await run.retry(event)
		expect(run.crew().preset).toBe("backup")
		expect(run.switches).toEqual([{ sessionID: "other", model: "backup/opus" }])
		expect(event.decision).toEqual({ retry: true, delay: 0 })
	})

	test("a follower without a model in the current preset is left to OpenCode", async () => {
		const run = fake(crewOn("backup"))
		const event = refusal("other", "explore", "main/haiku")
		await run.retry(event)
		expect(event.decision).toEqual({ retry: false })
		expect(run.switches).toEqual([])
	})

	test("the chain stops at its last preset", async () => {
		const run = fake(crewOn("main"))
		await run.retry(refusal("child", "general", "main/opus"))
		await run.retry(refusal("child", "general", "backup/opus"))
		expect(run.crew().preset).toBe("spare")
		expect(run.crew().fallback).toMatchObject({ home: "main", visited: ["main", "backup", "spare"] })
		const last = refusal("child", "general", "spare/opus")
		await run.retry(last)
		expect(last.decision).toEqual({ retry: false })
		expect(run.crew().preset).toBe("spare")
	})

	test("never returns to a preset already tried in the episode", async () => {
		const run = fake(crewOn("main"), {
			chains: { "via-backup": { main: { quota: "backup" }, backup: { quota: "main" } } },
		})
		await run.retry(refusal("child", "general", "main/opus"))
		const event = refusal("child", "general", "backup/opus")
		await run.retry(event)
		expect(run.crew().preset).toBe("backup")
		expect(event.decision).toEqual({ retry: false })
	})

	const outage = (model: string, attempt = 2, retry = true, sessionID = "child") =>
		refusal(sessionID, "general", model, "provider.internal", 503, attempt, retry)
	// One request's retries: attempts 2, 3, ... of a step.
	const retries = async (run: ReturnType<typeof fake>, model: string, count: number, sessionID = "child") => {
		for (let attempt = 2; attempt < 2 + count; attempt++) await run.retry(outage(model, attempt, true, sessionID))
	}

	test("network outages fall back after consecutive failures of one request", async () => {
		const run = fake(crewOn("main"))
		for (let attempt = 2; attempt < 5; attempt++) {
			const event = outage("main/opus", attempt)
			await run.retry(event)
			expect(event.decision).toEqual({ retry: true, delay: 2000 })
			run.clock.now += 60_000
		}
		expect(run.crew().preset).toBe("main")
		const fourth = outage("main/opus", 5)
		await run.retry(fourth)
		expect(fourth.decision).toEqual({ retry: true, delay: 0 })
		expect(run.crew().preset).toBe("spare")
		expect(run.crew().fallback?.reasons).toEqual(["network"])
	})

	test("a request's first retry starts a fresh count, so blips with successes between them never add up", async () => {
		const run = fake(crewOn("main"))
		for (let i = 0; i < 6; i++) await run.retry(outage("main/opus", 2))
		await retries(run, "main/opus", 3)
		expect(run.crew().preset).toBe("main")
	})

	test("routing errors count like other outages", async () => {
		const run = fake(crewOn("main"))
		const route = (attempt: number) =>
			refusal("child", "general", "main/opus", "provider.invalid-request", 404, attempt, true)
		for (let attempt = 2; attempt < 5; attempt++) await run.retry(route(attempt))
		expect(run.crew().preset).toBe("main")
		await run.retry(route(5))
		expect(run.crew().preset).toBe("spare")
	})

	test("the outage count is per session and restarts on another provider or after a quiet spell", async () => {
		const run = fake(crewOn("main"))
		await retries(run, "main/opus", 3)
		await run.retry(outage("main/opus", 5, true, "other"))
		await run.retry(outage("elsewhere/opus", 5))
		await run.retry(outage("main/opus", 6))
		await run.retry(outage("main/opus", 7))
		await run.retry(outage("main/opus", 8))
		run.clock.now += 11 * 60_000
		await run.retry(outage("main/opus", 9))
		expect(run.crew().preset).toBe("main")
	})

	test("the count restarts after a switch", async () => {
		const run = fake(crewOn("main"))
		await retries(run, "main/opus", 3)
		await run.retry(refusal("child", "general", "main/opus", "provider.quota", 429, 5))
		expect(run.crew().preset).toBe("backup")
		await run.retry(outage("backup/opus", 6))
		expect(run.crew().preset).toBe("backup")
	})

	test("an outage OpenCode stopped retrying falls back at once", async () => {
		const run = fake(crewOn("main"))
		await run.retry(outage("main/opus", 2, false))
		expect(run.crew().preset).toBe("spare")
	})

	test("a 403 falls back as configured", async () => {
		const forbidden = () => refusal("child", "general", "main/opus", "provider.auth", 403)
		const auth = fake(crewOn("main"))
		await auth.retry(forbidden())
		expect(auth.crew().preset).toBe("backup")
		const network = fake(crewOn("main"), { forbidden: "network" })
		await network.retry(forbidden())
		expect(network.crew().preset).toBe("spare")
	})

	test("a root session without a stored agent uses the failing request's", async () => {
		const run = fake(crewOn("main"))
		delete (run.sessions.root as Session).agent
		const event = refusal("root", "dev", "main/opus")
		await run.retry(event)
		expect(run.switches).toEqual([{ sessionID: "root", model: "backup/opus#medium" }])
		expect(event.decision).toEqual({ retry: true, delay: 0 })

		const child = fake(crewOn("main"))
		delete (child.sessions.root as Session).agent
		await child.retry(refusal("child", "general", "main/opus"))
		expect(child.switches).toEqual([{ sessionID: "child", model: "backup/opus" }])
	})

	test("retries only a session that was moved", async () => {
		const run = fake(crewOn("main"))
		const event = refusal("other", "explore", "main/haiku")
		await run.retry(event)
		expect(run.crew().preset).toBe("backup")
		expect(run.switches).toEqual([{ sessionID: "root", model: "backup/opus#medium" }])
		expect(event.decision).toEqual({ retry: false })
	})

	test("a provider the crew never used is left alone", async () => {
		const run = fake(crewOn("main"))
		await run.retry(refusal("child", "general", "main/opus"))
		run.switches.length = 0
		const event = refusal("other", "general", "chosen/model")
		await run.retry(event)
		expect(event.decision).toEqual({ retry: false })
		expect(run.switches).toEqual([])
	})

	test("following needs a fallback in progress", async () => {
		const run = fake(crewOn("backup"))
		const event = refusal("other", "general", "main/opus")
		await run.retry(event)
		expect(event.decision).toEqual({ retry: false })
		expect(run.switches).toEqual([])
	})

	test("rate limits are left to OpenCode", async () => {
		const run = fake(crewOn("main"))
		const event = refusal("child", "general", "main/opus", "provider.rate-limit", 429, 5, true)
		await run.retry(event)
		expect(event.decision).toEqual({ retry: true, delay: 2000 })
		expect(run.crew().preset).toBe("main")
	})

	test("without a preset or a fallback for it nothing changes", async () => {
		for (const crew of [{ ...crewOn("main"), preset: undefined }, crewOn("spare"), undefined]) {
			const run = fake(crew)
			const event = refusal("child", "general", "spare/opus")
			await run.retry(event)
			expect(event.decision).toEqual({ retry: false })
			expect(run.switches).toEqual([])
		}
	})

	test("sessions failing together switch the crew once", async () => {
		const run = fake(crewOn("main"))
		const events = [
			refusal("root", "dev", "main/opus"),
			refusal("child", "general", "main/opus"),
			refusal("other", "general", "main/opus"),
		]
		await Promise.all(events.map((event) => run.retry(event)))
		expect(run.crew().preset).toBe("backup")
		expect(run.crew().fallback?.visited).toEqual(["main", "backup"])
		expect(run.logs.filter((event) => event === "fallback.switch")).toHaveLength(1)
		for (const event of events) expect(event.decision).toEqual({ retry: true, delay: 0 })
	})
})

describe("switch back", () => {
	test("restores the home preset after the configured minutes", async () => {
		const run = fake(crewOn("main"), { minutes: 10 })
		await run.retry(refusal("child", "general", "main/opus"))
		await run.retry(refusal("child", "general", "backup/opus"))
		run.switches.length = 0

		run.clock.now += 9 * 60_000
		await run.check()
		expect(run.crew().preset).toBe("spare")

		run.clock.now += 60_000
		await run.check()
		expect(run.crew()).toEqual(crewOn("main"))
		expect(run.switches).toEqual([{ sessionID: "root", model: "main/opus#medium" }])
		expect(run.store.size).toBe(0)
	})

	test("a reloaded plugin resumes from storage", async () => {
		const run = fake(crewOn("main"), { minutes: 10 })
		await run.retry(refusal("child", "general", "main/opus"))
		const reloaded = fallbacks(run.ctx, run.settings)
		run.clock.now += 10 * 60_000
		await reloaded.check()
		expect(run.crew().preset).toBe("main")
		expect(run.crew().fallback).toBeUndefined()
	})

	test("still refused at home falls back again with a new start", async () => {
		const run = fake(crewOn("main"), { minutes: 10 })
		await run.retry(refusal("child", "general", "main/opus"))
		run.clock.now += 10 * 60_000
		await run.check()
		await run.retry(refusal("root", "dev", "main/opus"))
		expect(run.crew().preset).toBe("backup")
		expect(run.crew().fallback?.since).toBe(run.clock.now)
		expect(run.store.size).toBe(1)
	})

	test("does not overwrite a crew changed while switching back", async () => {
		const run = fake(crewOn("main"), { minutes: 10 })
		await run.retry(refusal("child", "general", "main/opus"))
		run.switches.length = 0
		run.clock.now += 10 * 60_000
		// The user picks another preset between the timer's read and its write.
		const get = run.ctx.session.get
		let reads = 0
		;(run.ctx.session as { get: typeof get }).get = async (input) => {
			if (input.sessionID === "root" && ++reads === 2)
				(run.sessions.root as Session).metadata = { [KEY]: crewOn("spare") }
			return get(input)
		}
		await run.check()
		expect(run.crew().preset).toBe("spare")
		expect(run.switches).toEqual([])
	})

	test("keeps settings changed while switching back", async () => {
		const run = fake(crewOn("main"), { minutes: 10 })
		await run.retry(refusal("child", "general", "main/opus"))
		run.clock.now += 10 * 60_000
		const get = run.ctx.session.get
		let reads = 0
		;(run.ctx.session as { get: typeof get }).get = async (input) => {
			const root = run.sessions.root as Session
			if (input.sessionID === "root" && ++reads === 2)
				root.metadata = { [KEY]: { ...readCrew(root.metadata?.[KEY]), away: true } }
			return get(input)
		}
		await run.check()
		expect(run.crew()).toEqual(crewOn("main", { away: true }))
	})

	test("switches back a root without a stored agent with the agent saved at the switch", async () => {
		const run = fake(crewOn("main"), { minutes: 10 })
		delete (run.sessions.root as Session).agent
		await run.retry(refusal("root", "dev", "main/opus"))
		expect(run.store.get(`${PENDING}root`)).toEqual({ since: 1_000_000, agent: "dev" })
		run.switches.length = 0
		run.clock.now += 10 * 60_000
		await run.check()
		expect(run.switches).toEqual([{ sessionID: "root", model: "main/opus#medium" }])
	})

	test("ends a fallback whose home preset is gone", async () => {
		const fallback = { home: "gone", reasons: ["quota" as const], since: 1_000_000, visited: ["gone", "backup"] }
		const run = fake(crewOn("backup", { fallback }), { minutes: 10 })
		run.store.set(`${PENDING}root`, { since: 1_000_000 })
		run.clock.now += 10 * 60_000
		await run.check()
		expect(run.crew()).toEqual(crewOn("backup"))
		expect(run.switches).toEqual([])
		expect(run.store.size).toBe(0)
	})

	test("returns home after the chain was removed or renamed", async () => {
		const run = fake(crewOn("main"), { minutes: 10 })
		await run.retry(refusal("child", "general", "main/opus"))
		const root = run.sessions.root as Session
		root.metadata = { [KEY]: { ...run.crew(), fallbackChain: "renamed" } }
		run.clock.now += 10 * 60_000
		await run.check()
		expect(run.crew()).toEqual(crewOn("main", { fallbackChain: "renamed" }))
		expect(run.store.size).toBe(0)
	})

	test("turning the switch off stops the switch back", async () => {
		const run = fake(crewOn("main"), { minutes: 10 })
		await run.retry(refusal("child", "general", "main/opus"))
		const root = run.sessions.root as Session
		root.metadata = { [KEY]: { ...crewOn("backup"), fallbackChain: false } }
		run.clock.now += 10 * 60_000
		await run.check()
		expect(run.crew().preset).toBe("backup")
		expect(run.store.size).toBe(0)
	})
})

describe("plugin", () => {
	const data = process.env.XDG_DATA_HOME
	afterAll(() => {
		if (data === undefined) delete process.env.XDG_DATA_HOME
		else process.env.XDG_DATA_HOME = data
	})

	test("registers the retry hook only with a fallback map", async () => {
		process.env.XDG_DATA_HOME = "/tmp/opencode/crew-test"
		for (const [options, expected] of [
			[{}, ["context"]],
			[{ presets, fallback: chains }, ["context", "retry"]],
		] as const) {
			const names: string[] = []
			const run = fake(crewOn("main"))
			const ctx: ServerContext = {
				...run.ctx,
				options,
				session: { ...run.ctx.session, hook: async (name) => void names.push(name) },
			}
			const cleanup = await plugin.setup(ctx)
			expect(names).toEqual([...expected])
			if (typeof cleanup === "function") cleanup()
		}
	})
})
