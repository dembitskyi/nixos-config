// `/crew` terminal side (OpenCode V2 CLI plugin): lists the session's subagents
// with their access and model, and changes them for this session tree only,
// along with the Away switch for working without the user. Named presets come
// from the Nix `crewPresets` option; agents in `managed` are started by another
// plugin, so they get a model and, when they name their tools, an On/Off switch.
// A preset's entry for the root session's agent also switches the root session's
// model, and the prompt's pending model choice when the root session is shown.
// The Fallback switch lets the server move the crew to a fallback preset when
// its provider refuses; picking a preset or Reset ends a fallback.
import {
	type Access,
	type AgentInfo,
	access,
	applyPreset,
	type Crew,
	chainText,
	effect,
	emptyCrew,
	type Fallbacks,
	fallbackOn,
	fallbackText,
	formatModel,
	KEY,
	type Managed,
	type ModelRef,
	modelOf,
	type Presets,
	parseModel,
	type Rule,
	readCrew,
	readFallbacks,
	readManaged,
	readPresets,
	withCrew,
	withRules,
} from "./policy"

type LocationRef = Record<string, unknown>

interface SelectOption<Value> {
	title: string
	value: Value
	description?: string
	category?: string
}

interface ModelInfo {
	id: string
	providerID: string
	name: string
	enabled: boolean
	status: string
	capabilities?: { tools: boolean }
	variants: readonly { id: string }[]
}

interface ModelChoice {
	providerID: string
	modelID: string
	variant?: string
}

export interface SessionInfo {
	agent?: string
	model?: ModelRef
	metadata?: Record<string, unknown>
	permissions?: Rule[]
}

interface SessionEvents {
	"session.metadata.updated": { sessionID: string; metadata?: Record<string, unknown> }
	"session.deleted": { sessionID: string }
}

export interface TuiContext {
	readonly options: Readonly<Record<string, unknown>>
	readonly location: LocationRef | undefined
	readonly client: {
		session: {
			get(input: { sessionID: string }): Promise<SessionInfo>
			update(input: { sessionID: string; metadata?: Record<string, unknown>; permissions?: Rule[] }): Promise<unknown>
			switchModel?(input: { sessionID: string; model: ModelRef }): Promise<unknown>
		}
		agent: { list(input: { location: LocationRef }): Promise<{ data: AgentInfo[] }> }
		model: { list(input: { location: LocationRef }): Promise<{ data: ModelInfo[] }> }
	}
	readonly data: {
		location: { default(): LocationRef }
		session: { root(sessionID: string): string }
		on?<Type extends keyof SessionEvents>(
			type: Type,
			handler: (event: { data: SessionEvents[Type] }) => void,
		): () => void
	}
	readonly keymap: {
		layer(
			factory: () => {
				mode?: string
				commands: {
					id: string
					title: string
					description?: string
					group?: string
					palette?: true
					slash?: { name: string }
					run(): void
				}[]
			},
		): void
	}
	readonly ui: {
		router: { current(): { type: string; sessionID?: string } }
		dialog: {
			select<Value>(options: {
				title: string
				placeholder?: string
				options: SelectOption<Value>[]
				current?: Value
			}): Promise<Value | undefined>
		}
		toast: { show(input: { message: string; variant?: "info" | "success" | "warning" | "error" }): void }
		// Selecting the prompt's model needs nixos-config/patches/opencode-plugin-model-set.diff; older clients only read it.
		model?: { set?(model: ModelChoice): boolean }
		slot(input: { append: string; render: () => null }): unknown
	}
}

interface State {
	crew: Crew
	session: SessionInfo
	agents: AgentInfo[]
	// Subagents another plugin starts (not the subagent tool), by ID.
	managed: Managed
}

/** Automatic fallback settings from the Nix options. */
export interface FallbackOptions {
	fallbacks: Fallbacks
	minutes: number
	byDefault: boolean
}

const NO_FALLBACK: FallbackOptions = { fallbacks: {}, minutes: 30, byDefault: false }

export function readFallbackOptions(options: Readonly<Record<string, unknown>>): FallbackOptions {
	const minutes = options.fallbackMinutes
	return {
		fallbacks: readFallbacks(options.fallback),
		minutes: typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? minutes : 30,
		byDefault: options.fallbackDefault === true,
	}
}

interface Change {
	crew: Crew
	summary: string
	// The model the root session switches to, from a preset's entry for its agent.
	root?: ModelRef
}

type Choice =
	| { kind: "agent"; id: string }
	| { kind: "all"; delegation: Access }
	| { kind: "preset" }
	| { kind: "away" }
	| { kind: "fallback" }
	| { kind: "reset" }

