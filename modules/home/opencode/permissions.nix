# OpenCode V2 permission rules: ordered `{ action, resource, effect }` lists in
# which the last matching rule wins. Global rules apply first and each agent's
# rules are appended after them, so an agent that starts from a deny-all has to
# re-apply the safety exceptions after every action it allows again. Built-in
# agents (explore, general) also carry rules of their own, which come before the
# global ones: a global allow overrides their built-in denies.
{ lib }:
let
  rule = effect: action: resource: { inherit action resource effect; };
  allow = action: rule "allow" action "*";
  deny = action: rule "deny" action "*";

  # Shell is allow-by-default; curated-bash.nix lists the exceptions. The last
  # matching rule wins and attributes come sorted, so its allow entries, which
  # re-open part of a deny, are moved after the rest.
  shellExceptions = lib.sortOn (entry: if entry.effect == "allow" then 1 else 0) (
    lib.mapAttrsToList (pattern: effect: rule effect "shell" pattern) (
      removeAttrs (import ./curated-bash.nix) [ "*" ]
    )
  );
  shell = [ (allow "shell") ] ++ shellExceptions;

  # Secrets in .env files stay unreadable; examples remain readable.
  envReads = [
    (rule "deny" "read" "*.env")
    (rule "deny" "read" "*.env.*")
    (rule "allow" "read" "*.env.example")
  ];
  read = [ (allow "read") ] ++ envReads;

  # The edit action also covers the write and patch tools.
  edit = [
    (allow "edit")
    (rule "deny" "edit" "/nix/*")
  ];

  # Paths outside the session location that need no approval.
  externalDirectory = map (rule "allow" "external_directory") [
    "~/*"
    "/nix/*"
    "/tmp/*"
  ];

  # Actions that can touch paths outside the session location.
  fileActions = [
    "read"
    "glob"
    "grep"
    "edit"
    "shell"
  ];

  # Built-in tools exposed directly; everything else (MCP servers, plugin and
  # namespace tools) is reached through Code Mode's `execute` tool.
  directTools = [
    "read"
    "glob"
    "grep"
    "edit"
    "shell"
    "skill"
    "question"
    "subagent"
    "webfetch"
    "websearch"
    "compress"
  ];

  expand =
    action:
    if lib.hasPrefix "!" action then
      [ (deny (lib.removePrefix "!" action)) ]
    else
      {
        inherit shell read edit;
      }
      .${action} or [ (allow action) ];
in
{
  inherit
    rule
    allow
    deny
    envReads
    shellExceptions
    ;

  # Applied to every agent, built-in or custom, before its own rules.
  global =
    read
    ++ edit
    ++ shell
    ++ externalDirectory
    ++ [
      # No agent fetches URLs directly; web access goes through search or the browser.
      (deny "webfetch")
    ];

  # Deny everything, then allow `actions` (wildcards allowed, a `!` prefix
  # denies), keeping the safety exceptions of each allowed action.
  allowOnly =
    actions:
    let
      granted = lib.filter (action: !lib.hasPrefix "!" action) actions;
    in
    [ (rule "deny" "*" "*") ]
    ++ lib.optionals (lib.any (action: lib.elem action fileActions) granted) externalDirectory
    ++ lib.optional (lib.any (action: !lib.elem action directTools) granted) (allow "execute")
    ++ lib.concatMap expand actions;
}
