import { describe, expect, test } from "bun:test"

import { type AgentInfo, KEY, type ModelRef, type Presets, type Rule } from "./policy"
import { type FallbackOptions, open, type SessionInfo, type TuiContext, watch } from "./tui"

type Select = TuiContext["ui"]["dialog"]["select"]
type Toast = { message: string; variant?: string }
type Choice = { providerID: string; modelID: string; variant?: string }

const agents: AgentInfo[] = [
	{ id: "dev", mode: "primary" },
	{ id: "general", mode: "subagent" },
	{ id: "explore", mode: "subagent" },
]

const model = (id: string, variants: string[] = [], enabled = true) => ({
	id,
	providerID: "acme",
	name: id,
	enabled,
	status: "active",
	variants: variants.map((id) => ({ id })),
})

const models = [model("opus", ["max", "low"]), model("sonnet"), model("haiku", ["low"]), model("off", [], false)]

const presets: Presets = {
	deep: { dev: "acme/opus#max", general: "acme/sonnet", explore: "acme/haiku#low" },
	plain: { dev: "acme/opus", general: "acme/haiku" },
	legacy: { general: "acme/haiku#low" },
	missing: { dev: "acme/gone", general: "acme/sonnet" },
	variant: { dev: "acme/sonnet#max" },
	disabled: { dev: "acme/off" },
}

const bash: Rule = { action: "bash", resource: "git *", effect: "allow" }
const offExplore: Rule = { action: "subagent", resource: "explore", effect: "deny" }

function rootSession(): SessionInfo {
	return {
		agent: "dev",
		model: { providerID: "acme", id: "sonnet" },
		metadata: {
			title: "keep",
			[KEY]: { delegation: "default", access: { explore: "deny" }, models: { general: "acme/opus" }, away: true },
		},
		permissions: [bash, offExplore],
	}
}

/** Picks the preset row in the main dialog, then `preset` (undefined cancels). */
function pick(preset: string | undefined, during?: () => void): Select {
	return async (options) => {
		if (options.title === "Crew")
			return options.options.find((option) => (option.value as { kind: string }).kind === "preset")?.value
		during?.()
		return preset as never
	}
}

function fake(input: {
	select: Select
	route?: string
	session?: SessionInfo
	setter?: boolean
	switchModel?: false | ((model: ModelRef) => Promise<unknown>)
}) {
	const route = { current: input.route ?? "root" }
	// The prompt's pending choice per shown session, as the host keeps it.
	const prompt: Record<string, Choice> = {
		root: { providerID: "acme", modelID: "haiku" },
		child: { providerID: "acme", modelID: "sonnet" },
	}
	const updates: { sessionID: string; metadata?: Record<string, unknown>; permissions?: Rule[] }[] = []
	const switches: { sessionID: string; model: ModelRef }[] = []
	const toasts: Toast[] = []
	const set = (choice: Choice) => {
		const info = models.find((item) => item.providerID === choice.providerID && item.id === choice.modelID)
		if (!info) return false
		if (choice.variant !== undefined && !info.variants.some((item) => item.id === choice.variant)) return false
		prompt[route.current] = { ...choice }
		return true
	}
	const fail = input.switchModel || undefined
	const switchModel =
		input.switchModel === false
			? undefined
			: async (request: { sessionID: string; model: ModelRef }) => {
					switches.push(request)
					await fail?.(request.model)
				}
	const context: TuiContext = {
		options: {},
		location: { directory: "/work" },
		client: {
			session: {
				get: async ({ sessionID }) => (sessionID === "root" ? (input.session ?? rootSession()) : { agent: "general" }),
				update: async (request) => {
					updates.push(request)
				},
				switchModel,
			},
			agent: { list: async () => ({ data: agents }) },
			model: { list: async () => ({ data: models }) },
		},
		data: {
			location: { default: () => ({ directory: "/work" }) },
			session: { root: () => "root" },
		},
		keymap: { layer() {} },
		ui: {
			router: { current: () => ({ type: "session", sessionID: route.current }) },
			dialog: { select: input.select },
			toast: { show: (toast) => toasts.push(toast) },
			slot: () => undefined,
			...(input.setter === false ? {} : { model: { set } }),
		},
	}
	return { context, route, prompt, updates, switches, toasts }
}