function members(agents: readonly AgentInfo[]) {
	return agents
		.filter((agent) => agent.mode !== "primary" && !agent.hidden)
		.toSorted((a, b) => a.id.localeCompare(b.id))
}

function isOn(state: State, agent: AgentInfo) {
	const own = state.agents.find((caller) => caller.id === state.session.agent)?.permissions ?? []
	const rules = [...own, ...withRules(state.session.permissions, state.crew, state.managed)]
	const tools = state.managed[agent.id]?.tools
	if (tools) return effect(rules, tools, "*") !== "deny"
	return access(rules, agent.id) !== "deny"
}

/** A member's line in the main dialog. */
function memberText(state: State, agent: AgentInfo) {
	const info = state.managed[agent.id]
	const on = isOn(state, agent)
	if (info?.tools) return on ? `on · ${info.label} · ${modelText(state, agent)}` : `off · ${info.label}`
	if (info) return `${info.label} · ${modelText(state, agent)}`
	return on ? `on · ${modelText(state, agent)}` : "off"
}

function modelText(state: State, agent: AgentInfo) {
	const inherited = state.session.model && formatModel(state.session.model)
	const { model, source } = modelOf(agent, state.crew, inherited)
	const shown = model ?? "caller's model"
	return source === "configured" ? shown : `${shown} (${source === "user" ? "set" : "inherited"})`
}

async function chooseModel(context: TuiContext, location: LocationRef, agent: string) {
	const { data } = await context.client.model.list({ location })
	const model = await context.ui.dialog.select({
		title: `Model for ${agent}`,
		placeholder: "Search models",
		options: data
			.filter((model) => model.enabled && model.capabilities?.tools !== false && model.status !== "deprecated")
			.map((model) => ({
				title: model.name,
				value: model,
				description: `${model.providerID}/${model.id}`,
				category: model.providerID,
			})),
	})
	if (!model) return undefined
	const ref = `${model.providerID}/${model.id}`
	if (model.variants.length === 0) return ref
	const variant = await context.ui.dialog.select({
		title: `Variant for ${model.name}`,
		options: [
			{ title: "Default", value: "" },
			...model.variants.map((variant) => ({ title: variant.id, value: variant.id })),
		],
	})
	if (variant === undefined) return undefined
	return variant ? `${ref}#${variant}` : ref
}

async function editAgent(context: TuiContext, location: LocationRef, state: State, id: string) {
	const agent = state.agents.find((agent) => agent.id === id)
	if (!agent) return undefined
	const { crew } = state
	const managed = state.managed[id]
	const switches = managed?.tools
		? [
				{ title: "On", value: "on", description: "Available in this session" },
				{ title: "Off", value: "off", description: "Hidden in this session: its tools and skill" },
			]
		: managed
			? []
			: [
					{ title: "On", value: "on", description: "Allow in this session" },
					{ title: "Off", value: "off", description: "Block in this session" },
					...(crew.access[id]
						? [{ title: "Default access", value: "access", description: "Use the configured access" }]
						: []),
				]
	const action = await context.ui.dialog.select({
		title: managed ? `${id} (${managed.label})` : id,
		current: managed && !managed.tools ? "model" : isOn(state, agent) ? "on" : "off",
		options: [
			...switches,
			{ title: "Model", value: "model", description: modelText(state, agent) },
			...(crew.models[id] ? [{ title: "Default model", value: "unset", description: "Use the configured model" }] : []),
		],
	})
	switch (action) {
		case "on":
		case "off": {
			// On for a managed member means its configured access, so the entry is dropped.
			const { [id]: _, ...rest } = crew.access
			const value: Access = action === "on" ? "allow" : "deny"
			const next = managed?.tools && action === "on" ? rest : { ...crew.access, [id]: value }
			return { crew: { ...crew, access: next }, summary: `${id} ${action}` } satisfies Change
		}
		case "access": {
			const { [id]: _, ...rest } = crew.access
			return { crew: { ...crew, access: rest }, summary: `${id} access reset` } satisfies Change
		}
		case "model": {
			const model = await chooseModel(context, location, id)
			if (!model) return undefined
			return {
				crew: { ...crew, models: { ...crew.models, [id]: model }, preset: undefined, fallback: undefined },
				summary: `${id} → ${model}`,
			} satisfies Change
		}
		case "unset": {
			const { [id]: _, ...rest } = crew.models
			return {
				crew: { ...crew, models: rest, preset: undefined, fallback: undefined },
				summary: `${id} model reset`,
			} satisfies Change
		}
		default:
			return undefined
	}
}

