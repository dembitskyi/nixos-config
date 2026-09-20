// biome-ignore-all lint/suspicious/noExplicitAny: Test doubles intentionally model only the plugin API surface under test.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logPath } from "./log";
import sessionControls from "./server";
import sessionControlsTui from "./tui";

afterEach(() => {
	delete process.env.OPENCODE_SESSION_POLICY_DIR;
	delete process.env.OPENCODE_SESSION_CONTROLS_LOG_DIR;
});

function policyDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "session-controls-"));
	process.env.OPENCODE_SESSION_POLICY_DIR = dir;
	return dir;
}

function writePolicy(
	dir: string,
	rootSessionID: string,
	input: {
		delegation?: "default" | "allow" | "deny";
		agentAccess?: Record<string, "allow" | "deny">;
		modelOverrides?: Record<
			string,
			{ providerID: string; modelID: string; variant?: string }
		>;
	},
): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${rootSessionID}.json`),
		JSON.stringify({
			version: 1,
			rootSessionID,
			delegation: input.delegation ?? "default",
			agentAccess: input.agentAccess ?? {},
			modelOverrides: input.modelOverrides ?? {},
			updatedAt: Date.now(),
		}),
	);
}

interface TestSession {
	parentID?: string;
	agent?: string;
	permission?: Array<{
		permission: string;
		pattern: string;
		action: "allow" | "ask" | "deny";
	}>;
}

function serverApi(sessions: Record<string, TestSession> = {}) {
	return {
		client: {
			session: {
				async get({ path }: { path: { id: string } }) {
					return { data: { id: path.id, ...sessions[path.id] } };
				},
			},
		},
	};
}

async function configure(hooks: any) {
	const config = {
		permission: {},
		agent: {
			build: {
				mode: "primary",
				permission: { task: { "*": "deny", vision: "allow" } },
			},
			generic: { mode: "all" },
			vision: { mode: "subagent" },
		},
	};
	await hooks.config(config);
	return config as any;
}

async function allowTask(hooks: any, sessionID: string, agent: string) {
	return hooks["tool.execute.before"](
		{ tool: "task", sessionID },
		{ args: { subagent_type: agent } },
	);
}

describe("session controls server", () => {
	test("blocks task dispatch only in the selected root session tree", async () => {
		const dir = policyDir();
		writePolicy(dir, "root", { delegation: "deny" });
		const hooks = await (sessionControls.server as any)(
			serverApi({ child: { parentID: "root", agent: "vision" } }),
		);
		await configure(hooks);

		await expect(allowTask(hooks, "child", "vision")).rejects.toThrow(
			"prohibits delegation",
		);
		await expect(allowTask(hooks, "other", "vision")).resolves.toBeUndefined();
	});

	test("preserves declarative defaults and allows an explicit session override", async () => {
		const dir = policyDir();
		const hooks = await (sessionControls.server as any)(
			serverApi({ root: { agent: "build" } }),
		);
		const config = await configure(hooks);

		expect(config.agent.build.permission.task).toEqual({ "*": "allow" });
		await expect(allowTask(hooks, "root", "generic")).rejects.toThrow(
			"generic",
		);
		await expect(allowTask(hooks, "root", "vision")).resolves.toBeUndefined();

		writePolicy(dir, "root", { agentAccess: { generic: "allow" } });
		await expect(allowTask(hooks, "root", "generic")).resolves.toBeUndefined();
	});

	test("preserves task permissions in the plugin snapshot before opening the runtime gate", async () => {
		policyDir();
		const hooks = await (sessionControls.server as any)(
			serverApi({ root: { agent: "build" } }),
		);
		const config = {
			permission: { task: { generic: "deny" } },
			agent: {
				build: { mode: "primary", permission: {} },
				generic: { mode: "all" },
			},
		};

		await hooks.config(config);

		expect((config.permission as any).task).toEqual({ "*": "allow" });
		await expect(allowTask(hooks, "root", "generic")).rejects.toThrow(
			"generic",
		);
	});

	test("an individual allow overrides deny-all and an individual deny overrides allow-all", async () => {
		const dir = policyDir();
		const hooks = await (sessionControls.server as any)(
			serverApi({ root: { agent: "build" } }),
		);
		await configure(hooks);

		writePolicy(dir, "root", {
			delegation: "deny",
			agentAccess: { vision: "allow" },
		});
		await expect(allowTask(hooks, "root", "vision")).resolves.toBeUndefined();
		await expect(allowTask(hooks, "root", "generic")).rejects.toThrow(
			"generic",
		);

		writePolicy(dir, "root", {
			delegation: "allow",
			agentAccess: { vision: "deny" },
		});
		await expect(allowTask(hooks, "root", "generic")).resolves.toBeUndefined();
		await expect(allowTask(hooks, "root", "vision")).rejects.toThrow("vision");
	});

	test("fails closed when it cannot resolve the session tree", async () => {
		policyDir();
		const hooks = await (sessionControls.server as any)({
			client: {
				session: {
					async get() {
						throw new Error("unavailable");
					},
				},
			},
		});
		await configure(hooks);

		await expect(allowTask(hooks, "missing", "vision")).rejects.toThrow(
			"unavailable",
		);
	});

	test("applies a model and variant override to child messages", async () => {
		const dir = policyDir();
		process.env.OPENCODE_SESSION_CONTROLS_LOG_DIR = mkdtempSync(
			join(tmpdir(), "session-controls-log-test-"),
		);
		writePolicy(dir, "root", {
			modelOverrides: {
				vision: {
					providerID: "provider",
					modelID: "vision-model",
					variant: "high",
				},
			},
		});
		const hooks = await (sessionControls.server as any)(
			serverApi({ child: { parentID: "root", agent: "vision" } }),
		);
		await configure(hooks);
		const output: {
			message: {
				agent: string;
				model?: { providerID: string; modelID: string; variant?: string };
			};
		} = {
			message: {
				agent: "vision",
				model: { providerID: "preset", modelID: "preset-model" },
			},
		};

		await hooks["chat.message"](
			{ sessionID: "child", agent: "vision" },
			output,
		);
		expect(output.message.model).toEqual({
			providerID: "provider",
			modelID: "vision-model",
			variant: "high",
		});
		const entries = readFileSync(logPath(), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "model.override-applied",
				sessionID: "child",
				rootSessionID: "root",
				agent: "vision",
				overrideModel: {
					providerID: "provider",
					modelID: "vision-model",
					variant: "high",
				},
			}),
		);
	});

	test("inherits model overrides through multiple child generations", async () => {
		const dir = policyDir();
		writePolicy(dir, "root", {
			modelOverrides: {
				generic: { providerID: "provider", modelID: "generic-model" },
			},
		});
		const hooks = await (sessionControls.server as any)(
			serverApi({
				child: { parentID: "root", agent: "generic" },
				grandchild: { parentID: "child", agent: "generic" },
			}),
		);
		await configure(hooks);
		const output: any = { message: { agent: "generic", model: undefined } };

		await hooks["chat.message"](
			{ sessionID: "grandchild", agent: "generic" },
			output,
		);
		expect(output.message.model).toEqual({
			providerID: "provider",
			modelID: "generic-model",
		});
	});

	test("does not apply child model overrides to the root session", async () => {
		const dir = policyDir();
		writePolicy(dir, "root", {
			modelOverrides: {
				vision: { providerID: "provider", modelID: "vision-model" },
			},
		});
		const hooks = await (sessionControls.server as any)(serverApi());
		await configure(hooks);
		const output = { message: { agent: "vision", model: undefined } };

		await hooks["chat.message"]({ sessionID: "root", agent: "vision" }, output);
		expect(output.message.model).toBeUndefined();
	});

	test("injects the active runtime policy into the root prompt", async () => {
		const dir = policyDir();
		writePolicy(dir, "root", {
			agentAccess: { generic: "allow", vision: "deny" },
			modelOverrides: {
				vision: {
					providerID: "provider",
					modelID: "vision-model",
					variant: "high",
				},
			},
		});
		const hooks = await (sessionControls.server as any)(
			serverApi({ root: { agent: "build" } }),
		);
		await configure(hooks);
		const output = { system: [] as string[] };

		await hooks["experimental.chat.system.transform"](
			{ sessionID: "root" },
			output,
		);
		expect(output.system.join("\n")).toContain(
			"Explicitly allowed subagents: generic.",
		);
		expect(output.system.join("\n")).toContain(
			"Explicitly denied subagents: vision.",
		);
		expect(output.system.join("\n")).toContain(
			"vision=provider/vision-model (high)",
		);
	});
});

function tuiApi(rootSessionID: string) {
	const commands: any[] = [];
	const dialog = {
		render: undefined as undefined | (() => any),
		replace(render: () => any) {
			dialog.render = render;
		},
		clear() {},
	};
	const api = {
		route: {
			current: { name: "session", params: { sessionID: rootSessionID } },
		},
		state: {
			path: { directory: "/workspace" },
			config: {
				agent: {
					build: { mode: "primary" },
					generic: { mode: "all" },
					vision: { mode: "subagent" },
				},
			},
			provider: [],
			session: { get: () => ({ id: rootSessionID }) },
		},
		event: { on() {} },
		keymap: {
			registerLayer(layer: { commands: any[] }) {
				commands.push(...layer.commands);
			},
		},
		ui: {
			dialog,
			DialogSelect: (props: any) => props,
			toast() {},
		},
	};
	return { api, commands, dialog };
}

describe("session controls TUI", () => {
	test("writes policy for the active session and reset removes it", async () => {
		const dir = policyDir();
		const { api, commands, dialog } = tuiApi("root");
		await (sessionControlsTui.tui as any)(api);
		const command = commands.find((item) => item.name === "session.subagents");

		command.run();
		let props = dialog.render?.();
		expect(props).toBeDefined();
		props.onSelect({ value: "set-all" });
		props = dialog.render?.();
		expect(props).toBeDefined();
		props.onSelect({ value: "deny" });
		expect(
			JSON.parse(readFileSync(join(dir, "root.json"), "utf8")).delegation,
		).toBe("deny");

		command.run();
		props = dialog.render?.();
		expect(props).toBeDefined();
		props.onSelect({ value: "reset" });
		expect(() => readFileSync(join(dir, "root.json"), "utf8")).toThrow();
	});

	test("allows an individual subagent for the active session", async () => {
		const dir = policyDir();
		const { api, commands, dialog } = tuiApi("root");
		await (sessionControlsTui.tui as any)(api);
		const command = commands.find((item) => item.name === "session.subagents");

		command.run();
		let props = dialog.render?.();
		props.onSelect({ value: "set-agent" });
		props = dialog.render?.();
		props.onSelect({ value: "generic" });
		props = dialog.render?.();
		props.onSelect({ value: "allow" });

		expect(
			JSON.parse(readFileSync(join(dir, "root.json"), "utf8")).agentAccess,
		).toEqual({ generic: "allow" });
	});
});

test("loads session controls after model-routing server plugins", () => {
	const source = readFileSync(
		new URL("../../default.nix", import.meta.url),
		"utf8",
	);
	const settings = source.indexOf("settings = {");
	const pluginList = source.indexOf("plugin = [", settings);
	const end = source.indexOf('share = "disabled";', pluginList);
	const block = source.slice(pluginList, end);
	const sessionControls = block.indexOf("sessionControlsPlugin}/server.ts");

	expect(settings).toBeGreaterThanOrEqual(0);
	expect(pluginList).toBeGreaterThan(settings);
	expect(end).toBeGreaterThan(pluginList);
	expect(sessionControls).toBeGreaterThan(block.indexOf("orchestrator.ts"));
	expect(sessionControls).toBeGreaterThan(block.indexOf("autopilotPlugin"));
});

test("persists plugin-selected models after the chat.message hook", () => {
	const patch = readFileSync(
		new URL(
			"../../../../../overlays/custom-packages/opencode/06-chat-hook-session-model.patch",
			import.meta.url,
		),
		"utf8",
	);
	const triggerContext = patch.indexOf(
		"{ message: info, parts: resolvedParts }",
	);
	const persistence = patch.indexOf("sessions.setAgentModel", triggerContext);

	expect(triggerContext).toBeGreaterThanOrEqual(0);
	expect(persistence).toBeGreaterThan(triggerContext);
});
