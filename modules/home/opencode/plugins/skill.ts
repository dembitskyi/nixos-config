// /skill — fuzzy-pick a skill from the local pool and load it into the prompt.
//
// Registers a palette/slash command that suspends the TUI renderer, hands the
// terminal to the external `skill-picker` (fzf) UI, then appends the chosen
// (optionally edited) SKILL.md into the current prompt via the TUI control API.
// Suspending/resuming the renderer around the child mirrors opencode's own
// external-editor flow, which is what lets fzf draw over the TUI.

import type { TuiPlugin } from "@opencode-ai/plugin/tui"

// Baked to the skill-picker store path at build time.
const PICKER = "@skillPicker@"

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "skill.pick",
        title: "Load skill",
        desc: "Fuzzy-pick a skill from the pool and load it",
        category: "Skills",
        slashName: "skill",
        async run() {
          const renderer = api.renderer

          // opencode re-queries the terminal's pixel size on resize
          // (SIGWINCH -> queryPixelResolution -> `CSI 14t`). While fzf owns the
          // tty, that reply lands in fzf's query as stray characters (e.g.
          // "1003;936t") whenever the window is resized (e.g. Alt+Enter
          // maximize). Silence SIGWINCH in this process for the lifetime of the
          // picker so no such query is issued, then restore the handlers and
          // re-sync in case the window changed size.
          const sigwinch = process.listeners("SIGWINCH")
          process.removeAllListeners("SIGWINCH")

          renderer.suspend()
          renderer.currentRenderBuffer.clear()

          let output = ""
          let code = 1
          try {
            const proc = Bun.spawn([PICKER], {
              stdin: "inherit",
              stdout: "pipe",
              stderr: "inherit",
              env: { ...process.env },
            })
            output = await new Response(proc.stdout).text()
            code = await proc.exited
          } catch (error) {
            api.ui.toast({ variant: "error", message: `skill picker failed: ${String(error)}` })
            code = 1
          } finally {
            renderer.currentRenderBuffer.clear()
            renderer.resume()
            process.removeAllListeners("SIGWINCH")
            for (const handler of sigwinch) process.on("SIGWINCH", handler as NodeJS.SignalsListener)
            process.emit("SIGWINCH")
            renderer.requestRender()
          }

          // Non-zero exit means the user cancelled (Esc) or the picker failed.
          if (code !== 0) return

          const text = output.replace(/\s+$/, "")
          if (!text) {
            api.ui.toast({ variant: "warning", message: "No skill content" })
            return
          }

          await api.client.tui.appendPrompt({
            directory: api.state.path.directory,
            text: text + "\n",
          })
        },
      },
    ],
    bindings: [],
  })
}

export default { id: "skill-picker", tui }
