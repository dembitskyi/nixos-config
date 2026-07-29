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
      # NOTE: Nix sorts attribute-set keys alphabetically, and opencode's
      # matcher picks the alphabetically-LAST matching rule (findLast), not
      # the most specific one. Broad wildcards like "git*"/"nix*"/"nh*"/"nil*"
      # therefore silently override earlier, more specific allow rules
      # regardless of how they're written here. To keep intent correct we
      # avoid trailing catch-all wildcards for these commands and instead
      # enumerate the specific subcommands we mean to allow/deny; anything
      # unmatched still falls through to the global "*" = "ask" below.
      #
      # The local `rtk` plugin (./plugins/rtk.ts) rewrites most bash
      # commands BEFORE the permission check runs (tool.execute.before
      # fires first), so e.g. `cat foo` arrives here as `rtk read foo` and
      # `rg foo` arrives as `rtk grep foo`. The "rtk ..." twins below exist
      # solely to keep those rewritten read-only commands allowed; do not
      # remove them as duplicates, and never add a blanket "rtk*" = "allow"
      # since rtk also wraps write operations (e.g. `git push` -> `rtk git
      # push`), which would bypass every rule below.
      bash = {
        "alejandra *" = "allow";
        "bat *" = "allow";
        "cat *" = "allow";
        "cd *" = "allow";
        "curl*" = "deny";
        "cut *" = "allow";
        "file *" = "allow";
        "find *" = "allow";
        "fzf *" = "allow";
        "gh*" = "deny";
        # git: only read-only subcommands are allowed, both bare and via
        # `git -C <dir> <sub>`. Everything else (push, commit, checkout,
        # reset, rebase, merge, rm, clean, stash push/pop, tag, remote,
        # config, apply, am, cherry-pick, revert, fetch, pull, add, mv,
        # restore, switch, clone, init, ...) is intentionally left
        # unmatched and falls through to "*" = "ask".
        "git -C * blame *" = "allow";
        "git -C * cat-file *" = "allow";
        "git -C * describe *" = "allow";
        "git -C * diff *" = "allow";
        "git -C * grep *" = "allow";
        "git -C * log *" = "allow";
        "git -C * ls-files *" = "allow";
        "git -C * ls-tree *" = "allow";
        "git -C * merge-base *" = "allow";
        "git -C * rev-list *" = "allow";
        "git -C * rev-parse *" = "allow";
        "git -C * shortlog *" = "allow";
        "git -C * show *" = "allow";
        "git -C * stash list *" = "allow";
        "git -C * status *" = "allow";
        "git blame *" = "allow";
        "git cat-file *" = "allow";
        "git describe *" = "allow";
        "git diff *" = "allow";
        "git grep *" = "allow";
        "git log *" = "allow";
        "git ls-files *" = "allow";
        "git ls-tree *" = "allow";
        "git merge-base *" = "allow";
        "git rev-list *" = "allow";
        "git rev-parse *" = "allow";
        "git shortlog *" = "allow";
        "git show *" = "allow";
        "git stash list *" = "allow";
        "git status *" = "allow";
        "grep *" = "allow";
        "head *" = "allow";
        "journalctl*" = "allow";
        "jq *" = "allow";
        "less *" = "allow";
        "ls *" = "allow";
        "lsd *" = "allow";
        "man *" = "allow";
        "nh os boot*" = "deny";
        "nh os build*" = "ask";
        "nh os switch*" = "deny";
        "nh os test*" = "deny";
        "nh search*" = "allow";
        "nil diagnostics*" = "allow";
        "nil parse*" = "allow";
        # nix: only `nix eval` is allowed; anything that can build,
        # activate, or mutate the store is denied explicitly (a broad
        # "nix*" deny would otherwise alphabetically override "nix eval*").
        "nix build*" = "deny";
        "nix develop*" = "deny";
        "nix eval*" = "allow";
        "nix profile*" = "deny";
        "nix run*" = "deny";
        "nix shell*" = "deny";
        "nix-collect-garbage*" = "deny";
        "nix-env*" = "deny";
        "nix-shell*" = "deny";
        "nix-store*" = "deny";
        "nixos-rebuild*" = "deny";
        "ps *" = "allow";
        "pwd*" = "allow";
        "rg*" = "allow";
        "rtk du *" = "allow";
        "rtk find *" = "allow";
        "rtk git -C * blame *" = "allow";
        "rtk git -C * cat-file *" = "allow";
        "rtk git -C * describe *" = "allow";
        "rtk git -C * diff *" = "allow";
        "rtk git -C * grep *" = "allow";
        "rtk git -C * log *" = "allow";
        "rtk git -C * ls-files *" = "allow";
        "rtk git -C * ls-tree *" = "allow";
        "rtk git -C * merge-base *" = "allow";
        "rtk git -C * rev-list *" = "allow";
        "rtk git -C * rev-parse *" = "allow";
        "rtk git -C * shortlog *" = "allow";
        "rtk git -C * show *" = "allow";
        "rtk git -C * stash list *" = "allow";
        "rtk git -C * status *" = "allow";
        "rtk git blame *" = "allow";
        "rtk git cat-file *" = "allow";
        "rtk git describe *" = "allow";
        "rtk git diff *" = "allow";
        "rtk git grep *" = "allow";
        "rtk git log *" = "allow";
        "rtk git ls-files *" = "allow";
        "rtk git ls-tree *" = "allow";
        "rtk git merge-base *" = "allow";
        "rtk git rev-list *" = "allow";
        "rtk git rev-parse *" = "allow";
        "rtk git shortlog *" = "allow";
        "rtk git show *" = "allow";
        "rtk git stash list *" = "allow";
        "rtk git status *" = "allow";
        "rtk grep *" = "allow";
        "rtk ls *" = "allow";
        "rtk read *" = "allow";
        "rtk tree *" = "allow";
        "rtk wc *" = "allow";
        "sed *" = "allow";
        "sort *" = "allow";
        "systemctl list-units*" = "allow";
        "systemctl list-timers*" = "allow";
        "systemctl status*" = "allow";
        "tail *" = "allow";
        "tr *" = "allow";
        "tree *" = "allow";
        "uniq *" = "allow";
        "wc *" = "allow";
        "wget*" = "deny";
        "z *" = "allow";
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
