// AI-callable counterpart of the /search command. Loaded by opencode via a
// bare dynamic import, so it must avoid importing `@opencode-ai/plugin`
// (unresolvable outside opencode's own node_modules) and `bun`
// (runtime-specific). A plain object plus `node:child_process` keeps it
// portable. `@searchProvider@` is substituted from `searchProvider` at build.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export default {
  description:
    "Returns information from the internet with sources. If you need up-to-date information or information from the internet, use ai-search.",
  args: {
    query: {
      type: "string",
      description: "The search query or question to look up on the web.",
    },
  },
  async execute(args) {
    const { stdout } = await run(
      "ai-search",
      ["--provider", "@searchProvider@", args.query],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  },
};
