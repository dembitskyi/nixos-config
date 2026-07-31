// /preset — pick which orchestrator model preset applies to new sessions.
//
// Registers a palette/slash command that opens a DialogSelect over the
// host-provided preset names, marking the currently-active one. Selecting a
// preset atomically persists it to a small JSON state file read by the
// orchestrator plugin/config when starting new sessions.
//
// The preset name list is baked in at build time by Nix `replaceVars`
// (`@presetNamesFile@`, see `presetPlugin` in default.nix) from
// `parallelOrchestration.presets` — this file defines no preset names of its
// own, so a reusable checkout carries no host-specific names. The token is a
// Nix store path (never raw JSON text substituted into the source), since
// JSON can contain `"` / `` ` `` characters that would otherwise break out
// of whatever TS string literal the token sits in.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { TuiPlugin } from "@opencode-ai/plugin/tui"

/** Substituted at build time; see module doc. Overridable via
 * `OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE` for tests. */
const PRESET_NAMES_FILE_TOKEN = "@presetNamesFile@"

/** Reads and validates the baked-in preset name list from `path`. Never
 * throws: an unsubstituted token, empty path, unreadable file, invalid JSON,
 * or a non-array/non-string payload all fall back to an empty list (no
 * choices offered). */
function loadPresetNames(path: string): readonly string[] {
  if (path.trim().length === 0 || (path.startsWith("@") && path.endsWith("@"))) return []
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  try {
    const data: unknown = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.filter((v): v is string => typeof v === "string")
  } catch {
    return []
  }
}

function presetNames(): readonly string[] {
  return loadPresetNames(process.env.OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE ?? PRESET_NAMES_FILE_TOKEN)
}

function stateDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode")
}

function statePath(): string {
  return join(stateDir(), "orchestrator-preset.json")
}

/** Currently-selected preset name, or `null` if absent/unknown/malformed —
 * meaning no override; the server-side default stays in effect. */
function readActivePreset(names: readonly string[]): string | null {
  try {
    const raw = readFileSync(statePath(), "utf8")
    const parsed = JSON.parse(raw)
    if (typeof parsed?.preset === "string" && names.includes(parsed.preset)) return parsed.preset
    return null
  } catch {
    return null
  }
}

function writeActivePreset(preset: string): void {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = statePath()
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ preset }), { mode: 0o600 })
  renameSync(tmp, target)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "preset.pick",
        title: "Pick orchestrator preset",
        desc: "Choose which model preset new sessions use",
        category: "Orchestrator",
        slashName: "preset",
        async run() {
          const names = [...presetNames()].sort()
          if (names.length === 0) {
            api.ui.toast({
              variant: "warning",
              message: "No orchestrator presets configured (parallelOrchestration.presets is empty).",
            })
            return
          }
          const active = readActivePreset(names)
          // Display-only fallback: absent/unknown state has no override, but
          // the picker still needs to highlight something — the first sorted
          // name, marked "(default)" rather than "(current)" so it's clear no
          // state file backs the selection yet.
          const display = active ?? names[0]

          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Orchestrator preset",
              placeholder: "Select a preset",
              current: display,
              options: names.map((name) => ({
                title:
                  name === active
                    ? `${name} (current)`
                    : active === null && name === display
                      ? `${name} (default)`
                      : name,
                value: name,
              })),
              onSelect(option) {
                api.ui.dialog.clear()
                try {
                  writeActivePreset(option.value)
                  api.ui.toast({
                    variant: "success",
                    message: `Preset "${option.value}" applies to new sessions`,
                  })
                } catch (error) {
                  api.ui.toast({
                    variant: "error",
                    message: `Failed to save preset: ${String(error)}`,
                  })
                }
              },
            }),
          )
        },
      },
    ],
    bindings: [],
  })
}

export default { id: "orchestrator-preset", tui }
