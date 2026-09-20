import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Hooks, Plugin } from "@opencode-ai/plugin";

import { createLog, type Log } from "./log";

interface ModelRef {
	readonly providerID: string;
	readonly modelID: string;
	readonly variant?: string;
}

interface SessionPolicy {
	readonly version: 1;
	readonly rootSessionID: string;
	readonly delegation: "default" | "allow" | "deny";
	readonly agentAccess: Readonly<Record<string, "allow" | "deny">>;
	readonly modelOverrides: Readonly<Record<string, ModelRef>>;
}

type Access = "allow" | "ask" | "deny";

interface PermissionRule {
	readonly permission: string;
	readonly pattern: string;
	readonly action: Access;
}

interface SessionInfo {
	readonly id?: string;
	readonly parentID?: string;
	readonly agent?: string;
	readonly permission?: readonly PermissionRule[];
}

interface SessionClient {
	get(options: {
		path: { id: string };
	}): Promise<{ data?: SessionInfo } | SessionInfo>;
}

interface PluginClient {
	readonly session: SessionClient;
}

type PermissionConfig =
	| Access
	| Readonly<
			Record<string, Access | Readonly<Record<string, Access>> | undefined>
	  >;

interface AgentConfig {
	disable?: boolean;
	mode?: "subagent" | "primary" | "all";
	permission?: PermissionConfig;
}

interface OpenCodeConfig {
	permission?: PermissionConfig;
	agent?: Record<string, AgentConfig | undefined>;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function wildcardMatch(value: string, pattern: string): boolean {
	const normalized = value.replaceAll("\\", "/");
	let escaped = pattern
		.replaceAll("\\", "/")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
	return new RegExp(
		`^${escaped}$`,
		process.platform === "win32" ? "si" : "s",
	).test(normalized);
}

function configuredAccess(
	config: PermissionConfig | undefined,
	agent: string,
): Access | undefined {
	if (typeof config === "string") return config;
	let result: Access | undefined;
	for (const [permission, value] of Object.entries(config ?? {})) {
		if (!wildcardMatch("task", permission) || value === undefined) continue;
		if (typeof value === "string") {
			result = value;
			continue;
		}
		for (const [pattern, action] of Object.entries(value)) {
			if (wildcardMatch(agent, pattern)) result = action;
		}
	}
	return result;
}

function allowRuntimeTaskOverrides(config: OpenCodeConfig): void {
	const global = typeof config.permission === "object" ? config.permission : {};
	config.permission = {
		...Object.fromEntries(
			Object.entries(global).filter(([permission]) => permission !== "task"),
		),
		task: { "*": "allow" },
	};
	for (const agent of Object.values(config.agent ?? {})) {
		if (!agent || agent.disable) continue;
		const permission =
			typeof agent.permission === "object" ? agent.permission : {};
		agent.permission = {
			...Object.fromEntries(
				Object.entries(permission).filter(
					([permission]) => permission !== "task",
				),
			),
			task: { "*": "allow" },
		};
	}
}

function sessionAccess(
	rules: readonly PermissionRule[] | undefined,
	agent: string,
): Access | undefined {
	let result: Access | undefined;
	for (const rule of rules ?? []) {
		if (
			wildcardMatch("task", rule.permission) &&
			wildcardMatch(agent, rule.pattern)
		) {
			result = rule.action;
		}
	}
	return result;
}

function policyDir(): string {
	const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return (
		process.env.OPENCODE_SESSION_POLICY_DIR ??
		join(data, "opencode", "session-policy")
	);
}

function policyPath(rootSessionID: string): string | undefined {
	if (!SAFE_ID.test(rootSessionID)) return;
	return join(policyDir(), `${rootSessionID}.json`);
}

function validModel(value: unknown): value is ModelRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.providerID === "string" &&
		item.providerID.length > 0 &&
		typeof item.modelID === "string" &&
		item.modelID.length > 0 &&
		(item.variant === undefined || typeof item.variant === "string")
	);
}

