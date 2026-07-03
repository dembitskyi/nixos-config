# Fuzzy skill picker backing the /skill opencode TUI plugin. Reads the skill
# pool (default ~/.cache/ai-skills, override via AI_SKILLS_DIR) and prints the
# chosen SKILL.md to stdout for the plugin to append into the prompt.
{
  writeShellApplication,
  fzf,
  findutils,
  coreutils,
}:
writeShellApplication {
  name = "skill-picker";
  runtimeInputs = [
    fzf
    findutils
    coreutils
  ];
  text = builtins.readFile ./scripts/skill-picker.sh;
}
