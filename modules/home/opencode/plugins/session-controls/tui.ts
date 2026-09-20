import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";

interface ModelRef {
	readonly providerID: string;
	readonly modelID: string;
	readonly variant?: string;
}

interface SessionPolicy {
	readonly version: 1;
	readonly rootSessionID: string;
	readonly delegation: "default" | "allow" | "deny";
	readonly agentAccess: Record<string, "allow" | "deny">;
	readonly modelOverrides: Record<string, ModelRef>;
	readonly updatedAt: number;
}

interface ModelChoice {
	readonly key: string;
	readonly ref: ModelRef;
	readonly title: string;
	readonly provider: string;
	readonly variants: readonly string[];
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function stateDir(): string {
	return (
		process.env.OPENCODE_SESSION_POLICY_DIR ??
		join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "opencode-session-policy")
	);
}

function statePath(rootSessionID: string): string {
	if (!SAFE_ID.test(rootSessionID)) throw new Error("Unsafe session ID");
	return join(stateDir(), `${rootSessionID}.json`);
}

function emptyPolicy(rootSessionID: string): SessionPolicy {
	return {
		version: 1,
		rootSessionID,
		delegation: "default",
		agentAccess: {},
		modelOverrides: {},
		updatedAt: Date.now(),
	};
}

function readPolicy(rootSessionID: string): SessionPolicy {
	try {
		const data = JSON.parse(
			readFileSync(statePath(rootSessionID), "utf8"),
		) as Partial<SessionPolicy>;
		if (data.version !== 1 || data.rootSessionID !== rootSessionID)
			return emptyPolicy(rootSessionID);
		return {
			...emptyPolicy(rootSessionID),
			delegation:
				data.delegation === "allow" || data.delegation === "deny"
					? data.delegation
					: "default",
			agentAccess:
				data.agentAccess && typeof data.agentAccess === "object"
					? Object.fromEntries(
							Object.entries(data.agentAccess).filter(
								(entry): entry is [string, "allow" | "deny"] =>
									entry[1] === "allow" || entry[1] === "deny",
							),
						)
					: {},
			modelOverrides:
				data.modelOverrides && typeof data.modelOverrides === "object"
					? data.modelOverrides
					: {},
			updatedAt:
				typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
		};
	} catch {
		return emptyPolicy(rootSessionID);
	}
}

function defaultPolicy(policy: SessionPolicy): boolean {
	return (
		policy.delegation === "default" &&
		Object.keys(policy.agentAccess).length === 0 &&
		Object.keys(policy.modelOverrides).length === 0
	);
}

