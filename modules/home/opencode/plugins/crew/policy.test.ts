import { describe, expect, test } from "bun:test"

import {
	type AgentInfo,
	access,
	applyPreset,
	available,
	crewRules,
	effect,
	emptyCrew,
	isModelRef,
	KEY,
	type Managed,
	modelOf,
	note,
	type Rule,
	readCrew,
	readManaged,
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

const managed: Managed = { planner: { label: "lanes planner", tools: "lanes_*", skill: "lanes" } }

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
			{ action: "skill", resource: "crew", effect: "deny" },
			{ action: "skill", resource: "crew-*", effect: "deny" },
			{ action: "subagent", resource: "explore", effect: "deny" },
			{ action: "skill", resource: "crew-explore", effect: "deny" },
			{ action: "subagent", resource: "pr", effect: "allow" },
			{ action: "skill", resource: "crew-pr", effect: "allow" },
			{ action: "skill", resource: "crew", effect: "allow" },
		])
	})

	test("crewRules denies the playbook of a member that is off", () => {
		expect(crewRules({ ...emptyCrew(), access: { pr: "deny" } })).toEqual([
			{ action: "subagent", resource: "pr", effect: "deny" },
			{ action: "skill", resource: "crew-pr", effect: "deny" },
		])
	})

	test("crewRules allows skills back only after all off", () => {
		expect(crewRules({ ...emptyCrew(), access: { pr: "allow" } })).toEqual([
			{ action: "subagent", resource: "pr", effect: "allow" },
		])
		expect(crewRules({ ...emptyCrew(), delegation: "allow", access: { pr: "allow" } })).toEqual([
			{ action: "subagent", resource: "*", effect: "allow" },
			{ action: "subagent", resource: "pr", effect: "allow" },
		])
		expect(crewRules({ ...emptyCrew(), delegation: "deny", access: { explore: "allow", pr: "allow" } })).toEqual([
			{ action: "subagent", resource: "*", effect: "deny" },
			{ action: "skill", resource: "crew", effect: "deny" },
			{ action: "skill", resource: "crew-*", effect: "deny" },
			{ action: "subagent", resource: "explore", effect: "allow" },
			{ action: "skill", resource: "crew-explore", effect: "allow" },
			{ action: "subagent", resource: "pr", effect: "allow" },
			{ action: "skill", resource: "crew-pr", effect: "allow" },
			{ action: "skill", resource: "crew", effect: "allow" },
		])
	})

	test("crewRules switches a managed member's tools and skill off, and leaves On to the configuration", () => {
		expect(crewRules({ ...emptyCrew(), access: { planner: "deny" } }, managed)).toEqual([
			{ action: "lanes_*", resource: "*", effect: "deny" },
			{ action: "skill", resource: "lanes", effect: "deny" },
		])
		expect(crewRules({ ...emptyCrew(), delegation: "deny", access: { planner: "allow" } }, managed)).toEqual([
			{ action: "subagent", resource: "*", effect: "deny" },
			{ action: "skill", resource: "crew", effect: "deny" },
			{ action: "skill", resource: "crew-*", effect: "deny" },
		])
		const bare = { planner: { label: "x", tools: "x_*" } }
		expect(crewRules({ ...emptyCrew(), access: { planner: "deny" } }, bare)).toEqual([
			{ action: "x_*", resource: "*", effect: "deny" },
		])
	})

	test("withRules keeps the session's other rules and replaces only the crew's", () => {
		const session: Rule[] = [
			{ action: "shell", resource: "git *", effect: "allow" },
			{ action: "subagent", resource: "pr", effect: "deny" },
			{ action: "skill", resource: "debugging", effect: "deny" },
			{ action: "skill", resource: "crew", effect: "deny" },
			{ action: "skill", resource: "crew-pr", effect: "deny" },
			{ action: "lanes_*", resource: "*", effect: "deny" },
			{ action: "skill", resource: "lanes", effect: "deny" },
			{ action: "read", resource: "*", effect: "allow" },
		]
		expect(withRules(session, { ...emptyCrew(), access: { explore: "deny" } }, managed)).toEqual([
			{ action: "shell", resource: "git *", effect: "allow" },
			{ action: "skill", resource: "debugging", effect: "deny" },
			{ action: "read", resource: "*", effect: "allow" },
			{ action: "subagent", resource: "explore", effect: "deny" },
			{ action: "skill", resource: "crew-explore", effect: "deny" },
		])
		expect(withRules(session, emptyCrew()).map((rule) => rule.action)).toEqual([
			"shell",
			"skill",
			"lanes_*",
			"skill",
			"read",
		])
		expect(withRules(undefined, emptyCrew())).toEqual([])
	})
})

describe("readManaged", () => {
	test("accepts a label alone or an object with tools and a skill", () => {
		expect(readManaged({ planner: "lanes planner" })).toEqual({ planner: { label: "lanes planner" } })
		expect(readManaged({ planner: { label: "lanes planner", tools: "lanes_*", skill: "lanes" } })).toEqual(managed)
	})

	test("drops malformed entries and fields", () => {
		expect(readManaged(undefined)).toEqual({})
		expect(readManaged(["x"])).toEqual({})
		expect(readManaged({ a: 1, b: { tools: "x_*" }, c: { label: "c", tools: 2, skill: "" } })).toEqual({
			c: { label: "c" },
		})
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

	test("effect evaluates a managed member's tools pattern", () => {
		const planner: Rule[] = [
			{ action: "*", resource: "*", effect: "deny" },
			{ action: "lanes_*", resource: "*", effect: "allow" },
		]
		const session = (planner: "allow" | "deny") => crewRules({ ...emptyCrew(), access: { planner } }, managed)
		expect(effect(planner, "lanes_*", "*")).toBe("allow")
		expect(effect([...planner, ...session("deny")], "lanes_*", "*")).toBe("deny")
		expect(effect([...planner, ...session("allow")], "lanes_*", "*")).toBe("allow")
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
