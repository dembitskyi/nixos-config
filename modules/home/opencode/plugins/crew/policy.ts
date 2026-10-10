// `/crew`: per-session control of the subagents the root session may launch, the
// model each one runs on, and whether the user is away. Settings live in the root
// session's metadata under `crew`; access is enforced through that session's
// native permission rules, models are injected by the server plugin when a
// subagent is launched, and the server plugin applies the away rules. The crew's
// rules also deny the playbook skills (`crew`, `crew-<agent>`) of members that are
// off, and managed members (started by another plugin) can be switched off, which
// hides their tools and skill.

export type Access = "allow" | "deny"
export type Delegation = "default" | Access

export interface Crew {
	delegation: Delegation
	access: Record<string, Access>
	models: Record<string, string>
	preset?: string
	// The user is away: no questions, approval prompts granted, for this whole session tree.
	away?: boolean
}

export interface Rule {
	action: string
	resource: string
	effect: "allow" | "ask" | "deny"
}

export interface ModelRef {
	providerID: string
	id: string
	variant?: string
}

export interface AgentInfo {
	id: string
	mode: "subagent" | "primary" | "all"
	hidden?: boolean
	description?: string
	model?: ModelRef
	permissions?: readonly Rule[]
}

export type Presets = Record<string, Record<string, string>>

/** A member another plugin starts: its label, and optionally the tools and skill `/crew` can switch off. */
export interface ManagedInfo {
	label: string
	// Permission action pattern of its tools, e.g. `lanes_*`.
	tools?: string
	skill?: string
}

export type Managed = Record<string, ManagedInfo>
export type Source = "configured" | "inherited" | "user"

export const KEY = "crew"
export const TOOL = "subagent"
export const QUESTION = "question"
export const SKILL = "skill"
// The strategy skill for working with the crew, and the prefix of each member's playbook skill.
export const STRATEGY = "crew"
export const PLAYBOOK = "crew-"

export const AWAY_NOTE =
	"The user is away and has authorized you to keep working without them: do not stop to ask or wait for confirmation, and never end a turn on a question. Make reasonable assumptions, state them in your report, and continue. Permission prompts are approved automatically; commands the configuration denies stay blocked, so take another way when one is refused."

export const AWAY_ANSWER =
	"The user is away and cannot answer. Make a reasonable assumption, state it in your report, and continue."

const HEADER = "Available subagents:"
const UNDESCRIBED = "This subagent should only be called when explicitly requested."

