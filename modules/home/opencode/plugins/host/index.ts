// Host integration plugin for OpenCode V2:
// - Registers the ai-search CLI (Perplexity or Google AI driven over CDP in the
//   logged-in ai-browser) as the `ai-search` websearch provider, so the
//   built-in `websearch` tool uses it.
// - Keeps the server password out of the environment of shell commands.
//
// Loaded from the Nix store, where `@opencode/plugin` is not importable at
// runtime; `Plugin.define` is an identity helper, so the plugin default-exports
// its definition directly. Options come from the `plugins` entry in Nix.
import { execFile } from "node:child_process"

export interface SearchResult {
	url: string
	title?: string
	content?: string
	time: { published?: number }
}

interface SearchOutput {
	provider: string
	query: string
	answer_md: string
	citations: { title: string; url: string }[]
	url: string
}

interface HostContext {
	readonly options: Readonly<Record<string, unknown>>
	readonly websearch: {
		transform(
			callback: (editor: {
				add(provider: {
					id: string
					name: string
					execute(input: { query: string }, context: { signal: AbortSignal }): Promise<readonly SearchResult[]>
				}): void
				default: { set(id: string | false): void }
			}) => void,
		): Promise<unknown>
	}
	readonly shell: {
		hook(
			name: "create.before",
			callback: (event: { env: Record<string, string | undefined> }) => void,
		): Promise<unknown>
	}
}

export const PROVIDER_ID = "ai-search"

// Variables the server reads its password from; tools never need them.
const SECRETS = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]

/** The answer itself becomes the first result; each citation follows it. */
export function toResults(output: SearchOutput): SearchResult[] {
	const provider = output.provider.charAt(0).toUpperCase() + output.provider.slice(1)
	return [
		{ url: output.url, title: `${provider} answer: ${output.query}`, content: output.answer_md, time: {} },
		...output.citations.map((citation) => ({ url: citation.url, title: citation.title, time: {} })),
	]
}

/** Runs `ai-search --json`, which prints `{ error }` and exits non-zero when a search fails. */
export function search(command: string, provider: string, query: string, signal?: AbortSignal) {
	return new Promise<SearchResult[]>((resolve, reject) => {
		execFile(
			command,
			["--provider", provider, "--json", "--", query],
			{ signal, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout) => {
				let parsed: (SearchOutput & { error?: undefined }) | { error: string } | undefined
				try {
					parsed = JSON.parse(stdout)
				} catch {
					parsed = undefined
				}
				if (parsed && "error" in parsed && typeof parsed.error === "string") {
					reject(new Error(`ai-search (${provider}) failed: ${parsed.error}`))
					return
				}
				if (error || !parsed) {
					reject(new Error(`ai-search (${provider}) failed: ${error?.message ?? "invalid output"}`))
					return
				}
				resolve(toResults(parsed as SearchOutput))
			},
		)
	})
}

export default {
	id: "host",
	async setup(ctx: HostContext) {
		const command = String(ctx.options.command ?? "ai-search")
		const provider = String(ctx.options.provider ?? "perplexity")

		await ctx.websearch.transform((editor) => {
			editor.add({
				id: PROVIDER_ID,
				name: `AI search (${provider})`,
				execute: ({ query }, { signal }) => search(command, provider, query, signal),
			})
			editor.default.set(PROVIDER_ID)
		})

		await ctx.shell.hook("create.before", (event) => {
			for (const name of SECRETS) delete event.env[name]
		})
	},
}
