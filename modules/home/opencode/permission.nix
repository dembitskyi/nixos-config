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
      bash = {
        "alejandra *" = "allow";
        "cat *" = "allow";
        "cd *" = "allow";
        "bat *" = "allow";
        "cut *" = "allow";
        "file *" = "allow";
        "find *" = "allow";
        "fzf *" = "allow";
        "gh*" = "deny";
        "git diff *" = "allow";
        "git log *" = "allow";
        "git show *" = "allow";
        "git stash list *" = "allow";
        "git status *" = "allow";
        "git*" = "ask";
        "grep *" = "allow";
        "head *" = "allow";
        "journalctl*" = "allow";
        "jq *" = "allow";
        "less *" = "allow";
        "ls*" = "allow";
        "lsd*" = "allow";
        "man *" = "allow";
        "nh os build*" = "ask";
        "nh search*" = "allow";
        "nh*" = "deny";
        "nil diagnostics*" = "allow";
        "nil parse*" = "allow";
        "nil*" = "ask";
        "nix eval*" = "allow";
        "nix*" = "deny";
        "nixos-rebuild*" = "deny";
        "ps *" = "allow";
        "pwd*" = "allow";
        "rg*" = "allow";
        "sed *" = "allow";
        "sort *" = "allow";
        "systemctl list-units*" = "allow";
        "systemctl list-timers*" = "allow";
        "systemctl status*" = "allow";
        "tail *" = "allow";
        "tree*" = "allow";
        "tr *" = "allow";
        "uniq *" = "allow";
        "wc *" = "allow";
        "z *" = "allow";
        "curl*" = "deny";
        "wget*" = "deny";
        "*" = "ask";
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