/** A preset's models, the root session's agent first. */
function presetText(preset: Record<string, string>, main: string | undefined) {
	const entries = Object.entries(preset)
	const root = entries.filter(([agent]) => agent === main).map(([agent, model]) => `${agent} (main)=${model}`)
	const rest = entries.filter(([agent]) => agent !== main).map(([agent, model]) => `${agent}=${model}`)
	return [...root, ...rest].join(", ")
}

/** What the Fallback switch does for the crew now. */
function fallbackState(crew: Crew, fallback: FallbackOptions) {
	const active = fallbackText(crew, fallback.minutes)
	if (active) return active
	if (!crew.preset) return "pick a preset to fall back from"
	return chainText(fallback.fallbacks, crew.preset) ?? `no fallback for ${crew.preset}`
}

/** Returns the change to apply, or undefined when the dialog was dismissed. */
async function edit(
	context: TuiContext,
	location: LocationRef,
	state: State,
	presets: Presets,
	fallback: FallbackOptions,
): Promise<Change | undefined> {
	const { crew } = state
	const autoFallback = fallbackOn(crew, fallback.byDefault)
	const choice = await context.ui.dialog.select<Choice>({
		title: "Crew",
		options: [
			...members(state.agents).map((agent) => ({
				title: agent.id,
				value: { kind: "agent", id: agent.id } as Choice,
				description: memberText(state, agent),
				category: "Subagents",
			})),
			{
				title: "All on",
				value: { kind: "all", delegation: "allow" },
				description: "Allow every subagent",
				category: "Session",
			},
			{
				title: "All off",
				value: { kind: "all", delegation: "deny" },
				description: "Hide the subagent tool",
				category: "Session",
			},
			...(Object.keys(presets).length > 0
				? [
						{
							title: "Preset",
							value: { kind: "preset" } as Choice,
							description: fallbackText(crew, fallback.minutes) ?? crew.preset ?? "None",
							category: "Session",
						},
					]
				: []),
			{
				title: "Away",
				value: { kind: "away" },
				description: crew.away ? "On: no questions, approvals granted" : "Off",
				category: "Session",
			},
			...(Object.keys(fallback.fallbacks).length > 0
				? [
						{
							title: "Fallback",
							value: { kind: "fallback" } as Choice,
							description: autoFallback ? `On: ${fallbackState(crew, fallback)}` : "Off",
							category: "Session",
						},
					]
				: []),
			{
				title: "Reset",
				value: { kind: "reset" },
				description: "Back to the configured defaults; the main session keeps its model",
				category: "Session",
			},
		],
	})

	switch (choice?.kind) {
		case "agent":
			return editAgent(context, location, state, choice.id)
		case "all":
			return {
				crew: {
					...crew,
					delegation: choice.delegation,
					access: Object.fromEntries(Object.entries(crew.access).filter(([agent]) => state.managed[agent])),
				},
				summary: choice.delegation === "allow" ? "all on" : "all off",
			} satisfies Change
		case "preset": {
			const main = state.session.agent
			const name = await context.ui.dialog.select({
				title: "Preset",
				current: crew.preset,
				options: Object.entries(presets).map(([name, preset]) => ({
					title: name,
					value: name,
					description: presetText(preset, main),
				})),
			})
			if (!name) return undefined
			const preset = presets[name]
			const root = main ? preset[main] : undefined
			return {
				crew: applyPreset(crew, name, preset),
				summary: root ? `preset ${name}, ${main} → ${root}` : `preset ${name}`,
				root: root ? parseModel(root) : undefined,
			} satisfies Change
		}
		case "away":
			return {
				crew: { ...crew, away: crew.away ? undefined : true },
				summary: crew.away ? "away off" : "away on: no questions, approvals granted",
			} satisfies Change
		case "fallback":
			// Off ends a running fallback where it is: the crew stays on its current preset.
			return {
				crew: { ...crew, autoFallback: !autoFallback, fallback: undefined },
				summary: autoFallback ? "fallback off" : `fallback on: ${fallbackState(crew, fallback)}`,
			} satisfies Change
		case "reset":
			return { crew: emptyCrew(), summary: "reset" } satisfies Change
		default:
			return undefined
	}
}

/** Throws unless the root session can switch to `model`, so nothing is applied in vain. */
async function checkModel(context: TuiContext, location: LocationRef, model: ModelRef) {
	const ref = formatModel(model)
	if (!context.client.session.switchModel) throw new Error(`this OpenCode cannot switch the session to ${ref}`)
	const { data } = await context.client.model.list({ location })
	const info = data.find((item) => item.providerID === model.providerID && item.id === model.id)
	if (!info?.enabled) throw new Error(`${model.providerID}/${model.id} is not available`)
	if (model.variant && !info.variants.some((variant) => variant.id === model.variant))
		throw new Error(`${info.name} has no variant ${model.variant}`)
}

