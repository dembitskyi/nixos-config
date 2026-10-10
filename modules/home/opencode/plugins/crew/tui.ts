// `/crew` terminal side (OpenCode V2 CLI plugin): lists the session's subagents
// with their access and model, and changes them for this session tree only,
// along with the Away switch for working without the user. Named presets come
// from the Nix `crewPresets` option; agents in `managed` are started by another
// plugin, so they get a model and, when they name their tools, an On/Off switch.
import {
	type Access,
	type AgentInfo,
	access,
	applyPreset,
	type Crew,
	effect,
	emptyCrew,
	formatModel,
	KEY,
	type Managed,
	type ModelRef,
	modelOf,
	type Presets,
	type Rule,
	readCrew,
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

interface SessionInfo {
	agent?: string
	model?: ModelRef
	metadata?: Record<string, unknown>
	permissions?: Rule[]
}

interface TuiContext {
	readonly options: Readonly<Record<string, unknown>>
	readonly location: LocationRef | undefined
	readonly client: {
		session: {
			get(input: { sessionID: string }): Promise<SessionInfo>
			update(input: { sessionID: string; metadata?: Record<string, unknown>; permissions?: Rule[] }): Promise<unknown>
		}
		agent: { list(input: { location: LocationRef }): Promise<{ data: AgentInfo[] }> }
		model: { list(input: { location: LocationRef }): Promise<{ data: ModelInfo[] }> }
	}
	readonly data: {
		location: { default(): LocationRef }
		session: { root(sessionID: string): string }
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

interface Change {
	crew: Crew
	summary: string
}

type Choice =
	| { kind: "agent"; id: string }
	| { kind: "all"; delegation: Access }
	| { kind: "preset" }
	| { kind: "away" }
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
				crew: { ...crew, models: { ...crew.models, [id]: model }, preset: undefined },
				summary: `${id} → ${model}`,
			} satisfies Change
		}
		case "unset": {
			const { [id]: _, ...rest } = crew.models
			return { crew: { ...crew, models: rest, preset: undefined }, summary: `${id} model reset` } satisfies Change
		}
		default:
			return undefined
	}
}

/** Returns the change to apply, or undefined when the dialog was dismissed. */
async function edit(context: TuiContext, location: LocationRef, state: State, presets: Presets) {
	const { crew } = state
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
							description: crew.preset ?? "None",
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
			{ title: "Reset", value: { kind: "reset" }, description: "Back to the configured defaults", category: "Session" },
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
			const name = await context.ui.dialog.select({
				title: "Preset",
				current: crew.preset,
				options: Object.entries(presets).map(([name, preset]) => ({
					title: name,
					value: name,
					description: Object.entries(preset)
						.map(([agent, model]) => `${agent}=${model}`)
						.join(", "),
				})),
			})
			if (!name) return undefined
			return { crew: applyPreset(crew, name, presets[name]), summary: `preset ${name}` } satisfies Change
		}
		case "away":
			return {
				crew: { ...crew, away: crew.away ? undefined : true },
				summary: crew.away ? "away off" : "away on: no questions, approvals granted",
			} satisfies Change
		case "reset":
			return { crew: emptyCrew(), summary: "reset" } satisfies Change
		default:
			return undefined
	}
}

async function open(context: TuiContext, presets: Presets, managed: Managed) {
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
		const change = await edit(context, location, state, presets)
		if (!change) return
		await context.client.session.update({
			sessionID: root,
			metadata: withCrew(session.metadata, change.crew),
			permissions: withRules(session.permissions, change.crew, managed),
		})
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
							run: () => void open(context, presets, managed),
						},
					],
				}))
				return null
			},
		})
	},
}
