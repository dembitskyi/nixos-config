# Read-only bash policy for background research sub-agents (e.g. explorer).
#
# Deny-by-default rather than ask-by-default: these agents run as detached
# background lanes, where a permission prompt cannot reach the user. An `ask`
# there either stalls the lane or is auto-denied, so it only wastes a turn —
# an immediate `deny` at least tells the model to try another approach.
#
# Only inspection commands that cannot mutate state are allowed. Anything that
# writes, escalates, or reaches the network is denied by the `"*"` fallback.
#
# The `rtk ` twins exist because the rtk plugin rewrites commands in
# `tool.execute.before`, which runs BEFORE the permission check — so the
# matcher sees the rewritten form. See plugins/rtk.ts and permission.nix.
# Note rtk renames some commands: cat/head/tail -> `rtk read`, rg -> `rtk grep`.
{
  "*" = "deny";

  # Filesystem inspection.
  "du *" = "allow";
  "file *" = "allow";
  "find *" = "allow";
  "ls *" = "allow";
  "stat *" = "allow";
  "tree *" = "allow";
  "wc *" = "allow";

  # Content inspection.
  "cat *" = "allow";
  "cut *" = "allow";
  "grep *" = "allow";
  "head *" = "allow";
  "jq *" = "allow";
  "rg *" = "allow";
  "sed *" = "allow";
  "sort *" = "allow";
  "tail *" = "allow";
  "tr *" = "allow";
  "uniq *" = "allow";

  # Read-only git, including the `-C <dir>` form used to survey sibling repos.
  "git blame *" = "allow";
  "git cat-file *" = "allow";
  "git describe *" = "allow";
  "git diff *" = "allow";
  "git log *" = "allow";
  "git ls-files *" = "allow";
  "git ls-tree *" = "allow";
  "git rev-parse *" = "allow";
  "git shortlog *" = "allow";
  "git show *" = "allow";
  "git status *" = "allow";
  "git -C * blame *" = "allow";
  "git -C * describe *" = "allow";
  "git -C * diff *" = "allow";
  "git -C * log *" = "allow";
  "git -C * ls-files *" = "allow";
  "git -C * rev-parse *" = "allow";
  "git -C * shortlog *" = "allow";
  "git -C * show *" = "allow";
  "git -C * status *" = "allow";

  # rtk-rewritten twins of the above.
  "rtk du *" = "allow";
  "rtk find *" = "allow";
  "rtk grep *" = "allow";
  "rtk ls *" = "allow";
  "rtk read *" = "allow";
  "rtk tree *" = "allow";
  "rtk wc *" = "allow";
  "rtk git blame *" = "allow";
  "rtk git diff *" = "allow";
  "rtk git log *" = "allow";
  "rtk git show *" = "allow";
  "rtk git status *" = "allow";
  "rtk git -C * diff *" = "allow";
  "rtk git -C * log *" = "allow";
  "rtk git -C * show *" = "allow";
  "rtk git -C * status *" = "allow";
}
