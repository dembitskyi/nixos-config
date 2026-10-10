import { describe, expect, test } from "bun:test"

import { type AgentInfo, AWAY_ANSWER, AWAY_NOTE, KEY, type Rule } from "./policy"
import plugin, { rootCrew, type ServerContext } from "./server"

type Session = { parentID?: string; metadata?: Record<string, unknown>; permissions?: Rule[] }
type ToolHook = Parameters<ServerContext["tool"]["hook"]>[1]
type ContextHook = Parameters<ServerContext["session"]["hook"]>[1]
type PermissionHook = Parameters<ServerContext["permission"]["hook"]>[1]
type PermissionEvent = Parameters<PermissionHook>[0]

const deny: Rule = { action: "*", resource: "*", effect: "deny" }
const allow = (resource: string): Rule => ({ action: "subagent", resource, effect: "allow" })
const off = (resource: string): Rule => ({ action: "subagent", resource, effect: "deny" })

const agents: AgentInfo[] = [
	{ id: "dev", mode: "primary", permissions: [deny, allow("general"), allow("explore")] },
	{
		id: "general",
		mode: "subagent",
		description: "Research.",
		model: { providerID: "acme", id: "gpt" },
		permissions: [deny],
	},
	{ id: "explore", mode: "subagent", description: "Searches code." },
]

const builtIn = "Launch a subagent.\n\nAvailable subagents:\n- explore: Searches code.\n- general: Research."

function fakeContext(sessions: Record<string, Session>) {
	const hooks: { tool?: ToolHook; context?: ContextHook; permission?: PermissionHook } = {}
	const ctx: ServerContext = {
		agent: { list: async () => ({ data: agents }) },
		session: {
			get: async ({ sessionID }) => ({ id: sessionID, ...sessions[sessionID] }),
			hook: async (_name, callback) => {
				hooks.context = callback
			},
		},
		tool: {
			hook: async (_name, callback) => {
				hooks.tool = callback
			},
		},
		permission: {
			hook: async (_name, callback) => {
				hooks.permission = callback
			},
		},
	}
	return { ctx, hooks }
}

function request(sessionID: string, agent: string, tools: Record<string, { description: string }>) {
	return {
		sessionID,
		agent,
		model: { providerID: "github-copilot", id: "opus", variant: "medium" },
		system: [] as { type: "text"; text: string }[],
		tools,
	}
}

const crew = { delegation: "default", access: {}, models: { general: "a/b#max" } }

test("rootCrew reads the crew from the root of the session tree", async () => {
	const { ctx } = fakeContext({ root: { metadata: { [KEY]: crew } }, child: { parentID: "root" } })
	expect((await rootCrew(ctx, { id: "grandchild", parentID: "child" })).models).toEqual({ general: "a/b#max" })
})

test("launches get the session's model unless one was asked for", async () => {
	const { ctx, hooks } = fakeContext({ root: { metadata: { [KEY]: crew } } })
	await plugin.setup(ctx)

	const launch = { tool: "subagent", sessionID: "root", input: { agent: "general", prompt: "x" } as unknown }
	await hooks.tool?.(launch)
	expect(launch.input).toEqual({ agent: "general", prompt: "x", model: "a/b#max" })

	const explicit = { tool: "subagent", sessionID: "root", input: { agent: "general", model: "c/d" } as unknown }
	await hooks.tool?.(explicit)
	expect(explicit.input).toEqual({ agent: "general", model: "c/d" })

	const other = { tool: "subagent", sessionID: "root", input: { agent: "explore" } as unknown }
	await hooks.tool?.(other)
	expect(other.input).toEqual({ agent: "explore" })

	const shell = { tool: "shell", sessionID: "root", input: { command: "ls" } as unknown }
	await hooks.tool?.(shell)
	expect(shell.input).toEqual({ command: "ls" })
})