// `provider/model` with an optional `#variant`, as the subagent tool expects.
const MODEL_REF = /^[^/#\s]+\/[^#\s]+(#[^#\s]+)?$/

export function isModelRef(value: unknown): value is string {
	return typeof value === "string" && MODEL_REF.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function emptyCrew(): Crew {
	return { delegation: "default", access: {}, models: {} }
}

/** Reads stored settings, dropping anything malformed instead of failing. */
export function readCrew(value: unknown): Crew {
	const crew = emptyCrew()
	if (!isRecord(value)) return crew
	if (value.delegation === "allow" || value.delegation === "deny") crew.delegation = value.delegation
	if (isRecord(value.access)) {
		for (const [agent, access] of Object.entries(value.access)) {
			if (access === "allow" || access === "deny") crew.access[agent] = access
		}
	}
	if (isRecord(value.models)) {
		for (const [agent, model] of Object.entries(value.models)) {
			if (isModelRef(model)) crew.models[agent] = model
		}
	}
	if (typeof value.preset === "string" && value.preset) crew.preset = value.preset
	if (value.away === true) crew.away = true
	return crew
}

export function isEmpty(crew: Crew) {
	return (
		crew.delegation === "default" &&
		Object.keys(crew.access).length === 0 &&
		Object.keys(crew.models).length === 0 &&
		!crew.away
	)
}

const sorted = <T>(record: Record<string, T>) => Object.entries(record).sort(([a], [b]) => a.localeCompare(b))

/** Session permission rules: the overall mode first, then per-agent exceptions and their skills. */
export function crewRules(crew: Crew, managed: Managed = {}): Rule[] {
	const off = crew.delegation === "deny"
	const rules: Rule[] =
		crew.delegation === "default"
			? []
			: [
					{ action: TOOL, resource: "*", effect: crew.delegation },
					...(off
						? [
								{ action: SKILL, resource: STRATEGY, effect: "deny" } satisfies Rule,
								{ action: SKILL, resource: `${PLAYBOOK}*`, effect: "deny" } satisfies Rule,
							]
						: []),
				]
	let strategy = false
	for (const [agent, effect] of sorted(crew.access)) {
		const info = managed[agent]
		if (info?.tools) {
			// On means the configured access: an explicit allow would leak the tools into child sessions.
			if (effect === "deny") {
				rules.push({ action: info.tools, resource: "*", effect })
				if (info.skill) rules.push({ action: SKILL, resource: info.skill, effect })
			}
			continue
		}
		rules.push({ action: TOOL, resource: agent, effect })
		// Skills are only allowed back after "All off": child sessions copy these rules.
		if (effect === "deny" || off) rules.push({ action: SKILL, resource: `${PLAYBOOK}${agent}`, effect })
		if (effect === "allow" && off) strategy = true
	}
	if (strategy) rules.push({ action: SKILL, resource: STRATEGY, effect: "allow" })
	return rules
}

function isOwned(rule: Rule, managed: Managed) {
	const infos = Object.values(managed)
	if (rule.action === TOOL || infos.some((info) => info.tools === rule.action)) return true
	if (rule.action !== SKILL) return false
	return (
		rule.resource === STRATEGY ||
		rule.resource.startsWith(PLAYBOOK) ||
		infos.some((info) => info.skill === rule.resource)
	)
}

/** The session's rules with only the crew's own ones (subagents, playbooks, managed tools) replaced. */
export function withRules(rules: readonly Rule[] | undefined, crew: Crew, managed: Managed = {}): Rule[] {
	return [...(rules ?? []).filter((rule) => !isOwned(rule, managed)), ...crewRules(crew, managed)]
}

/** Returns the session metadata with the crew stored, or removed when empty. */
export function withCrew(metadata: unknown, crew: Crew): Record<string, unknown> {
	const next: Record<string, unknown> = isRecord(metadata) ? { ...metadata } : {}
	if (isEmpty(crew)) delete next[KEY]
	else next[KEY] = crew
	return next
}

/** Reads the managed members: a label alone, or an object with a label and optional tools and skill. */
export function readManaged(value: unknown): Managed {
	if (!isRecord(value)) return {}
	const managed: Managed = {}
	for (const [agent, entry] of Object.entries(value)) {
		if (typeof entry === "string") managed[agent] = { label: entry }
		else if (isRecord(entry) && typeof entry.label === "string") {
			const info: ManagedInfo = { label: entry.label }
			if (typeof entry.tools === "string" && entry.tools) info.tools = entry.tools
			if (typeof entry.skill === "string" && entry.skill) info.skill = entry.skill
			managed[agent] = info
		}
	}
	return managed
}

export function applyPreset(crew: Crew, name: string, preset: Record<string, string>): Crew {
	const models = Object.fromEntries(Object.entries(preset).filter(([, model]) => isModelRef(model)))
	return { ...crew, models, preset: name }
}

export function readPresets(value: unknown): Presets {
	if (!isRecord(value)) return {}
	const presets: Presets = {}
	for (const [name, preset] of Object.entries(value)) {
		if (!isRecord(preset)) continue
		presets[name] = Object.fromEntries(Object.entries(preset).filter(([, model]) => isModelRef(model))) as Record<
			string,
			string
		>
	}
	return presets
}

export function formatModel(ref: ModelRef) {
	return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`
}

// OpenCode's wildcard: `*` matches anything, `?` one character, and a trailing
// ` *` also matches the bare prefix.
function matches(pattern: string, value: string) {
	let source = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")
	if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`
	return new RegExp(`^${source}$`, "s").test(value)
}

/** The effect OpenCode applies to `action` on `resource`: the last matching rule wins. */
export function effect(rules: readonly Rule[], action: string, resource: string): Rule["effect"] {
	return rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, resource))?.effect ?? "ask"
}

/** The effect OpenCode applies to launching `agent`. */
export function access(rules: readonly Rule[], agent: string): Rule["effect"] {
	return effect(rules, TOOL, agent)
}

/** Subagents that `rules` (the caller's, then its session's) let it launch. */
export function available(agents: readonly AgentInfo[], rules: readonly Rule[]) {
	return agents
		.filter((agent) => agent.mode !== "primary" && !agent.hidden && access(rules, agent.id) !== "deny")
		.toSorted((a, b) => a.id.localeCompare(b.id))
}

/** The model a launch of `agent` runs on; agents without one inherit the caller's. */
export function modelOf(agent: AgentInfo, crew: Crew, inherited?: string): { model?: string; source: Source } {
	const chosen = crew.models[agent.id]
	if (chosen) return { model: chosen, source: "user" }
	if (agent.model) return { model: formatModel(agent.model), source: "configured" }
	return { model: inherited, source: "inherited" }
}

/** Replaces the subagent tool's list with the session's subagents and their models. */
export function toolDescription(description: string, agents: readonly AgentInfo[], crew: Crew, inherited?: string) {
	const base = description.split(`\n\n${HEADER}`)[0] ?? description
	if (agents.length === 0) return base
	const lines = agents.map((agent) => {
		const { model, source } = modelOf(agent, crew, inherited)
		const origin = source === "user" ? ", set by the user" : source === "inherited" ? ", inherited" : ""
		const tag = model === undefined ? "" : ` [${model}${origin}]`
		return `- ${agent.id}${tag}: ${agent.description ?? UNDESCRIBED}`
	})
	return [base, "", HEADER, ...lines].join("\n")
}

/** System note naming the configured subagents the user turned off, if any. */
export function note(configured: readonly AgentInfo[], effective: readonly AgentInfo[]) {
	const on = new Set(effective.map((agent) => agent.id))
	const off = configured.filter((agent) => !on.has(agent.id)).map((agent) => agent.id)
	if (off.length === 0) return undefined
	if (effective.length === 0)
		return "The user turned off all subagents for this session with /crew; do the work yourself."
	return `The user turned off these subagents for this session with /crew: ${off.join(", ")}.`
}
