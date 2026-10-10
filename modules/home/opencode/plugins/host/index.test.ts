import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin, { PROVIDER_ID, search, toResults } from "./index"

const dir = mkdtempSync(join(tmpdir(), "host-plugin-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fakeCommand(name: string, body: string) {
	const path = join(dir, name)
	writeFileSync(path, `#!/bin/sh\n${body}\n`)
	chmodSync(path, 0o755)
	return path
}

const output = {
	provider: "perplexity",
	query: "latest bun",
	answer_md: "Bun 2.0 is out.",
	citations: [{ title: "Bun blog", url: "https://bun.sh/blog" }],
	url: "https://www.perplexity.ai/search/abc",
}

describe("toResults", () => {
	test("puts the answer first and each citation after it", () => {
		expect(toResults(output)).toEqual([
			{
				url: "https://www.perplexity.ai/search/abc",
				title: "Perplexity answer: latest bun",
				content: "Bun 2.0 is out.",
				time: {},
			},
			{ url: "https://bun.sh/blog", title: "Bun blog", time: {} },
		])
	})
})

describe("search", () => {
	test("passes the provider and query after the option terminator", async () => {
		const command = fakeCommand(
			"echo-args",
			`printf '{"provider":"%s","query":"%s","answer_md":"","citations":[],"url":"u"}' "$2" "$5"`,
		)
		const results = await search(command, "google", "--weird query")
		expect(results[0].title).toBe("Google answer: --weird query")
	})

	test("reports the error printed by a failed search", async () => {
		const command = fakeCommand("fail", `echo '{"error":"no answer"}'; exit 1`)
		await expect(search(command, "perplexity", "q")).rejects.toThrow("ai-search (perplexity) failed: no answer")
	})

	test("rejects output that is not JSON", async () => {
		const command = fakeCommand("garbage", "echo nope")
		await expect(search(command, "perplexity", "q")).rejects.toThrow("invalid output")
	})
})

describe("setup", () => {
	test("registers the provider as default and scrubs secrets from shells", async () => {
		const providers: { id: string; name: string }[] = []
		let selected: string | false | undefined
		let shellHook: ((event: { env: Record<string, string | undefined> }) => void) | undefined
		await plugin.setup({
			options: { command: "/bin/ai-search", provider: "google" },
			websearch: {
				transform: async (callback) => {
					callback({
						add: (provider) => providers.push(provider),
						default: { set: (id) => (selected = id) },
					})
				},
			},
			shell: {
				hook: async (_name, callback) => {
					shellHook = callback
				},
			},
		})

		expect(providers.map((provider) => [provider.id, provider.name])).toEqual([[PROVIDER_ID, "AI search (google)"]])
		expect(selected).toBe(PROVIDER_ID)

		const env = { OPENCODE_PASSWORD: "secret", OPENCODE_SERVER_PASSWORD: "secret", PATH: "/bin" }
		shellHook?.({ env })
		expect(env).toEqual({ PATH: "/bin" })
	})
})
