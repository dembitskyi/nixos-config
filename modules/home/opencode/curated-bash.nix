# Shell policy shared by opencode (permissions.nix), Claude Code and Codex.
# Allow-by-default: an enumerated allow-list is unmaintainable because each
# segment of a compound command is checked separately, so one unlisted `echo`
# makes the whole line prompt. The real boundary is the systemd AI sandbox
# (see modules/nixos/ai-sandbox). Only genuinely destructive or
# unattended-unsafe commands are named here, plus read-only exceptions to them.
{
  "*" = "allow";

  # GitHub CLI — use the GitHub MCP tools instead.
  "gh*" = "deny";

  # Privilege escalation and system/store mutation.
  "sudo *" = "deny";
  "nixos-rebuild*" = "deny";
  "nix build*" = "deny";
  "nix profile*" = "deny";
  "nix-collect-garbage*" = "deny";
  "nix-env*" = "deny";
  "nix-store*" = "deny";
  "nh os boot*" = "deny";
  "nh os switch*" = "deny";
  "nh os test*" = "deny";

  # Read-only queries. Only opencode applies allow entries; Claude Code and
  # Codex take just the denies.
  "nixos-rebuild list-generations*" = "allow";
  "nix profile list*" = "allow";
  "nix profile history*" = "allow";
  "nix profile diff-closures*" = "allow";
  "nix-env -q*" = "allow";
  "nix-env --query*" = "allow";
  "nix-env --list-generations*" = "allow";
  "nix-store -q*" = "allow";
  "nix-store --query*" = "allow";
  "nix-store -l*" = "allow";
  "nix-store --read-log*" = "allow";
  "nix-store --verify-path*" = "allow";
  "nix-store --print-env*" = "allow";
  "nix-store --gc --print*" = "allow";

  # Irreversible disk operations.
  "dd *" = "deny";
  "mkfs*" = "deny";
  "shred *" = "deny";

  # Destructive but occasionally needed — confirm interactively.
  "nh os build*" = "ask";
  "rm -rf /*" = "ask";
  "git push --force*" = "ask";
  "git reset --hard*" = "ask";
}
