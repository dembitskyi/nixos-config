import { describe, expect, test } from "bun:test"

import { type AgentInfo, KEY, type ModelRef, type Presets, type Rule } from "./policy"
import { open, type SessionInfo, type TuiContext } from "./tui"

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
