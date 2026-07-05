#!/usr/bin/env bash
# Fuzzy-pick a skill from the local pool and print its SKILL.md to stdout.
#
# Driven by the /skill opencode TUI plugin: the plugin suspends the renderer,
# runs this picker (fzf owns the terminal), captures stdout, and appends the
# printed text into the prompt. Keys: Enter loads the skill as-is, Ctrl-P
# toggles a content preview, PgUp/PgDn/Home/End scroll the preview, Ctrl-E edits
# a copy in $EDITOR first, Esc cancels (exit 130, no output). alt-enter is
# ignored so the window manager's Alt shortcut does not leak into the query.

pool="${AI_SKILLS_DIR:-$HOME/.cache/ai-skills}"

if [ ! -d "$pool" ]; then
  echo "skill-picker: skill pool not found: $pool" >&2
  exit 2
fi

# Emit "path<TAB>name" for every SKILL.md in the pool. The name is the skill's
# directory; the path (hidden from the list) backs the preview.
list_skills() {
  find -L "$pool" -type f -name SKILL.md 2>/dev/null | while IFS= read -r file; do
    printf '%s\t%s\n' "$file" "$(basename "$(dirname "$file")")"
  done
}

selection=$(
  list_skills | fzf \
    --delimiter='\t' \
    --with-nth=2 \
    --preview='cat {1}' \
    --preview-window='right,60%,wrap,hidden' \
    --bind='alt-enter:ignore' \
    --bind='ctrl-p:toggle-preview' \
    --bind='pgup:preview-page-up,pgdn:preview-page-down,home:preview-top,end:preview-bottom' \
    --prompt='skill> ' \
    --header='Enter: load   Ctrl-P: preview   PgUp/PgDn/Home/End: scroll   Ctrl-E: edit   Esc: cancel' \
    --expect=ctrl-e
) || true

# With --expect, fzf prints the pressed key on line 1 ("" for Enter, "ctrl-e"
# for Ctrl-E) and the selected row on line 2.
key=$(printf '%s' "$selection" | sed -n '1p')
row=$(printf '%s' "$selection" | sed -n '2p')

# Empty row means the user pressed Esc or made no selection.
[ -n "$row" ] || exit 130

path=$(printf '%s' "$row" | cut -f1)
[ -f "$path" ] || exit 130

if [ "$key" = "ctrl-e" ]; then
  tmp=$(mktemp --suffix=.md)
  trap 'rm -f "$tmp"' EXIT
  cat "$path" >"$tmp"
  # Edit against the real terminal; stdout stays reserved for the final content.
  "${VISUAL:-${EDITOR:-vi}}" "$tmp" </dev/tty >/dev/tty 2>/dev/tty
  cat "$tmp"
else
  cat "$path"
fi
