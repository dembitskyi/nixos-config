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
	// Automatic fallback to another preset when a provider refuses; unset means the configured default.
	autoFallback?: boolean
	fallback?: Fallback
}

/** Why a provider refused: used up quota, a rejected token, or an outage. */
export type Reason = "quota" | "auth" | "network"

/** A fallback episode: the preset it started from, the reason of each switch, when the last one happened, and the presets tried. */
export interface Fallback {
	home: string
	reasons: Reason[]
	since: number
	visited: string[]
}

/** Per preset, the preset to fall back to for each reason. */
export type Fallbacks = Record<string, Partial<Record<Reason, string>>>

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
	if (typeof value.autoFallback === "boolean") crew.autoFallback = value.autoFallback
	const fallback = readFallback(value.fallback)
	if (fallback && crew.preset) crew.fallback = fallback
	return crew
}

const REASONS: readonly Reason[] = ["quota", "auth", "network"]

function isReason(value: unknown): value is Reason {
	return REASONS.includes(value as Reason)
}

function readFallback(value: unknown): Fallback | undefined {
	if (!isRecord(value)) return undefined
	const { home, since, visited } = value
	const reasons = Array.isArray(value.reasons) ? value.reasons.filter(isReason) : []
	if (typeof home !== "string" || !home || reasons.length === 0 || typeof since !== "number") return undefined
	const names = Array.isArray(visited) ? visited.filter((name): name is string => typeof name === "string") : []
	return { home, reasons, since, visited: names.includes(home) ? names : [home, ...names] }
}

export function isEmpty(crew: Crew) {
	return (
		crew.delegation === "default" &&
		Object.keys(crew.access).length === 0 &&
		Object.keys(crew.models).length === 0 &&
		!crew.away &&
		crew.autoFallback === undefined
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
	return { ...crew, models, preset: name, fallback: undefined }
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

export function parseModel(ref: string): ModelRef | undefined {
	if (!isModelRef(ref)) return undefined
	const [path, variant] = ref.split("#")
	const slash = path.indexOf("/")
	return { providerID: path.slice(0, slash), id: path.slice(slash + 1), ...(variant ? { variant } : {}) }
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

export function readFallbacks(value: unknown): Fallbacks {
	if (!isRecord(value)) return {}
	const fallbacks: Fallbacks = {}
	for (const [name, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue
		const targets: Partial<Record<Reason, string>> = {}
		for (const reason of REASONS) {
			const target = entry[reason]
			if (typeof target === "string" && target && target !== name) targets[reason] = target
		}
		if (Object.keys(targets).length > 0) fallbacks[name] = targets
	}
	return fallbacks
}

/** Whether the root's crew falls back automatically: its own switch, else the configured default. */
export function fallbackOn(crew: Crew, byDefault = false) {
	return crew.autoFallback ?? byDefault
}

export interface RetryError {
	readonly type: string
	readonly status?: number
}

/** What a 403 means: some gateways answer it when the client is off the corporate network. */
export type Forbidden = "auth" | "network"

export function readForbidden(value: unknown): Forbidden {
	return value === "network" ? "network" : "auth"
}

/**
 * The reason a refused request may fall back, or undefined to leave it to
 * OpenCode; rate limits, stalls and other errors never fall back. `repeated`
 * marks outages that may be brief (gateway errors and overloads, transport
 * failures, timeouts, missing routes), which only fall back once they persist.
 */
export function classify(error: RetryError, forbidden: Forbidden): { reason: Reason; repeated: boolean } | undefined {
	switch (error.type) {
		case "provider.quota":
			return { reason: "quota", repeated: false }
		case "provider.auth":
			if (error.status === 401) return { reason: "auth", repeated: false }
			if (error.status === 403) return { reason: forbidden, repeated: false }
			return undefined
		case "provider.invalid-request":
			return error.status === 404 ? { reason: "network", repeated: true } : undefined
		case "provider.internal":
		case "provider.transport":
		case "provider.timeout":
			return { reason: "network", repeated: true }
		default:
			return undefined
	}
}

export function providerOf(ref: string) {
	return ref.slice(0, ref.indexOf("/"))
}

/** Whether any of the crew's models runs on `providerID`. */
export function usesProvider(crew: Crew, providerID: string) {
	return Object.values(crew.models).some((model) => providerOf(model) === providerID)
}

/** Whether the crew's running fallback left `providerID` behind: a preset it tried before uses it. */
export function leftProvider(crew: Crew, presets: Presets, providerID: string) {
	const visited = crew.fallback?.visited ?? []
	return visited
		.filter((name) => name !== crew.preset)
		.some((name) => Object.values(presets[name] ?? {}).some((model) => providerOf(model) === providerID))
}

/** The crew on its next fallback preset for `reason`, or undefined when there is none left to try. */
export function nextFallback(
	crew: Crew,
	presets: Presets,
	fallbacks: Fallbacks,
	reason: Reason,
	now: number,
): Crew | undefined {
	if (!crew.preset) return undefined
	const target = fallbacks[crew.preset]?.[reason]
	const visited = crew.fallback?.visited ?? [crew.preset]
	if (!target || visited.includes(target) || !presets[target]) return undefined
	const fallback: Fallback = {
		home: crew.fallback?.home ?? crew.preset,
		reasons: [...(crew.fallback?.reasons ?? []), reason],
		since: now,
		visited: [...visited, target],
	}
	return { ...applyPreset(crew, target, presets[target]), fallback }
}

/** The crew back on the preset its fallback started from, or undefined when that preset is gone. */
export function homeCrew(crew: Crew, presets: Presets): Crew | undefined {
	const home = crew.fallback?.home
	if (!home || !presets[home]) return undefined
	return applyPreset(crew, home, presets[home])
}

const LABELS: Record<Reason, string> = { quota: "quota", auth: "token", network: "network" }

/** A preset's fallbacks, e.g. `main → backup (quota, token), spare (network)`. */
export function chainText(fallbacks: Fallbacks, preset: string) {
	const targets = new Map<string, string[]>()
	for (const reason of REASONS) {
		const target = fallbacks[preset]?.[reason]
		if (target) targets.set(target, [...(targets.get(target) ?? []), LABELS[reason]])
	}
	if (targets.size === 0) return undefined
	return `${preset} → ${[...targets].map(([target, reasons]) => `${target} (${reasons.join(", ")})`).join(", ")}`
}

const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

/** The crew's fallback state, e.g. `spare — fallback from main (quota, then network) at 2:05 PM, back at 2:35 PM`. */
export function fallbackText(crew: Crew, minutes: number) {
	const { fallback } = crew
	if (!fallback || !crew.preset) return undefined
	const reasons = fallback.reasons.map((reason) => LABELS[reason]).filter((label, i, all) => label !== all[i - 1])
	const back = fallback.since + minutes * 60_000
	return `${crew.preset} — fallback from ${fallback.home} (${reasons.join(", then ")}) at ${clock(fallback.since)}, back at ${clock(back)}`
}
