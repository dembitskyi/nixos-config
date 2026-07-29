{
  config,
  lib,
  ...
}:
{
  config = lib.mkIf config.mine.home.opencode.enable {
    programs.opencode.settings.permission = lib.recursiveUpdate {
      external_directory = {
        "~/**" = "allow";
        "~/.local/**" = "allow";
        "/nix/**" = "allow";
        "/tmp/**" = "allow";
      };
      edit = {
        "/nix/**" = "deny";
        "*" = "allow";
      };
      # Allow-by-default, matching curated-bash.nix. An enumerated allow-list is
      # unmaintainable: opencode evaluates each segment of a compound command
      # separately, so one unlisted `echo` makes the whole line prompt. The real
      # boundary is the systemd sandbox (see modules/nixos/fastmcp), not this
      # list, so only genuinely destructive or unattended-unsafe commands are
      # named here.
      #
      # NOTE: Nix sorts these keys alphabetically and opencode's matcher picks
      # the alphabetically-LAST match (findLast), not the most specific one.
      # A broad "nix*" would therefore override a narrower "nix eval*", so the
      # entries below stay non-overlapping.
      #
      # The local rtk plugin (./plugins/rtk.ts) rewrites commands before the
      # permission check, so `git push` arrives as `rtk git push`; the rules
      # below are duplicated for that prefix where it matters.
      bash = {
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
      };
      skill = {
        "bash-pro" = "allow";
        "c-pro" = "allow";
        "cpp-pro" = "allow";
        "hyprland" = "allow";
        "nixos" = "allow";
        "*" = "deny";
      };
      # Deny webfetch in favor of the `fetch` MCP server.
      webfetch = "deny";
    } config.mine.home.opencode.extraPermissions;
  };
}
