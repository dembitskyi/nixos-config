// `/crew` server side (OpenCode V2): injects the session's model choices into
// subagent launches and keeps the model aware of its crew — which subagents it
// may launch in this session and the model each one runs on. While the user is
// away, the whole session tree works without them: no questions, and approval
// prompts are granted (configured denies are settled before plugins see them).
import {
	type AgentInfo,
	AWAY_ANSWER,
	AWAY_NOTE,
	available,
	type Crew,
	formatModel,
	KEY,
	type ModelRef,
	note,
	QUESTION,
	readCrew,
	type Rule,
	TOOL,
	toolDescription,
} from "./policy"

interface SessionInfo {
	readonly id: string
	readonly parentID?: string
	readonly metadata?: Readonly<Record<string, unknown>>
	readonly permissions?: readonly Rule[]
}

interface ContextEvent {
	readonly sessionID: string
	readonly agent: string
	readonly model: ModelRef
	system: { type: "text"; text: string }[]
	tools: Record<string, { description: string }>
}

interface ToolEvent {
	tool: string
	readonly sessionID: string
	input: unknown
}

interface PermissionEvent {
	readonly sessionID: string
	readonly action: string
	effect: "allow" | "ask" | "deny"
	message?: string
}

export interface ServerContext {
	readonly agent: {
		list(): Promise<{ data: readonly AgentInfo[] }>
	}
	readonly session: {
		get(input: { sessionID: string }): Promise<SessionInfo>
		hook(name: "context", callback: (event: ContextEvent) => Promise<void>): Promise<unknown>
	}
	readonly tool: {
		hook(name: "execute.before", callback: (event: ToolEvent) => Promise<void>): Promise<unknown>
	}
	readonly permission: {
		hook(name: "evaluate", callback: (event: PermissionEvent) => Promise<void>): Promise<unknown>
	}
}

/** The crew lives on the root session, so nested sessions always see the current one. */
export async function rootCrew(ctx: ServerContext, session: SessionInfo): Promise<Crew> {
	const seen = new Set<string>()
	while (session.parentID && !seen.has(session.id)) {
		seen.add(session.id)
		session = await ctx.session.get({ sessionID: session.parentID })
	}
	return readCrew(session.metadata?.[KEY])
}

export default {
	id: "crew",
	async setup(ctx: ServerContext) {
		await ctx.tool.hook("execute.before", async (event) => {
			if (event.tool !== TOOL) return
			const input = event.input as { agent?: unknown; model?: unknown } | undefined
			if (typeof input?.agent !== "string") return
			// A model the user asked for in the conversation wins.
			if (typeof input.model === "string" && input.model !== "") return
			const session = await ctx.session.get({ sessionID: event.sessionID })
			const model = (await rootCrew(ctx, session)).models[input.agent]
			if (model) event.input = { ...input, model }
		})

		await ctx.session.hook("context", async (event) => {
			const [{ data: agents }, session] = await Promise.all([
				ctx.agent.list(),
				ctx.session.get({ sessionID: event.sessionID }),
			])
			const crew = await rootCrew(ctx, session)
			const own = agents.find((agent) => agent.id === event.agent)?.permissions ?? []
			const configured = available(agents, own)
			// Children copy the root's session rules when created, but /crew only
			// steers the root, so they keep their configured access.
			const effective = session.parentID ? configured : available(agents, [...own, ...(session.permissions ?? [])])
			const tool = event.tools[TOOL]
			if (tool && effective.length === 0) delete event.tools[TOOL]
			else if (tool) tool.description = toolDescription(tool.description, effective, crew, formatModel(event.model))
			const text = session.parentID ? undefined : note(configured, effective)
			if (text) event.system.push({ type: "text", text })
			if (crew.away) {
				delete event.tools[QUESTION]
				event.system.push({ type: "text", text: AWAY_NOTE })
			}
		})

		// Only prompts and questions matter here, so other checks skip the session lookup.
		await ctx.permission.hook("evaluate", async (event) => {
			if (event.effect !== "ask" && event.action !== QUESTION) return
			const crew = await rootCrew(ctx, await ctx.session.get({ sessionID: event.sessionID }))
			if (!crew.away) return
			if (event.action === QUESTION) {
				event.effect = "deny"
				event.message = AWAY_ANSWER
			} else event.effect = "allow"
		})
	},
}