function readPolicy(
	rootSessionID: string,
	log?: Log,
): SessionPolicy | undefined {
	const path = policyPath(rootSessionID);
	if (!path) {
		log?.warn("policy.unsafe-session-id", { rootSessionID });
		return;
	}
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			log?.warn("policy.invalid", { rootSessionID, path, reason: "root" });
			return;
		}
		const item = data as Record<string, unknown>;
		if (item.version !== 1 || item.rootSessionID !== rootSessionID) {
			log?.warn("policy.invalid", {
				rootSessionID,
				path,
				reason: "identity",
			});
			return;
		}
		if (
			item.delegation !== "default" &&
			item.delegation !== "allow" &&
			item.delegation !== "deny"
		) {
			log?.warn("policy.invalid", {
				rootSessionID,
				path,
				reason: "delegation",
			});
			return;
		}
		if (
			!item.agentAccess ||
			typeof item.agentAccess !== "object" ||
			Array.isArray(item.agentAccess) ||
			!Object.values(item.agentAccess).every(
				(access) => access === "allow" || access === "deny",
			)
		) {
			log?.warn("policy.invalid", {
				rootSessionID,
				path,
				reason: "agent-access",
			});
			return;
		}
		if (
			!item.modelOverrides ||
			typeof item.modelOverrides !== "object" ||
			Array.isArray(item.modelOverrides)
		) {
			log?.warn("policy.invalid", {
				rootSessionID,
				path,
				reason: "model-overrides",
			});
			return;
		}
		if (!Object.values(item.modelOverrides).every(validModel)) {
			log?.warn("policy.invalid", {
				rootSessionID,
				path,
				reason: "model-reference",
			});
			return;
		}
		const policy = item as unknown as SessionPolicy;
		log?.debug("policy.loaded", {
			rootSessionID,
			path,
			delegation: policy.delegation,
			agentAccess: policy.agentAccess,
			modelOverrides: policy.modelOverrides,
		});
		return policy;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: undefined;
		if (code === "ENOENT") {
			log?.debug("policy.missing", { rootSessionID, path });
		} else {
			log?.warn("policy.read-failed", { rootSessionID, path, error });
		}
		return;
	}
}

function unwrapSession(
	value: { data?: SessionInfo } | SessionInfo | undefined,
): SessionInfo | undefined {
	if (!value) return;
	if ("data" in value && value.data) return value.data;
	if ("id" in value || "parentID" in value) return value;
	return;
}

class SessionTree {
	private readonly parents = new Map<string, string | null>();
	private readonly agents = new Map<string, string>();

	constructor(
		private readonly client: PluginClient,
		private readonly log: Log,
	) {}

	onEvent(event: {
		type?: string;
		properties?: { info?: SessionInfo; sessionID?: string };
	}): void {
		const info = event.properties?.info;
		if (
			(event.type === "session.created" || event.type === "session.updated") &&
			info?.id
		) {
			this.parents.set(info.id, info.parentID ?? null);
			if (info.agent) this.agents.set(info.id, info.agent);
			return;
		}
		if (event.type === "session.deleted") {
			const id = info?.id ?? event.properties?.sessionID;
			if (id) {
				this.parents.delete(id);
				this.agents.delete(id);
			}
		}
	}

	observeAgent(sessionID: string, agent: string | undefined): void {
		if (agent) this.agents.set(sessionID, agent);
	}

	async info(sessionID: string): Promise<SessionInfo> {
		let result: { data?: SessionInfo } | SessionInfo;
		try {
			result = await this.client.session.get({ path: { id: sessionID } });
		} catch (error) {
			this.log.error("session.lookup-failed", { sessionID, error });
			throw error;
		}
		const info = unwrapSession(result);
		if (!info?.id) {
			this.log.error("session.lookup-invalid", { sessionID });
			throw new Error(
				`Unable to resolve session information for "${sessionID}".`,
			);
		}
		this.parents.set(info.id, info.parentID ?? null);
		if (info.agent) this.agents.set(info.id, info.agent);
		return info;
	}