describe("context", () => {
	test("lists the session's subagents with their models", async () => {
		const { ctx, hooks } = fakeContext({ root: { metadata: { [KEY]: crew } } })
		await plugin.setup(ctx)
		const event = request("root", "dev", { subagent: { description: builtIn } })
		await hooks.context?.(event)
		expect(event.tools.subagent?.description).toBe(
			"Launch a subagent.\n\nAvailable subagents:\n- explore [github-copilot/opus#medium, inherited]: Searches code.\n- general [a/b#max, set by the user]: Research.",
		)
		expect(event.system).toEqual([])
	})

	test("drops subagents the user turned off and says so", async () => {
		const { ctx, hooks } = fakeContext({ root: { permissions: [off("explore")] } })
		await plugin.setup(ctx)
		const event = request("root", "dev", { subagent: { description: builtIn } })
		await hooks.context?.(event)
		expect(event.tools.subagent?.description).not.toContain("explore")
		expect(event.system[0]?.text).toBe("The user turned off these subagents for this session with /crew: explore.")
	})

	test("removes the tool when no subagent is left", async () => {
		const { ctx, hooks } = fakeContext({ root: { permissions: [off("explore"), off("general")] } })
		await plugin.setup(ctx)
		const event = request("root", "dev", { subagent: { description: builtIn } })
		await hooks.context?.(event)
		expect(event.tools.subagent).toBeUndefined()
		expect(event.system[0]?.text).toContain("turned off all subagents")
	})

	test("explains a tool OpenCode already hid", async () => {
		const { ctx, hooks } = fakeContext({ root: { permissions: [off("*")] } })
		await plugin.setup(ctx)
		const event = request("root", "dev", {})
		await hooks.context?.(event)
		expect(event.system[0]?.text).toContain("turned off all subagents")
	})

	test("keeps children on their configured access", async () => {
		const { ctx, hooks } = fakeContext({ root: {}, child: { parentID: "root", permissions: [allow("*")] } })
		await plugin.setup(ctx)
		const event = request("child", "general", { subagent: { description: builtIn } })
		await hooks.context?.(event)
		expect(event.tools.subagent).toBeUndefined()
		expect(event.system).toEqual([])
	})
})

describe("away", () => {
	const away = { metadata: { [KEY]: { delegation: "default", access: {}, models: {}, away: true } } }
	const tools = () => ({ subagent: { description: builtIn }, question: { description: "Ask the user." } })

	test("hides the question tool and tells every session in the tree to keep going", async () => {
		const { ctx, hooks } = fakeContext({ root: away, child: { parentID: "root" } })
		await plugin.setup(ctx)
		for (const [sessionID, agent] of [
			["root", "dev"],
			["child", "general"],
		]) {
			const event = request(sessionID, agent, tools())
			await hooks.context?.(event)
			expect(event.tools.question).toBeUndefined()
			expect(event.system.map((part) => part.text)).toContain(AWAY_NOTE)
		}
	})

	test("approves permission prompts and refuses questions while away", async () => {
		const { ctx, hooks } = fakeContext({ root: away, child: { parentID: "root" } })
		await plugin.setup(ctx)
		const prompt: PermissionEvent = { sessionID: "child", action: "shell", effect: "ask" }
		await hooks.permission?.(prompt)
		expect(prompt.effect).toBe("allow")
		const question: PermissionEvent = { sessionID: "root", action: "question", effect: "allow" }
		await hooks.permission?.(question)
		expect(question).toEqual({ sessionID: "root", action: "question", effect: "deny", message: AWAY_ANSWER })
		const allowed: PermissionEvent = { sessionID: "root", action: "read", effect: "allow" }
		await hooks.permission?.(allowed)
		expect(allowed.effect).toBe("allow")
	})

	test("changes nothing while the user is present", async () => {
		const { ctx, hooks } = fakeContext({ root: {} })
		await plugin.setup(ctx)
		const event = request("root", "dev", tools())
		await hooks.context?.(event)
		expect(event.tools.question).toBeDefined()
		expect(event.system).toEqual([])
		const prompt: PermissionEvent = { sessionID: "root", action: "shell", effect: "ask" }
		await hooks.permission?.(prompt)
		expect(prompt.effect).toBe("ask")
	})
})
