# Curated, read-only/inspection bash allow-list.
#
# A sub-agent that declares its own `permission.bash` REPLACES the global
# allow-list (opencode does not merge them), so it would otherwise have to
# `ask` for every common inspection command. Spread this set into such
# agents' bash blocks (e.g. `curatedAgentBash // { "git *" = "allow"; }`) to
# restore sane, low-risk defaults. Host-specific tools (e.g. `rtk`) belong in
# the host's `extraAgentPermissions`, not here.
{
  "which *" = "allow";
  "command -v *" = "allow";
  "type *" = "allow";
  "cat *" = "allow";
  "head *" = "allow";
  "tail *" = "allow";
  "grep *" = "allow";
  "rg *" = "allow";
  "find *" = "allow";
  "ls *" = "allow";
  "cut *" = "allow";
  "wc *" = "allow";
  "jq *" = "allow";
  "sed *" = "allow";
  "sort *" = "allow";
  "diff *" = "allow";
  "sleep *" = "allow";
  "rm -f /tmp/*" = "allow";
}
