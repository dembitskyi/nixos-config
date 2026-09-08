# OpenCode local source patches, layered on top of the upstream package (which
# is pinned by the `opencode-pin` overlay). Split into its own file because the
# postPatch carries several multi-line TUI/tool patches. Consumed by
# custom-packages/default.nix as `opencode = import ./opencode.nix prev;`.
#
# Each patch uses `--replace-fail`, so an upstream change that moves an anchor
# fails the build loudly instead of silently dropping the patch.
prev:
prev.opencode.overrideAttrs (old: {
  postPatch = (old.postPatch or "") + ''
    # Bump TUI message fetch limit from 100 to 1000.
    substituteInPlace packages/tui/src/context/sync.tsx \
      --replace-fail 'limit: 100' 'limit: 1000'
    # Return promptly when the wrapper shell dies by signal instead of
    # hanging until the tool timeout. A self-matching `pkill -f` SIGTERMs
    # its own `bash -c` wrapper, which makes `handle.exitCode` fail, and
    # `Effect.raceAll` below ignores failures while another racer could
    # still succeed. Map signal death to the conventional exit 143.
    substituteInPlace packages/opencode/src/tool/shell.ts \
      --replace-fail 'handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code })))' 'handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code })), Effect.orElseSucceed(() => ({ kind: "exit" as const, code: 143 })))'
    # Preserve the session's model on background-subagent completion. The
    # result is injected as a new user message on the PARENT session without a
    # model, so createUserMessage resolves `input.model ?? ag.model ?? …` and
    # silently reverts to the agent's default model — dropping a model the user
    # picked while the task ran. Pass the parent session's current model.
    substituteInPlace packages/opencode/src/tool/task.ts \
      --replace-fail 'agent: currentParent.agent ?? ctx.agent,' 'agent: currentParent.agent ?? ctx.agent, model: currentParent.model ? { providerID: currentParent.model.providerID, modelID: currentParent.model.id } : undefined,'
    # Add a `session.child.active` command that jumps to the first RUNNING
    # (busy/retry) child session, so ctrl+g can target only active subagents
    # while ctrl+shift+g keeps the "first child (any)" behaviour. Falls back to
    # a toast when nothing is active, so the key never no-ops silently.
    substituteInPlace packages/tui/src/config/keybind.ts \
      --replace-fail 'session_child_first: keybind("<leader>down", "Go to first child session"),' 'session_child_first: keybind("<leader>down", "Go to first child session"),
      session_child_active: keybind("none", "Go to first active (running) child session"),
      session_child_cycle_all: keybind("none", "Cycle to next child session (any)"),
      session_child_cycle_reverse_all: keybind("none", "Cycle to previous child session (any)"),
      session_subagents_count: keybind("none", "Show active subagent count"),
      session_child_cancel: keybind("none", "Cancel the current subagent"),'
    substituteInPlace packages/tui/src/config/keybind.ts \
      --replace-fail 'session_child_first: "session.child.first",' 'session_child_first: "session.child.first",
      session_child_active: "session.child.active",
      session_child_cycle_all: "session.child.next.all",
      session_child_cycle_reverse_all: "session.child.previous.all",
      session_subagents_count: "session.subagents.count",
      session_child_cancel: "session.child.cancel",'
    substituteInPlace packages/tui/src/routes/session/index.tsx \
      --replace-fail 'const sessionBindingCommands = [' 'const sessionBindingCommands = [
      "session.child.active",
      "session.child.next.all",
      "session.child.previous.all",
      "session.subagents.count",
      "session.child.cancel",'
    substituteInPlace packages/tui/src/routes/session/index.tsx \
      --replace-fail 'const sessionCommandList = createMemo(() => [' 'const sessionCommandList = createMemo(() => [
      {
        title: "Go to active subagent",
        value: "session.child.active",
        category: "Session",
        hidden: true,
        run: () => {
          dialog.clear()
          const target = children().find((x) => {
            if (!x.parentID) return false
            const t = sync.data.session_status[x.id]?.type
            return t === "busy" || t === "retry"
          })
          if (target) enterChild(target.id)
          else toast.show({ message: "No active subagents", variant: "info" })
        },
      },
      {
        title: "Next subagent (any)",
        value: "session.child.next.all",
        category: "Session",
        hidden: true,
        run: () => {
          dialog.clear()
          const s = children().filter((x) => !!x.parentID)
          if (s.length <= 1) return
          let n = s.findIndex((x) => x.id === session()?.id) - 1
          if (n >= s.length) n = 0
          if (n < 0) n = s.length - 1
          if (s[n]) enterChild(s[n].id)
        },
      },
      {
        title: "Previous subagent (any)",
        value: "session.child.previous.all",
        category: "Session",
        hidden: true,
        run: () => {
          dialog.clear()
          const s = children().filter((x) => !!x.parentID)
          if (s.length <= 1) return
          let n = s.findIndex((x) => x.id === session()?.id) + 1
          if (n >= s.length) n = 0
          if (n < 0) n = s.length - 1
          if (s[n]) enterChild(s[n].id)
        },
      },
      {
        title: "Count active subagents",
        value: "session.subagents.count",
        category: "Session",
        hidden: true,
        run: () => {
          const n = children().filter((x) => {
            if (!x.parentID) return false
            const t = sync.data.session_status[x.id]?.type
            return t === "busy" || t === "retry"
          }).length
          toast.show({ message: n === 1 ? "1 active subagent" : n + " active subagents", variant: "info" })
        },
      },
      {
        title: "Cancel subagent",
        value: "session.child.cancel",
        category: "Session",
        hidden: true,
        run: () => {
          dialog.clear()
          const s = session()
          if (!s?.parentID) { toast.show({ message: "Not in a subagent session", variant: "warning" }); return }
          const st = sync.data.session_status?.[s.id]?.type
          if (!st || st === "idle") { toast.show({ message: "Subagent is not running", variant: "info" }); return }
          void sdk.client.session.abort({ sessionID: s.id }).catch(() => {})
          toast.show({ message: "Cancelling subagent…", variant: "info" })
        },
      },'
    # Make left/right (session.child.next/previous) cycle ONLY active
    # (running) subagents; shift+left/right cycle all children via the
    # session.child.next.all/previous.all commands above. Keeps the `sessions`
    # variable name so the rest of moveChild is unchanged.
    substituteInPlace packages/tui/src/routes/session/index.tsx \
      --replace-fail 'const sessions = children().filter((x) => !!x.parentID)' 'const sessions = children().filter((x) => { if (!x.parentID) return false; const t = sync.data.session_status[x.id]?.type; return t === "busy" || t === "retry" })'
  '';
})
