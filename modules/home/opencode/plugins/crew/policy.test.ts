import { describe, expect, test } from "bun:test"

import {
	type AgentInfo,
	access,
	applyPreset,
	available,
	crewRules,
	emptyCrew,
	isModelRef,
	KEY,
	modelOf,
	note,
	type Rule,
	readCrew,
	readPresets,
	toolDescription,
	withCrew,
	withRules,
} from "./policy"

const dev: Rule[] = [
	{ action: "*", resource: "*", effect: "deny" },
	{ action: "subagent", resource: "general", effect: "allow" },
	{ action: "subagent", resource: "explore", effect: "allow" },
]

const agents: AgentInfo[] = [
	{ id: "dev", mode: "primary", permissions: dev },
	{ id: "general", mode: "subagent", description: "Research.", model: { providerID: "acme", id: "gpt" } },
	{ id: "explore", mode: "subagent", description: "Searches code." },
	{ id: "pr", mode: "subagent", model: { providerID: "github-copilot", id: "opus", variant: "medium" } },
	{ id: "title", mode: "subagent", hidden: true },
]

const byID = (id: string) => agents.find((agent) => agent.id === id) as AgentInfo

describe("readCrew", () => {
	test("returns the empty crew for missing or malformed values", () => {
		expect(readCrew(undefined)).toEqual(emptyCrew())
		expect(readCrew("nope")).toEqual(emptyCrew())
		expect(readCrew({ delegation: "maybe", access: [], models: null })).toEqual(emptyCrew())
	})

	test("keeps valid entries and drops invalid ones", () => {
		expect(
			readCrew({
				delegation: "deny",
				access: { pr: "allow", explore: "ask" },
				models: { general: "acme/opus#max", explore: "not a model" },
				preset: "fast",
			}),
		).toEqual({ delegation: "deny", access: { pr: "allow" }, models: { general: "acme/opus#max" }, preset: "fast" })
	})
})

test("isModelRef accepts provider/model with an optional variant", () => {
	expect(isModelRef("github-copilot/gpt-5.5")).toBe(true)
	expect(isModelRef("openrouter/anthropic/claude#high")).toBe(true)
	expect(isModelRef("gpt-5.5")).toBe(false)
	expect(isModelRef("a/b#c#d")).toBe(false)
})

describe("rules", () => {
	test("crewRules puts the overall mode before sorted per-agent exceptions", () => {
		expect(crewRules(emptyCrew())).toEqual([])
		expect(crewRules({ ...emptyCrew(), delegation: "deny", access: { pr: "allow", explore: "deny" } })).toEqual([
			{ action: "subagent", resource: "*", effect: "deny" },
			{ action: "subagent", resource: "explore", effect: "deny" },
			{ action: "subagent", resource: "pr", effect: "allow" },
		])
	})

	test("withRules keeps the session's other rules and replaces only subagent ones", () => {
		const session: Rule[] = [
			{ action: "shell", resource: "git *", effect: "allow" },
			{ action: "subagent", resource: "pr", effect: "deny" },
		]
		expect(withRules(session, { ...emptyCrew(), access: { explore: "deny" } })).toEqual([
			{ action: "shell", resource: "git *", effect: "allow" },
			{ action: "subagent", resource: "explore", effect: "deny" },
		])
		expect(withRules(undefined, emptyCrew())).toEqual([])
	})
})

describe("withCrew", () => {
	test("stores the crew beside other metadata", () => {
		const crew = { ...emptyCrew(), access: { pr: "deny" as const } }
		expect(withCrew({ other: 1 }, crew)).toEqual({ other: 1, [KEY]: crew })
	})

	test("removes an empty crew", () => {
		expect(withCrew({ other: 1, [KEY]: { delegation: "deny" } }, emptyCrew())).toEqual({ other: 1 })
	})
})

describe("presets", () => {
	test("readPresets drops invalid model references", () => {
		expect(readPresets({ fast: { general: "a/b", vision: 3 }, broken: "x" })).toEqual({ fast: { general: "a/b" } })
	})

	test("applyPreset replaces all model choices and records the name", () => {
		const crew = { ...emptyCrew(), delegation: "allow" as const, models: { explore: "a/old" } }
		expect(applyPreset(crew, "fast", { general: "a/new" })).toEqual({
			delegation: "allow",
			access: {},
			models: { general: "a/new" },
			preset: "fast",
		})
	})
})

describe("access", () => {
	test("the last matching rule wins and nothing matching asks", () => {
		expect(access(dev, "general")).toBe("allow")
		expect(access(dev, "pr")).toBe("deny")
		expect(access([], "pr")).toBe("ask")
		expect(access([...dev, ...crewRules({ ...emptyCrew(), access: { general: "deny" } })], "general")).toBe("deny")
		expect(access([...dev, { action: "subagent", resource: "*", effect: "allow" }], "pr")).toBe("allow")
	})
})

test("available lists allowed subagents, sorted, without primary or hidden agents", () => {
	expect(available(agents, dev).map((agent) => agent.id)).toEqual(["explore", "general"])
	expect(available(agents, []).map((agent) => agent.id)).toEqual(["explore", "general", "pr"])
})

test("modelOf prefers the user's choice, then the configured model, then the caller's", () => {
	const crew = { ...emptyCrew(), models: { explore: "a/b#high" } }
	expect(modelOf(byID("explore"), crew, "x/y")).toEqual({ model: "a/b#high", source: "user" })
	expect(modelOf(byID("pr"), crew, "x/y")).toEqual({ model: "github-copilot/opus#medium", source: "configured" })
	expect(modelOf(byID("explore"), emptyCrew(), "x/y")).toEqual({ model: "x/y", source: "inherited" })
})

describe("toolDescription", () => {
	const crew = { ...emptyCrew(), models: { explore: "a/b" } }

	test("replaces the built-in list with the session's subagents and their models", () => {
		const builtIn = "Launch a subagent.\n\nAvailable subagents:\n- explore: Searches code.\n- pr: Pull requests."
		expect(toolDescription(builtIn, available(agents, dev), crew, "x/y")).toBe(
			"Launch a subagent.\n\nAvailable subagents:\n- explore [a/b, set by the user]: Searches code.\n- general [acme/gpt]: Research.",
		)
	})

	test("appends a list when there is none and marks inherited models", () => {
		expect(toolDescription("Launch a subagent.", [byID("explore")], emptyCrew(), "x/y")).toBe(
			"Launch a subagent.\n\nAvailable subagents:\n- explore [x/y, inherited]: Searches code.",
		)
	})
})

describe("note", () => {
	const configured = available(agents, dev)

	test("is undefined when nothing configured is off", () => {
		expect(note(configured, configured)).toBeUndefined()
	})

	test("names the configured subagents the user turned off", () => {
		expect(note(configured, [byID("general")])).toBe(
			"The user turned off these subagents for this session with /crew: explore.",
		)
	})

	test("says when every subagent is off", () => {
		expect(note(configured, [])).toContain("turned off all subagents")
	})
})

test("the away flag is kept, and is enough to store the crew", () => {
	expect(readCrew({ away: true }).away).toBe(true)
	expect(readCrew({ away: "yes" }).away).toBeUndefined()
	const crew = { ...emptyCrew(), away: true }
	expect(withCrew({}, crew)).toEqual({ [KEY]: crew })
	expect(withCrew({ [KEY]: crew }, emptyCrew())).toEqual({})
})
