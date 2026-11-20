// `/crew`: per-session control of the subagents the root session may launch, their
// models, and the away switch. Settings live in the root session's metadata; access
// uses native permission rules, and the server plugin injects models and applies away.

export type Access = "allow" | "deny"
export type Delegation = "default" | Access

export interface Crew {
	delegation: Delegation
	access: Record<string, Access>
	models: Record<string, string>
	preset?: string
	// The user is away: no questions, approval prompts granted, for this whole session tree.
	away?: boolean
	// Fallback chain name, false for off, unset for the configured default.
	fallbackChain?: string | false
	// Stored by the version before named chains: on, with the default or first chain.
	autoFallback?: true
	fallback?: Fallback
}

/** Why a provider refused: used up quota, a rejected token, or an outage. */
export type Reason = "quota" | "auth" | "network"

/** A fallback episode: origin preset, switch reasons, last switch time and presets tried. */
export interface Fallback {
	home: string
	reasons: Reason[]
	since: number
	visited: string[]
}

export type Fallbacks = Record<string, Partial<Record<Reason, string>>>

export type Chains = Record<string, Fallbacks>

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
	if ((typeof value.fallbackChain === "string" && value.fallbackChain) || value.fallbackChain === false)
		crew.fallbackChain = value.fallbackChain
	else if (value.autoFallback === false) crew.fallbackChain = false
	else if (value.autoFallback === true) crew.autoFallback = true
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
		crew.fallbackChain === undefined &&
		!crew.autoFallback
	)
}

const sorted = <T>(record: Record<string, T>) => Object.entries(record).sort(([a], [b]) => a.localeCompare(b))

/** Session permission rules: the overall mode first, then per-agent exceptions and their skills. */
export function crewRules(crew: Crew): Rule[] {
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
		rules.push({ action: TOOL, resource: agent, effect })
		// Skills are only allowed back after "All off": child sessions copy these rules.
		if (effect === "deny" || off) rules.push({ action: SKILL, resource: `${PLAYBOOK}${agent}`, effect })
		if (effect === "allow" && off) strategy = true
	}
	if (strategy) rules.push({ action: SKILL, resource: STRATEGY, effect: "allow" })
	return rules
}

function isOwned(rule: Rule) {
	if (rule.action === TOOL) return true
	return rule.action === SKILL && (rule.resource === STRATEGY || rule.resource.startsWith(PLAYBOOK))
}

/** The session's rules with only the crew's own ones (subagents and playbooks) replaced. */
export function withRules(rules: readonly Rule[] | undefined, crew: Crew): Rule[] {
	return [...(rules ?? []).filter((rule) => !isOwned(rule)), ...crewRules(crew)]
}