	async agent(sessionID: string): Promise<string | undefined> {
		return this.agents.get(sessionID) ?? (await this.info(sessionID)).agent;
	}

	async root(sessionID: string): Promise<string> {
		let current = sessionID;
		const seen = new Set<string>();
		while (!seen.has(current)) {
			seen.add(current);
			let parent = this.parents.get(current);
			if (parent === undefined) {
				const info = await this.info(current);
				parent = info?.parentID ?? null;
			}
			if (!parent) {
				this.log.debug("session.root-resolved", {
					sessionID,
					rootSessionID: current,
					depth: seen.size - 1,
				});
				return current;
			}
			current = parent;
		}
		this.log.error("session.cycle", { sessionID, chain: [...seen] });
		throw new Error(`Cycle detected while resolving session "${sessionID}".`);
	}
}

function policySummary(policy: SessionPolicy): string | undefined {
	const allowed = Object.entries(policy.agentAccess)
		.filter((entry) => entry[1] === "allow")
		.map((entry) => entry[0])
		.sort();
	const denied = Object.entries(policy.agentAccess)
		.filter((entry) => entry[1] === "deny")
		.map((entry) => entry[0])
		.sort();
	const models = Object.entries(policy.modelOverrides)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(
			([agent, model]) =>
				`${agent}=${model.providerID}/${model.modelID}${model.variant ? ` (${model.variant})` : ""}`,
		);
	const details = [
		policy.delegation === "allow"
			? "All subagent delegation is enabled, except agents explicitly denied below."
			: undefined,
		policy.delegation === "deny"
			? "All subagent delegation is disabled, except agents explicitly allowed below."
			: undefined,
		allowed.length > 0
			? `Explicitly allowed subagents: ${allowed.join(", ")}. These agents may be delegated to even if the static task description omits them.`
			: undefined,
		denied.length > 0
			? `Explicitly denied subagents: ${denied.join(", ")}.`
			: undefined,
		models.length > 0
			? `Session subagent model overrides: ${models.join(", ")}.`
			: undefined,
	].filter((item): item is string => item !== undefined);
	if (details.length === 0) return;
	return `Runtime /subagents policy for this session tree:\n${details.map((item) => `- ${item}`).join("\n")}`;
}