describe("presets", () => {
	test("switch the root session and the prompt to the preset's model for its agent", async () => {
		const run = fake({ select: pick("deep") })
		await open(run.context, presets, {})

		expect(run.updates).toHaveLength(1)
		expect(run.updates[0]?.sessionID).toBe("root")
		expect(run.updates[0]?.metadata).toEqual({
			title: "keep",
			[KEY]: {
				delegation: "default",
				access: { explore: "deny" },
				models: { dev: "acme/opus#max", general: "acme/sonnet", explore: "acme/haiku#low" },
				preset: "deep",
				away: true,
			},
		})
		expect(run.updates[0]?.permissions).toEqual([
			bash,
			offExplore,
			{ action: "skill", resource: "crew-explore", effect: "deny" },
		])
		expect(run.switches).toEqual([{ sessionID: "root", model: { providerID: "acme", id: "opus", variant: "max" } }])
		expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "opus", variant: "max" })
		expect(run.toasts).toEqual([{ message: "Crew: preset deep, dev → acme/opus#max", variant: "success" }])
	})

	test("select the model default when the preset names no variant", async () => {
		const run = fake({ select: pick("plain") })
		run.prompt.root = { providerID: "acme", modelID: "opus", variant: "max" }
		await open(run.context, presets, {})

		expect(run.switches).toEqual([{ sessionID: "root", model: { providerID: "acme", id: "opus" } }])
		expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "opus", variant: undefined })
		expect(run.toasts.at(-1)?.variant).toBe("success")
	})

	test("without an entry for the root's agent leave its model alone", async () => {
		const run = fake({ select: pick("legacy") })
		await open(run.context, presets, {})

		expect(run.updates[0]?.metadata?.[KEY]).toMatchObject({ models: { general: "acme/haiku#low" }, preset: "legacy" })
		expect(run.switches).toEqual([])
		expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "haiku" })
		expect(run.toasts).toEqual([{ message: "Crew: preset legacy", variant: "success" }])
	})

	test("change nothing when the picker is dismissed", async () => {
		for (const select of [pick(undefined), (async () => undefined) as Select]) {
			const run = fake({ select })
			await open(run.context, presets, {})
			expect(run.updates).toEqual([])
			expect(run.switches).toEqual([])
			expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "haiku" })
			expect(run.toasts).toEqual([])
		}
	})

	test("from a child session switch the root but not the child's prompt", async () => {
		const run = fake({ select: pick("deep"), route: "child" })
		await open(run.context, presets, {})

		expect(run.updates[0]?.sessionID).toBe("root")
		expect(run.switches).toEqual([{ sessionID: "root", model: { providerID: "acme", id: "opus", variant: "max" } }])
		expect(run.prompt.child).toEqual({ providerID: "acme", modelID: "sonnet" })
		expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "haiku" })
		expect(run.toasts.at(-1)).toEqual({
			message:
				"Crew: preset deep, dev → acme/opus#max; open the main session and check that its prompt shows acme/opus#max",
			variant: "warning",
		})
	})

	test("leave the prompt alone when another session is shown by the time the preset is picked", async () => {
		const run = fake({ select: pick("deep", () => (run.route.current = "child")) })
		await open(run.context, presets, {})

		expect(run.switches).toHaveLength(1)
		expect(run.prompt.child).toEqual({ providerID: "acme", modelID: "sonnet" })
		expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "haiku" })
	})

	test("apply nothing when the root's model or variant is unavailable", async () => {
		for (const name of ["missing", "variant", "disabled"]) {
			const run = fake({ select: pick(name) })
			await open(run.context, presets, {})
			expect(run.updates).toEqual([])
			expect(run.switches).toEqual([])
			expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "haiku" })
			expect(run.toasts).toHaveLength(1)
			expect(run.toasts[0]?.variant).toBe("error")
		}
	})

	test("apply nothing when the client cannot switch the session's model", async () => {
		const run = fake({ select: pick("deep"), switchModel: false })
		await open(run.context, presets, {})
		expect(run.updates).toEqual([])
		expect(run.toasts[0]?.variant).toBe("error")
		expect(run.toasts[0]?.message).toContain("cannot switch")
	})

	test("report a failed switch instead of success", async () => {
		const run = fake({
			select: pick("deep"),
			switchModel: async () => {
				throw new Error("boom")
			},
		})
		await open(run.context, presets, {})

		expect(run.updates).toHaveLength(1)
		expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "haiku" })
		expect(run.toasts).toHaveLength(1)
		expect(run.toasts[0]?.variant).toBe("error")
		expect(run.toasts[0]?.message).toContain("boom")
	})

	test("warn when the prompt cannot follow", async () => {
		const run = fake({ select: pick("deep"), setter: false })
		await open(run.context, presets, {})

		expect(run.switches).toHaveLength(1)
		expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "haiku" })
		expect(run.toasts).toHaveLength(1)
		expect(run.toasts[0]?.variant).toBe("warning")
		expect(run.toasts[0]?.message).toContain("select acme/opus#max there")
	})

	test("warn when the prompt refuses the model", async () => {
		const run = fake({ select: pick("deep") })
		const ui = run.context.ui as { model?: { set?(model: Choice): boolean } }
		ui.model = { set: () => false }
		await open(run.context, presets, {})

		expect(run.switches).toHaveLength(1)
		expect(run.toasts.at(-1)?.variant).toBe("warning")
	})

	test("reset keeps the root session's model", async () => {
		const run = fake({
			select: async (options) =>
				options.options.find((option) => (option.value as { kind: string }).kind === "reset")?.value,
		})
		await open(run.context, presets, {})

		expect(run.updates[0]?.metadata).toEqual({ title: "keep" })
		expect(run.updates[0]?.permissions).toEqual([bash])
		expect(run.switches).toEqual([])
		expect(run.prompt.root).toEqual({ providerID: "acme", modelID: "haiku" })
	})

	test("describe the root's entry first in the picker", async () => {
		let descriptions: (string | undefined)[] = []
		const run = fake({
			select: async (options) => {
				if (options.title === "Crew")
					return options.options.find((option) => (option.value as { kind: string }).kind === "preset")?.value
				descriptions = options.options.map((option) => option.description)
				return undefined
			},
		})
		await open(run.context, { mixed: { general: "acme/sonnet", dev: "acme/opus#max" } }, {})
		expect(descriptions).toEqual(["dev (main)=acme/opus#max, general=acme/sonnet"])
	})
})

