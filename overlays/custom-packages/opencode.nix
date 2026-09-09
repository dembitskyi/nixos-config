# OpenCode local source patches, layered on top of the upstream package (pinned
# by the `opencode-pin` overlay to anomalyco/opencode v1.18.29). Consumed by
# custom-packages/default.nix as `opencode = import ./opencode.nix prev;`.
#
# Patches live as reviewable unified diffs in ./opencode/*.patch and apply in the
# derivation's patchPhase. A patch whose context no longer matches after an
# upstream bump fails the build loudly (patch(1) exits non-zero) — bump the pin
# and regenerate from the new source rather than silently dropping a fix. Each
# diff was generated and verified against the exact pinned commit.
prev:
let
  # Flip to false to fall back to the unpatched pinned build.
  enablePatches = true;

  patches = [
    # TUI: retain the last 1000 messages in memory/scrollback (fetch + in-memory
    # cap + retained slice), not 100. Deliberately higher render/memory cost.
    ./opencode/01-tui-message-history.patch
    # shell tool: surface a signal-killed wrapper promptly via `raceAllFirst`
    # instead of hanging until the tool timeout. No fabricated exit codes; a
    # signal-terminated command becomes a tool error (may omit captured output).
    ./opencode/02-shell-exit-race.patch
    # TUI: subagent navigation/count/cancel — keybind slots plus command
    # implementations. Bound to ctrl+g / shift+arrows / F3 / F4 in
    # modules/home/opencode. Navigation is scoped to true siblings (a nested
    # subagent's parent is never counted as a sibling); cancel reports failures.
    ./opencode/03-tui-subagent-keybinds.patch
    ./opencode/04-tui-subagent-commands.patch
    # task tool: when a background subagent completes, preserve the parent
    # session's current model + variant instead of reverting to the agent
    # default. Falls back to the launch variant only for legacy sessions with no
    # stored model. Does not change the core prompt-admission path.
    ./opencode/05-task-preserve-model.patch
  ];
in
if !enablePatches then
  prev.opencode
else
  prev.opencode.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ patches;
  })
