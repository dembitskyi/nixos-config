# Permissive bash policy for trusted sub-agents
{
  "*" = "allow";

  # Network egress — prefer the ai-search / fetch MCP tools.
  "curl*" = "ask";
  "wget*" = "ask";

  # GitHub CLI — use the GitHub MCP tools instead.
  "gh *" = "deny";

  # Privilege escalation / system mutation.
  "sudo *" = "deny";
  "nixos-rebuild*" = "deny";
  "nix-collect-garbage*" = "deny";

  # Irreversible disk operations.
  "dd *" = "deny";
  "mkfs*" = "deny";
  "shred *" = "deny";

  # Destructive: recursive removal of absolute paths, and history-rewriting git.
  "rm -rf /*" = "ask";
  "git push --force*" = "ask";
  "git reset --hard*" = "ask";
}