export const SessionControls: Plugin = async (ctx): Promise<Hooks> => {
	const log = createLog("server");
	const tree = new SessionTree(ctx.client as unknown as PluginClient, log);
	let globalPermission: PermissionConfig | undefined;
	const agentPermissions = new Map<string, PermissionConfig | undefined>();
	const subagents = new Set<string>();
	log.info("startup.ready", {
		pid: process.pid,
		directory: ctx.directory,
		policyDir: policyDir(),
	});

	function defaultAccess(
		agentName: string | undefined,
		targetAgent: string,
	): Access {
		if (!subagents.has(targetAgent)) return "deny";
		let access: Access = "allow";
		access = configuredAccess(globalPermission, targetAgent) ?? access;
		access =
			configuredAccess(
				agentName ? agentPermissions.get(agentName) : undefined,
				targetAgent,
			) ?? access;
		return access;
	}

	return {
		config: async (input) => {
			const runtimeConfig = input as OpenCodeConfig;
			globalPermission = structuredClone(runtimeConfig.permission);
			agentPermissions.clear();
			subagents.clear();
			for (const [name, agent] of Object.entries(runtimeConfig.agent ?? {})) {
				agentPermissions.set(name, structuredClone(agent?.permission));
				if (agent && !agent.disable && agent.mode !== "primary")
					subagents.add(name);
			}
			allowRuntimeTaskOverrides(runtimeConfig);
			log.info("config.loaded", {
				agents: agentPermissions.size,
				subagents: [...subagents].sort(),
			});
		},
		event: async ({ event }) => {
			tree.onEvent(event as Parameters<SessionTree["onEvent"]>[0]);
			if (
				event.type === "session.created" ||
				event.type === "session.deleted"
			) {
				const info = event.properties.info;
				log.debug(event.type, {
					sessionID: info.id,
					parentID: info.parentID,
				});
			}
		},
		"tool.execute.before": async (input, output) => {
			if (input.tool !== "task") return;
			const root = await tree.root(input.sessionID);
			const policy = readPolicy(root, log);
			const agent =
				typeof output.args?.subagent_type === "string"
					? output.args.subagent_type
					: "";
			const explicit = policy?.agentAccess[agent];
			if (explicit === "allow") {
				log.info("task.allowed", {
					sessionID: input.sessionID,
					rootSessionID: root,
					agent,
					reason: "agent-override",
				});
				return;
			}
			if (explicit !== "deny" && policy?.delegation === "allow") {
				log.info("task.allowed", {
					sessionID: input.sessionID,
					rootSessionID: root,
					agent,
					reason: "allow-all",
				});
				return;
			}
			if (
				explicit !== "deny" &&
				(policy?.delegation ?? "default") === "default"
			) {
				const session = await tree.info(input.sessionID);
				const currentAgent = await tree.agent(input.sessionID);
				const baseline =
					sessionAccess(session.permission, agent) ??
					defaultAccess(currentAgent, agent);
				if (baseline === "allow") {
					log.debug("task.allowed", {
						sessionID: input.sessionID,
						rootSessionID: root,
						agent,
						reason: "configured-default",
					});
					return;
				}
			}
			log.warn("task.denied", {
				sessionID: input.sessionID,
				rootSessionID: root,
				agent,
				delegation: policy?.delegation ?? "default",
				explicit,
			});
			throw new Error(
				agent
					? `Session policy prohibits delegation to "${agent}". Use /subagents in the primary session to change it.`
					: "Session policy prohibits subagent delegation. Use /subagents in the primary session to change it.",
			);
		},
		"chat.message": async (input, output) => {
			tree.observeAgent(input.sessionID, input.agent ?? output.message.agent);
			const root = await tree.root(input.sessionID);
			const policy = readPolicy(root, log);
			if (!policy) {
				log.debug("model.no-policy", {
					sessionID: input.sessionID,
					rootSessionID: root,
					agent: input.agent ?? output.message.agent,
				});
				return;
			}
			if (root === input.sessionID) {
				log.debug("model.skip-root", {
					sessionID: input.sessionID,
					agent: input.agent ?? output.message.agent,
				});
				return;
			}
			const agent = input.agent ?? output.message.agent;
			if (!agent) {
				log.warn("model.missing-agent", {
					sessionID: input.sessionID,
					rootSessionID: root,
				});
				return;
			}
			const model = policy.modelOverrides[agent];
			if (!model) {
				log.debug("model.no-override", {
					sessionID: input.sessionID,
					rootSessionID: root,
					agent,
					configuredModel: output.message.model,
				});
				return;
			}
			const configuredModel = { ...output.message.model };
			output.message.model = {
				providerID: model.providerID,
				modelID: model.modelID,
				...(model.variant ? { variant: model.variant } : {}),
			};
			log.info("model.override-applied", {
				sessionID: input.sessionID,
				rootSessionID: root,
				agent,
				configuredModel,
				overrideModel: output.message.model,
			});
		},
		"experimental.chat.system.transform": async (input, output) => {
			if (!input.sessionID) return;
			const root = await tree.root(input.sessionID);
			const policy = readPolicy(root, log);
			if (!policy) return;
			const summary = policySummary(policy);
			if (summary) output.system.push(summary);
		},
		dispose: async () => {
			log.info("shutdown", { pid: process.pid, directory: ctx.directory });
		},
	};
};

export default { id: "session-controls", server: SessionControls };