/**
 * Points the prompt at `model` when it shows the root session: its pending choice
 * otherwise wins over the session's model and would switch it back on submit.
 * Returns a warning when the prompt could not follow, including when another
 * session is on screen, since the root's prompt may still hold an older choice.
 */
function followPrompt(context: TuiContext, root: string, model: ModelRef) {
	const ref = formatModel(model)
	const route = context.ui.router.current()
	if (route.type !== "session" || route.sessionID !== root)
		return `open the main session and check that its prompt shows ${ref}`
	if (!context.ui.model?.set) return `this OpenCode cannot update the prompt, so select ${ref} there too`
	const selected = context.ui.model.set({ providerID: model.providerID, modelID: model.id, variant: model.variant })
	return selected ? undefined : `the prompt could not select ${ref}, so select it there too`
}

// The fallback state last seen per root, kept only while a fallback runs, so the
// server's switches are announced once.
const seen = new Map<string, string>()

function remember(sessionID: string, crew: Crew) {
	const previous = seen.get(sessionID)
	const key = crew.fallback ? `${crew.preset}@${crew.fallback.since}` : undefined
	if (key) seen.set(sessionID, key)
	else seen.delete(sessionID)
	return { previous, key }
}

/** Announces the server moving a crew to a fallback preset or back home. */
export function watch(context: TuiContext, minutes: number) {
	const stops = [
		context.data.on?.("session.metadata.updated", (event) => {
			const crew = readCrew(event.data.metadata?.[KEY])
			const { previous, key } = remember(event.data.sessionID, crew)
			if (previous === key) return
			const text = fallbackText(crew, minutes)
			// A root not seen before is only announced when its fallback just started.
			if (text && crew.fallback && (previous || Date.now() - crew.fallback.since < 120_000))
				context.ui.toast.show({ message: `Crew: ${text}`, variant: "warning" })
			else if (!text && previous && crew.preset)
				context.ui.toast.show({ message: `Crew: back on ${crew.preset}`, variant: "info" })
		}),
		context.data.on?.("session.deleted", (event) => void seen.delete(event.data.sessionID)),
	]
	return () => {
		for (const stop of stops) stop?.()
	}
}

export async function open(
	context: TuiContext,
	presets: Presets,
	managed: Managed,
	fallback: FallbackOptions = NO_FALLBACK,
) {
	const route = context.ui.router.current()
	if (route.type !== "session" || !route.sessionID) {
		context.ui.toast.show({ message: "Open a session first.", variant: "warning" })
		return
	}
	const root = context.data.session.root(route.sessionID)
	const location = context.location ?? context.data.location.default()
	try {
		const [session, { data: agents }] = await Promise.all([
			context.client.session.get({ sessionID: root }),
			context.client.agent.list({ location }),
		])
		const state = { crew: readCrew(session.metadata?.[KEY]), session, agents, managed }
		const change = await edit(context, location, state, presets, fallback)
		if (!change) return
		if (change.root) await checkModel(context, location, change.root)
		remember(root, change.crew)
		await context.client.session.update({
			sessionID: root,
			metadata: withCrew(session.metadata, change.crew),
			permissions: withRules(session.permissions, change.crew, managed),
		})
		if (change.root) {
			try {
				await context.client.session.switchModel?.({ sessionID: root, model: change.root })
			} catch (error) {
				context.ui.toast.show({
					message: `Crew: subagents set, but switching ${session.agent} failed: ${String(error)}`,
					variant: "error",
				})
				return
			}
			const warning = followPrompt(context, root, change.root)
			if (warning) {
				context.ui.toast.show({ message: `Crew: ${change.summary}; ${warning}`, variant: "warning" })
				return
			}
		}
		context.ui.toast.show({ message: `Crew: ${change.summary}`, variant: "success" })
	} catch (error) {
		context.ui.toast.show({ message: `Crew failed: ${String(error)}`, variant: "error" })
	}
}

export default {
	id: "crew",
	setup(context: TuiContext) {
		const presets = readPresets(context.options.presets)
		const managed = readManaged(context.options.managed)
		const fallback = readFallbackOptions(context.options)
		const stop = Object.keys(fallback.fallbacks).length > 0 ? watch(context, fallback.minutes) : undefined
		// Keymap layers need the app's keymap provider, so register from an app slot.
		context.ui.slot({
			append: "app",
			render: () => {
				context.keymap.layer(() => ({
					mode: "global",
					commands: [
						{
							id: "crew.open",
							title: "Crew",
							description: "Subagents and their models for this session",
							group: "Session",
							palette: true,
							slash: { name: "crew" },
							run: () => void open(context, presets, managed, fallback),
						},
					],
				}))
				return null
			},
		})
		return stop
	},
}