function writePolicy(policy: SessionPolicy): void {
	const target = statePath(policy.rootSessionID);
	if (defaultPolicy(policy)) {
		rmSync(target, { force: true });
		return;
	}
	const dir = stateDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(
		tmp,
		`${JSON.stringify({ ...policy, updatedAt: Date.now() }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	renameSync(tmp, target);
}

function agentNames(api: TuiPluginApi): string[] {
	const configured = Object.entries(api.state.config.agent ?? {}).flatMap(
		([name, value]) => {
			if (!value || value.disable) return [];
			return [name];
		},
	);
	return [...new Set(configured)].sort();
}

function rootSessionID(api: TuiPluginApi): string | undefined {
	if (api.route.current.name !== "session") return;
	const selected = api.route.current.params?.sessionID;
	if (typeof selected !== "string") return;
	let current = selected;
	const seen = new Set<string>();
	while (!seen.has(current)) {
		seen.add(current);
		const parent = api.state.session.get(current)?.parentID;
		if (!parent) return current;
		current = parent;
	}
	return;
}

function modelChoices(api: TuiPluginApi): ModelChoice[] {
	return api.state.provider
		.flatMap((provider) =>
			Object.entries(provider.models).flatMap(([catalogID, model]) => {
				if (model.status === "deprecated") return [];
				const modelID = model.id || catalogID;
				return [
					{
						key: `${provider.id}/${modelID}`,
						ref: { providerID: provider.id, modelID },
						title: model.name || modelID,
						provider: provider.name,
						variants: Object.keys(model.variants ?? {})
							.filter((variant) => variant !== "default")
							.sort(),
					},
				];
			}),
		)
		.sort(
			(left, right) =>
				left.provider.localeCompare(right.provider) ||
				left.title.localeCompare(right.title),
		);
}

function chooseVariant(
	api: TuiPluginApi,
	choice: ModelChoice,
	current: ModelRef | undefined,
	save: (model: ModelRef) => void,
): void {
	const variants = [...choice.variants];
	if (current?.variant && !variants.includes(current.variant))
		variants.unshift(current.variant);
	if (variants.length === 0) {
		save(choice.ref);
		return;
	}
	api.ui.dialog.replace(() =>
		api.ui.DialogSelect({
			title: `Variant for ${choice.title}`,
			current: current?.variant ?? "default",
			options: [
				{ title: "Default", value: "default" },
				...variants.map((variant) => ({ title: variant, value: variant })),
			],
			onSelect(option) {
				save(
					option.value === "default"
						? choice.ref
						: { ...choice.ref, variant: option.value },
				);
			},
		}),
	);
}

function chooseModel(api: TuiPluginApi, root: string, agent: string): void {
	const policy = readPolicy(root);
	const current = policy.modelOverrides[agent];
	const choices = modelChoices(api);
	if (choices.length === 0) {
		api.ui.toast({
			variant: "error",
			message: "No available models were found.",
		});
		return;
	}
	const save = (model: ModelRef) => {
		writePolicy({
			...readPolicy(root),
			modelOverrides: { ...readPolicy(root).modelOverrides, [agent]: model },
		});
		api.ui.dialog.clear();
		api.ui.toast({
			variant: "success",
			message: `${agent} will use ${model.providerID}/${model.modelID} in this session.`,
		});
	};
	api.ui.dialog.replace(() =>
		api.ui.DialogSelect({
			title: `Session model for ${agent}`,
			placeholder: "Search models by name or provider/model",
			flat: true,
			current: current ? `${current.providerID}/${current.modelID}` : undefined,
			options: choices.map((choice) => ({
				title: `${choice.title} · ${choice.key}`,
				value: choice.key,
				category: choice.provider,
				description:
					choice.key === `${current?.providerID}/${current?.modelID}`
						? `Current session override${current?.variant ? ` · ${current.variant}` : ""}`
						: choice.key,
			})),
			onSelect(option) {
				const choice = choices.find((item) => item.key === option.value);
				if (choice) chooseVariant(api, choice, current, save);
			},
		}),
	);
}

function chooseAgentForModel(api: TuiPluginApi, root: string): void {
	const names = agentNames(api);
	if (names.length === 0) {
		api.ui.toast({
			variant: "warning",
			message: "No subagents are configured.",
		});
		return;
	}
	const policy = readPolicy(root);
	api.ui.dialog.replace(() =>
		api.ui.DialogSelect({
			title: "Choose a subagent",
			options: names.map((name) => {
				const model = policy.modelOverrides[name];
				return {
					title: name,
					value: name,
					description: model
						? `${model.providerID}/${model.modelID}${model.variant ? ` · ${model.variant}` : ""}`
						: "Uses its configured default",
				};
			}),
			onSelect(option) {
				chooseModel(api, root, option.value);
			},
		}),
	);
}

function chooseAgentBlock(api: TuiPluginApi, root: string): void {
	const names = agentNames(api);
	const policy = readPolicy(root);
	api.ui.dialog.replace(() =>
		api.ui.DialogSelect({
			title: "Choose a subagent",
			options: names.map((name) => {
				const access = policy.agentAccess[name];
				return {
					title: name,
					value: name,
					description: access
						? `Session override: ${access}`
						: "Uses its configured default",
				};
			}),
			onSelect(option) {
				chooseAgentAccess(api, root, option.value);
			},
		}),
	);
}

function chooseAgentAccess(
	api: TuiPluginApi,
	root: string,
	agent: string,
): void {
	const current = readPolicy(root).agentAccess[agent] ?? "default";
	api.ui.dialog.replace(() =>
		api.ui.DialogSelect({
			title: `Delegation to ${agent}`,
			current,
			options: [
				{
					title: "Use configured default",
					value: "default",
					description: "Remove this session override",
				},
				{
					title: "Allow",
					value: "allow",
					description: "Permit this subagent in the current session tree",
				},
				{
					title: "Deny",
					value: "deny",
					description: "Block this subagent in the current session tree",
				},
			],
			onSelect(option) {
				const policy = readPolicy(root);
				const agentAccess = { ...policy.agentAccess };
				if (option.value === "default") delete agentAccess[agent];
				else agentAccess[agent] = option.value as "allow" | "deny";
				writePolicy({ ...policy, agentAccess });
				api.ui.dialog.clear();
				api.ui.toast({
					variant: "success",
					message:
						option.value === "default"
							? `${agent} uses its configured delegation policy again.`
							: `${agent} is now ${option.value === "allow" ? "allowed" : "blocked"} in this session.`,
				});
			},
		}),
	);
}

function chooseGlobalAccess(api: TuiPluginApi, root: string): void {
	const current = readPolicy(root).delegation;
	api.ui.dialog.replace(() =>
		api.ui.DialogSelect({
			title: "Subagent delegation for this session",
			current,
			options: [
				{
					title: "Use configured defaults",
					value: "default",
					description: "Honor each agent's declarative task permissions",
				},
				{
					title: "Allow all",
					value: "allow",
					description:
						"Allow any configured subagent unless individually denied",
				},
				{
					title: "Deny all",
					value: "deny",
					description: "Deny every subagent unless individually allowed",
				},
			],
			onSelect(option) {
				writePolicy({
					...readPolicy(root),
					delegation: option.value as SessionPolicy["delegation"],
				});
				api.ui.dialog.clear();
				api.ui.toast({
					variant: "success",
					message: `Session delegation policy set to ${option.value}.`,
				});
			},
		}),
	);
}

function clearModelOverride(api: TuiPluginApi, root: string): void {
	const policy = readPolicy(root);
	const agents = Object.keys(policy.modelOverrides).sort();
	if (agents.length === 0) {
		api.ui.toast({
			variant: "info",
			message: "This session has no subagent model overrides.",
		});
		return;
	}
	api.ui.dialog.replace(() =>
		api.ui.DialogSelect({
			title: "Clear a session model override",
			options: agents.map((agent) => ({
				title: agent,
				value: agent,
				description: `${policy.modelOverrides[agent].providerID}/${policy.modelOverrides[agent].modelID}`,
			})),
			onSelect(option) {
				const current = readPolicy(root);
				const modelOverrides = { ...current.modelOverrides };
				delete modelOverrides[option.value];
				writePolicy({ ...current, modelOverrides });
				api.ui.dialog.clear();
				api.ui.toast({
					variant: "success",
					message: `${option.value} uses its configured default again.`,
				});
			},
		}),
	);
}

function showMenu(api: TuiPluginApi, root: string): void {
	const policy = readPolicy(root);
	const overrides = Object.keys(policy.modelOverrides).length;
	const accessOverrides = Object.keys(policy.agentAccess).length;
	api.ui.dialog.replace(() =>
		api.ui.DialogSelect({
			title: "Session subagent controls",
			options: [
				{
					title: "Set overall delegation",
					value: "set-all",
					description: `Current mode: ${policy.delegation}`,
				},
				{
					title: "Set one subagent's access",
					value: "set-agent",
					description: `${accessOverrides} session access override${accessOverrides === 1 ? "" : "s"}`,
				},
				{
					title: "Override a subagent model",
					value: "set-model",
					description: `${overrides} session model override${overrides === 1 ? "" : "s"}`,
				},
				{
					title: "Clear a subagent model override",
					value: "clear-model",
					description: "Return one subagent to its configured default",
				},
				{
					title: "Reset all session controls",
					value: "reset",
					description: "Restore declarative defaults for this session",
				},
			],
			onSelect(option) {
				if (option.value === "set-all") return chooseGlobalAccess(api, root);
				if (option.value === "set-agent") return chooseAgentBlock(api, root);
				if (option.value === "set-model") return chooseAgentForModel(api, root);
				if (option.value === "clear-model")
					return clearModelOverride(api, root);
				if (option.value === "reset") {
					writePolicy(emptyPolicy(root));
					api.ui.dialog.clear();
					api.ui.toast({
						variant: "success",
						message: "Session subagent controls reset to defaults.",
					});
				}
			},
		}),
	);
}

const tui: TuiPlugin = async (api) => {
	api.event.on("session.deleted", (event) => {
		if (
			!event.properties.info.parentID &&
			SAFE_ID.test(event.properties.info.id)
		) {
			rmSync(statePath(event.properties.info.id), { force: true });
		}
	});

	api.keymap.registerLayer({
		commands: [
			{
				namespace: "palette",
				name: "session.subagents",
				title: "Session subagent controls",
				desc: "Block delegation or override subagent models for this session only",
				category: "Session",
				slashName: "subagents",
				run() {
					const root = rootSessionID(api);
					if (!root) {
						api.ui.toast({
							variant: "warning",
							message: "Open a session before changing its subagent controls.",
						});
						return;
					}
					showMenu(api, root);
				},
			},
		],
		bindings: [],
	});
};

export default { id: "session-controls", tui };