export function withCrew(metadata: unknown, crew: Crew): Record<string, unknown> {
	const next: Record<string, unknown> = isRecord(metadata) ? { ...metadata } : {}
	if (isEmpty(crew)) delete next[KEY]
	else next[KEY] = crew
	return next
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

// OpenCode's wildcard: `*` matches anything, `?` one character, a trailing ` *` also the bare prefix.
function matches(pattern: string, value: string) {
	let source = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")
	if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`
	return new RegExp(`^${source}$`, "s").test(value)
}

/** The effect OpenCode applies: the last matching rule wins. */
function effect(rules: readonly Rule[], action: string, resource: string): Rule["effect"] {
	return rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, resource))?.effect ?? "ask"
}

export function access(rules: readonly Rule[], agent: string): Rule["effect"] {
	return effect(rules, TOOL, agent)
}

export function available(agents: readonly AgentInfo[], rules: readonly Rule[]) {
	return agents
		.filter((agent) => agent.mode !== "primary" && !agent.hidden && access(rules, agent.id) !== "deny")
		.toSorted((a, b) => a.id.localeCompare(b.id))
}

export function modelOf(agent: AgentInfo, crew: Crew, inherited?: string): { model?: string; source: Source } {
	const chosen = crew.models[agent.id]
	if (chosen) return { model: chosen, source: "user" }
	if (agent.model) return { model: formatModel(agent.model), source: "configured" }
	return { model: inherited, source: "inherited" }
}

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

export function readChains(value: unknown): Chains {
	if (!isRecord(value)) return {}
	const chains: Chains = {}
	for (const [name, chain] of Object.entries(value)) if (name && isRecord(chain)) chains[name] = readFallbacks(chain)
	return chains
}

export function readChainName(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined
}

/** The root's fallback chain, or undefined when off; the older on switch means the default chain, else the first. */
export function selectedChain(crew: Crew, chains: Chains, byDefault?: string): string | undefined {
	const known = (name: string | undefined) => (name !== undefined && chains[name] ? name : undefined)
	if (crew.fallbackChain === false) return undefined
	if (crew.fallbackChain !== undefined) return known(crew.fallbackChain)
	if (crew.autoFallback) return known(byDefault) ?? Object.keys(chains).sort()[0]
	return known(byDefault)
}

export function withChain(crew: Crew, chain: string | undefined, byDefault?: string): Crew {
	const fallbackChain = chain === byDefault ? undefined : (chain ?? false)
	return { ...crew, fallbackChain, autoFallback: undefined }
}

export interface RetryError {
	readonly type: string
	readonly status?: number
}

/** The fallback reason for a 403. */
export type Forbidden = "auth" | "network"

export function readForbidden(value: unknown): Forbidden {
	return value === "network" ? "network" : "auth"
}

/** The reason a refused request may fall back; `repeated` marks brief outages that only fall back once they persist. */
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

export function homeCrew(crew: Crew, presets: Presets): Crew | undefined {
	const home = crew.fallback?.home
	if (!home || !presets[home]) return undefined
	return applyPreset(crew, home, presets[home])
}

const LABELS: Record<Reason, string> = { quota: "quota", auth: "token", network: "network" }

/** A preset's fallbacks, e.g. `main → backup (quota, token), spare (network)`; a target for every reason needs none. */
export function chainText(fallbacks: Fallbacks, preset: string) {
	const targets = new Map<string, string[]>()
	for (const reason of REASONS) {
		const target = fallbacks[preset]?.[reason]
		if (target) targets.set(target, [...(targets.get(target) ?? []), LABELS[reason]])
	}
	if (targets.size === 0) return undefined
	const text = [...targets].map(([target, reasons]) =>
		reasons.length === REASONS.length ? target : `${target} (${reasons.join(", ")})`,
	)
	return `${preset} → ${text.join(", ")}`
}

/** The route a chain takes from `preset`, e.g. `main → backup (quota, token), spare (network); backup → spare`. */
export function routeText(fallbacks: Fallbacks, preset: string) {
	const queue = [preset]
	const parts: string[] = []
	for (let i = 0; i < queue.length; i++) {
		const name = queue[i] as string
		const text = chainText(fallbacks, name)
		if (text) parts.push(text)
		for (const reason of REASONS) {
			const target = fallbacks[name]?.[reason]
			if (target && !queue.includes(target)) queue.push(target)
		}
	}
	return parts.length > 0 ? parts.join("; ") : undefined
}

const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

/** The crew's fallback state, e.g. `spare — fallback from main (quota, then network) at 2:05 PM, back from 2:35 PM`. */
export function fallbackText(crew: Crew, minutes: number) {
	const { fallback } = crew
	if (!fallback || !crew.preset) return undefined
	const reasons = fallback.reasons.map((reason) => LABELS[reason]).filter((label, i, all) => label !== all[i - 1])
	const back = fallback.since + minutes * 60_000
	return `${crew.preset} — fallback from ${fallback.home} (${reasons.join(", then ")}) at ${clock(fallback.since)}, back from ${clock(back)}`
}
