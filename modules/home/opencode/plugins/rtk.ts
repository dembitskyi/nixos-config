// RTK OpenCode plugin — rewrites commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH.
//
// This is a thin delegating plugin: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.

// Providers whose tokens are free (local models); rtk's token-saving rewrites
// buy nothing there, so the rewrite is skipped. tool.execute.before carries no
// model, so the active provider is captured per session in chat.message.
const LOCAL_PROVIDERS = new Set(["vllm", "ollama"])

export const RtkOpenCodePlugin = async ({ $ }) => {
  try {
    await $`which rtk`.quiet()
  } catch {
    console.warn("[rtk] rtk binary not found in PATH — plugin disabled")
    return {}
  }

  const sessionProvider = new Map<string, string>()

  return {
    "chat.message": async (input) => {
      const provider = input?.model?.providerID
      if (input?.sessionID && provider) {
        sessionProvider.set(input.sessionID, provider)
      }
    },
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell") return
      // Local (free-token) models gain nothing from rtk — leave their commands alone.
      const provider = sessionProvider.get(input?.sessionID ?? "")
      if (provider && LOCAL_PROVIDERS.has(provider)) return
      const args = output?.args
      if (!args || typeof args !== "object") return

      const command = (args as Record<string, unknown>).command
      if (typeof command !== "string" || !command) return

      try {
        const result = await $`rtk rewrite ${command}`.quiet().nothrow()
        const rewritten = String(result.stdout).trim()
        if (rewritten && rewritten !== command) {
          ;(args as Record<string, unknown>).command = rewritten
        }
      } catch {
        // rtk rewrite failed — pass through unchanged.
      }
    },
  }
}
