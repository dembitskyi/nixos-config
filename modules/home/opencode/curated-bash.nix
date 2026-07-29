# Bash policy for sub-agents that declare their own `permission.bash` (which
# replaces, not merges with, the global one in permission.nix). Kept in sync
# with that policy so an agent opting in is never *more* privileged than the
# default; see permission.nix for why this is allow-by-default.
{
  "*" = "allow";

  # GitHub CLI — use the GitHub MCP tools instead.
  "gh*" = "deny";

  # Privilege escalation and system/store mutation.
  "sudo *" = "deny";
  "nixos-rebuild*" = "deny";
  "nix build*" = "deny";
  "nix develop*" = "deny";
  "nix profile*" = "deny";
  "nix run*" = "deny";
  "nix shell*" = "deny";
  "nix-collect-garbage*" = "deny";
  "nix-env*" = "deny";
  "nix-shell*" = "deny";
  "nix-store*" = "deny";
  "nh os boot*" = "deny";
  "nh os switch*" = "deny";
  "nh os test*" = "deny";

  # Irreversible disk operations.
  "dd *" = "deny";
  "mkfs*" = "deny";
  "shred *" = "deny";

  # Destructive but occasionally needed — confirm interactively.
  "nh os build*" = "ask";
  "rm -rf /*" = "ask";
  "git push --force*" = "ask";
  "git reset --hard*" = "ask";
  "rtk git push --force*" = "ask";
  "rtk git reset --hard*" = "ask";
}