describe("fallback", () => {
	const fallback: FallbackOptions = {
		chains: {
			stepped: {
				deep: { quota: "plain", auth: "plain", network: "legacy" },
				plain: { quota: "legacy", auth: "legacy", network: "legacy" },
			},
			direct: { deep: { quota: "legacy", auth: "legacy", network: "legacy" } },
		},
		minutes: 30,
	}
	const since = new Date(2026, 10, 4, 14, 5).getTime()
	const crewOf = (fields: Record<string, unknown>) => ({ delegation: "default", access: {}, models: {}, ...fields })
	const inFallback = (): SessionInfo => ({
		...rootSession(),
		metadata: {
			[KEY]: crewOf({
				models: { ...presets.plain },
				preset: "plain",
				fallbackChain: "stepped",
				fallback: { home: "deep", reasons: ["quota"], since, visited: ["deep", "plain"] },
			}),
		},
	})
	const withMetadata = (fields: Record<string, unknown>): SessionInfo => ({
		...rootSession(),
		metadata: { [KEY]: crewOf(fields) },
	})
	const choose =
		(kind: string, then?: (options: Parameters<Select>[0]) => unknown): Select =>
		async (options) => {
			if (options.title === "Crew")
				return options.options.find((option) => (option.value as { kind: string }).kind === kind)?.value
			return then?.(options) as never
		}
	const rows = async (session: SessionInfo | undefined, options = fallback) => {
		let shown: Record<string, string | undefined> = {}
		const run = fake({
			session,
			select: async (input) => {
				shown = Object.fromEntries(input.options.map((option) => [option.title, option.description]))
				return undefined
			},
		})
		await open(run.context, presets, {}, options)
		return shown
	}
	/** The Fallback picker's rows for `session`, and the value it marks as current. */
	const picker = async (session: SessionInfo, options = fallback) => {
		let shown: Record<string, string | undefined> = {}
		let current: unknown
		const run = fake({
			session,
			select: choose("fallback", (input) => {
				shown = Object.fromEntries(input.options.map((option) => [option.title, option.description]))
				current = input.current
				return undefined
			}),
		})
		await open(run.context, presets, {}, options)
		return { shown, current }
	}

	test("is hidden without chains", async () => {
		expect(await rows(undefined, { ...fallback, chains: {} })).not.toHaveProperty("Fallback")
	})

	test("is off by default and shows the selected chain's route", async () => {
		expect((await rows(undefined)).Fallback).toBe("Off")
		expect((await rows(withMetadata({ preset: "deep", fallbackChain: "stepped" }))).Fallback).toBe(
			"stepped: deep → plain (quota, token), legacy (network); plain → legacy",
		)
		expect((await rows(withMetadata({ preset: "plain", fallbackChain: "direct" }))).Fallback).toBe(
			"direct: no fallback from plain",
		)
		expect((await rows(rootSession(), { ...fallback, defaultChain: "direct" })).Fallback).toBe(
			"direct: pick a preset to fall back from",
		)
	})

	test("an earlier on switch shows as the default or first chain", async () => {
		const legacy = withMetadata({ preset: "deep", autoFallback: true })
		expect((await rows(legacy)).Fallback).toBe("direct: deep → legacy")
		expect((await rows(legacy, { ...fallback, defaultChain: "stepped" })).Fallback).toStartWith("stepped: ")
		expect((await rows(withMetadata({ autoFallback: false }), { ...fallback, defaultChain: "stepped" })).Fallback).toBe(
			"Off",
		)
	})

	test("an unknown chain shows as off", async () => {
		expect((await rows(withMetadata({ preset: "deep", fallbackChain: "removed" }))).Fallback).toBe("Off")
	})

	test("shows a running fallback with its times", async () => {
		const shown = await rows(inFallback())
		const at = (time: number) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
		const text = `plain — fallback from deep (quota) at ${at(since)}, back at ${at(since + 30 * 60_000)}`
		expect(shown.Preset).toBe(text)
		expect(shown.Fallback).toBe(text)
	})

	test("the picker offers Off and each chain's route from the current preset", async () => {
		const { shown, current } = await picker(withMetadata({ preset: "deep", fallbackChain: "direct" }))
		expect(shown).toEqual({
			Off: "Stay on the current preset when a provider refuses",
			direct: "deep → legacy",
			stepped: "deep → plain (quota, token), legacy (network); plain → legacy",
		})
		expect(current).toBe("direct")
		const plain = await picker(withMetadata({ preset: "plain" }))
		expect(plain.shown.direct).toBe("no fallback from plain")
		expect(plain.current).toBe("")
	})

	test("choosing a chain keeps the rest of the crew", async () => {
		const run = fake({ select: choose("fallback", () => "stepped") })
		await open(run.context, presets, {}, fallback)
		expect(run.updates[0]?.metadata?.[KEY]).toEqual({
			delegation: "default",
			access: { explore: "deny" },
			models: { general: "acme/opus" },
			away: true,
			fallbackChain: "stepped",
		})
		expect(run.switches).toEqual([])
		expect(run.toasts.at(-1)?.message).toBe("Crew: fallback stepped: pick a preset to fall back from")
	})

	test("choosing the default chain stores no choice", async () => {
		const run = fake({
			select: choose("fallback", () => "stepped"),
			session: withMetadata({ fallbackChain: "direct" }),
		})
		await open(run.context, presets, {}, { ...fallback, defaultChain: "stepped" })
		expect(run.updates[0]?.metadata?.[KEY]).not.toHaveProperty("fallbackChain")
	})

	test("changing the chain keeps a running fallback", async () => {
		const run = fake({ select: choose("fallback", () => "direct"), session: inFallback() })
		await open(run.context, presets, {}, fallback)
		expect(run.updates[0]?.metadata?.[KEY]).toMatchObject({
			preset: "plain",
			fallbackChain: "direct",
			fallback: { home: "deep", since },
		})
	})

	test("Off leaves the current preset and ends the fallback", async () => {
		const run = fake({ select: choose("fallback", () => ""), session: inFallback() })
		await open(run.context, presets, {}, fallback)
		expect(run.updates[0]?.metadata?.[KEY]).toEqual(crewOf({ models: { ...presets.plain }, preset: "plain" }))
		expect(run.toasts.at(-1)?.message).toBe("Crew: fallback off")

		const kept = fake({ select: choose("fallback", () => ""), session: inFallback() })
		await open(kept.context, presets, {}, { ...fallback, defaultChain: "stepped" })
		expect(kept.updates[0]?.metadata?.[KEY]).toMatchObject({ fallbackChain: false })
	})

	test("dismissing the picker changes nothing", async () => {
		const run = fake({ select: choose("fallback", () => undefined), session: inFallback() })
		await open(run.context, presets, {}, fallback)
		expect(run.updates).toEqual([])
	})

	test("picking a preset ends the fallback but keeps the chain", async () => {
		const run = fake({ select: choose("preset", () => "deep"), session: inFallback() })
		await open(run.context, presets, {}, fallback)
		const crew = run.updates[0]?.metadata?.[KEY] as Record<string, unknown>
		expect(crew).toMatchObject({ preset: "deep", fallbackChain: "stepped" })
		expect(crew.fallback).toBeUndefined()
	})

	test("a model edit ends the fallback", async () => {
		const run = fake({
			select: async (options) => {
				if (options.title === "Crew") return options.options.find((option) => option.title === "general")?.value
				if (options.title === "general") return "unset" as never
				return undefined
			},
			session: inFallback(),
		})
		await open(run.context, presets, {}, fallback)
		const crew = run.updates[0]?.metadata?.[KEY] as Record<string, unknown>
		expect(crew).toMatchObject({ fallbackChain: "stepped", models: { dev: "acme/opus" } })
		expect(crew.preset).toBeUndefined()
		expect(crew.fallback).toBeUndefined()
	})

	test("reset turns it off", async () => {
		const run = fake({ select: choose("reset"), session: inFallback() })
		await open(run.context, presets, {}, fallback)
		expect(run.updates[0]?.metadata).toEqual({})
	})

	test("announces the server's switches once and forgets deleted sessions", () => {
		const toasts: Toast[] = []
		const handlers: Record<string, (event: { data: never }) => void> = {}
		let stopped = 0
		const run = fake({ select: async () => undefined })
		const context: TuiContext = {
			...run.context,
			data: {
				...run.context.data,
				on: (type, callback) => {
					handlers[type] = callback as (event: { data: never }) => void
					return () => void stopped++
				},
			},
			ui: { ...run.context.ui, toast: { show: (toast) => toasts.push(toast) } },
		}
		const stop = watch(context, 30)
		const update = (sessionID: string, fallback?: unknown) =>
			handlers["session.metadata.updated"]?.({
				data: {
					sessionID,
					metadata: {
						[KEY]: { delegation: "default", access: {}, models: {}, preset: fallback ? "plain" : "deep", fallback },
					},
				} as never,
			})
		const now = { home: "deep", reasons: ["quota"], since: Date.now(), visited: ["deep", "plain"] }
		update("watched")
		update("watched", now)
		update("watched", now)
		update("watched")
		expect(toasts.map((toast) => toast.variant)).toEqual(["warning", "info"])
		expect(toasts[0]?.message).toStartWith("Crew: plain — fallback from deep (quota)")
		expect(toasts[1]?.message).toBe("Crew: back on deep")

		// An old fallback of a deleted session is not announced when an ID reappears.
		update("gone", now)
		handlers["session.deleted"]?.({ data: { sessionID: "gone" } as never })
		update("gone", { ...now, since: Date.now() - 600_000 })
		expect(toasts).toHaveLength(3)

		stop()
		expect(stopped).toBe(2)
	})
})
