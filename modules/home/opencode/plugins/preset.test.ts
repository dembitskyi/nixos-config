import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import preset from "./preset"

// Fake, generic preset names (baked in from `parallelOrchestration.presets`
// in real usage) — the reusable module ships no preset names of its own.
// Sorted, the first is "alpha" — used to assert the display-only fallback.
const TEST_NAMES = ["gamma", "alpha", "beta"]
const FIRST_SORTED = "alpha"

afterEach(() => {
  delete process.env.OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE
  delete process.env.XDG_DATA_HOME
})

function makeApi() {
  const commands: any[] = []
  const dialog = {
    lastReplace: undefined as undefined | (() => unknown),
    replace(render: () => unknown) {
      dialog.lastReplace = render
    },
    clear() {},
  }
  const toasts: any[] = []
  const api = {
    keymap: {
      registerLayer(layer: { commands: any[] }) {
        commands.push(...layer.commands)
      },
    },
    ui: {
      dialog,
      DialogSelect: (props: any) => props, // capture props instead of real JSX
      toast: (input: any) => toasts.push(input),
    },
  }
  return { api, commands, dialog, toasts }
}

// The TUI plugin reads the preset name list from a file path (the
// substituted token is a Nix store path, never inlined JSON text — see the
// module doc above PRESET_NAMES_FILE_TOKEN in preset.ts). This writes a
// fixture file to a scratch dir and points
// OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE at it.
function writeNamesFile(names: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "preset-names-"))
  const path = join(dir, "names.json")
  writeFileSync(path, JSON.stringify(names))
  return path
}

async function setupPreset(dataHome: string, names: readonly string[] = TEST_NAMES) {
  process.env.XDG_DATA_HOME = dataHome
  process.env.OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE = writeNamesFile(names)
  const { api, commands, dialog, toasts } = makeApi()
  await (preset.tui as any)(api, undefined, undefined)
  const command = commands.find((c) => c.name === "preset.pick")
  return { command, dialog, toasts, api }
}

describe("preset TUI plugin", () => {
  test("no state file: displays the first sorted name, marked (default), and state stays absent", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    const { command, dialog } = await setupPreset(dataHome)

    await command.run()
    const props = dialog.lastReplace!() as any
    expect(props.current).toBe(FIRST_SORTED)
    expect(props.options.find((o: any) => o.value === FIRST_SORTED).title).toContain("default")
    // Not "(current)" — there is no persisted override yet.
    expect(props.options.find((o: any) => o.value === FIRST_SORTED).title).not.toContain("current")
  })

  test("malformed state file: falls back to (default) display, not an error", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    mkdirSync(join(dataHome, "opencode"), { recursive: true })
    require("node:fs").writeFileSync(join(dataHome, "opencode", "orchestrator-preset.json"), "not json")
    const { command, dialog } = await setupPreset(dataHome)

    await command.run()
    const props = dialog.lastReplace!() as any
    expect(props.current).toBe(FIRST_SORTED)
  })

  test("unknown preset value in state file: falls back to (default) display", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    mkdirSync(join(dataHome, "opencode"), { recursive: true })
    require("node:fs").writeFileSync(
      join(dataHome, "opencode", "orchestrator-preset.json"),
      JSON.stringify({ preset: "nope" }),
    )
    const { command, dialog } = await setupPreset(dataHome)

    await command.run()
    const props = dialog.lastReplace!() as any
    expect(props.current).toBe(FIRST_SORTED)
  })

  test("selecting a preset atomically persists it (state format is only {preset:name}) and toasts success", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    const { command, dialog, toasts } = await setupPreset(dataHome)

    await command.run()
    const props = dialog.lastReplace!() as any
    props.onSelect({ value: "beta" })

    const statePath = join(dataHome, "opencode", "orchestrator-preset.json")
    const stat = require("node:fs").statSync(statePath)
    expect(stat.mode & 0o777).toBe(0o600)
    const written = JSON.parse(readFileSync(statePath, "utf8"))
    expect(written).toEqual({ preset: "beta" })
    expect(toasts.at(-1)?.variant).toBe("success")
    expect(toasts.at(-1)?.message).toContain("beta")
  })

  test("re-opening after a selection marks the new preset as current (not default)", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    const first = await setupPreset(dataHome)
    await first.command.run()
    const firstProps = first.dialog.lastReplace!() as any
    firstProps.onSelect({ value: "gamma" })

    const second = await setupPreset(dataHome)
    await second.command.run()
    const secondProps = second.dialog.lastReplace!() as any
    expect(secondProps.current).toBe("gamma")
    expect(secondProps.options.find((o: any) => o.value === "gamma").title).toContain("current")
  })

  test("sparse preset list: only the configured names are offered as choices", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    const { command, dialog } = await setupPreset(dataHome, ["solo"])

    await command.run()
    const props = dialog.lastReplace!() as any
    expect(props.options.map((o: any) => o.value)).toEqual(["solo"])
    expect(props.current).toBe("solo")
  })

  test("no OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE set (unsubstituted token): toasts a warning, opens no dialog", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    process.env.XDG_DATA_HOME = dataHome
    delete process.env.OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE
    const { api, commands, dialog, toasts } = makeApi()
    await (preset.tui as any)(api, undefined, undefined)
    const command = commands.find((c) => c.name === "preset.pick")

    await command.run()
    expect(dialog.lastReplace).toBeUndefined()
    expect(toasts.at(-1)?.variant).toBe("warning")
  })

  test("names file path set but file does not exist: toasts a warning, opens no dialog, does not throw", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    process.env.XDG_DATA_HOME = dataHome
    process.env.OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE = join(dataHome, "does-not-exist.json")
    const { api, commands, dialog, toasts } = makeApi()
    await (preset.tui as any)(api, undefined, undefined)
    const command = commands.find((c) => c.name === "preset.pick")

    await command.run()
    expect(dialog.lastReplace).toBeUndefined()
    expect(toasts.at(-1)?.variant).toBe("warning")
  })

  test("empty preset names array: toasts a warning, opens no dialog", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    const { command, dialog, toasts } = await setupPreset(dataHome, [])

    await command.run()
    expect(dialog.lastReplace).toBeUndefined()
    expect(toasts.at(-1)?.variant).toBe("warning")
  })

  test("invalid JSON in names file: toasts a warning, opens no dialog, does not throw", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    process.env.XDG_DATA_HOME = dataHome
    const badDir = mkdtempSync(join(tmpdir(), "preset-names-"))
    const badFile = join(badDir, "names.json")
    writeFileSync(badFile, "{not valid json")
    process.env.OPENCODE_ORCHESTRATOR_PRESET_NAMES_FILE = badFile
    const { api, commands, dialog, toasts } = makeApi()
    await (preset.tui as any)(api, undefined, undefined)
    const command = commands.find((c) => c.name === "preset.pick")

    await command.run()
    expect(dialog.lastReplace).toBeUndefined()
    expect(toasts.at(-1)?.variant).toBe("warning")
  })

  test("a preset name containing quote and backtick characters round-trips safely", async () => {
    // Regression: this scenario is exactly what breaks when the name list is
    // inlined directly into a TS string/template literal at build time
    // instead of being read from a file.
    const dataHome = mkdtempSync(join(tmpdir(), "preset-test-"))
    const trickyName = `weird"name\`with'quotes`
    const { command, dialog } = await setupPreset(dataHome, [trickyName])

    await command.run()
    const props = dialog.lastReplace!() as any
    expect(props.options.map((o: any) => o.value)).toEqual([trickyName])
    expect(props.current).toBe(trickyName)
  })
})
