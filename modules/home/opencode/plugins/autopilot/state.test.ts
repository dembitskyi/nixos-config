import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  formatLimit,
  parseCriteria,
  patchGoal,
  patchGoalIf,
  putGoal,
  readState,
  removeGoal,
  setStatusVisibility,
  statePath,
} from "./state"

afterEach(() => {
  delete process.env.XDG_DATA_HOME
})

function scratch() {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "autopilot-state-test-"))
}

describe("autopilot state", () => {
  test("uses explicit Unlimited display for omitted limits", () => {
    expect(formatLimit(undefined)).toBe("Unlimited")
    expect(formatLimit(undefined, "m")).toBe("Unlimited")
    expect(formatLimit(6)).toBe("6")
    expect(formatLimit(45, "m")).toBe("45m")
  })

  test("parses acceptance criteria after a named section", () => {
    expect(parseCriteria("Implement it.\n\nDone when:\n- Tests pass\n2. Typecheck passes")).toEqual([
      "Tests pass",
      "Typecheck passes",
    ])
  })

  test("persists and patches a goal atomically", () => {
    scratch()
    putGoal({
      workerSessionID: "ses_worker",
      directory: "/workspace",
      text: "Finish the feature",
      criteria: ["Tests pass"],
      mode: "drive",
      phase: "working",
      startedAt: 1,
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
    })
    patchGoal("ses_worker", { phase: "verifying", round: 1 })

    expect(readState().goals.ses_worker).toMatchObject({ phase: "verifying", round: 1 })
    expect(statSync(statePath()).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(statePath(), "utf8")).version).toBe(1)
  })

  test("only patches a goal when the current revision matches", () => {
    scratch()
    putGoal({
      workerSessionID: "ses_worker",
      directory: "/workspace",
      text: "Finish the feature",
      criteria: [],
      mode: "drive",
      phase: "working",
      startedAt: 1,
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 2,
    })

    expect(patchGoalIf("ses_worker", (goal) => goal.revision === 1, { phase: "verifying" })).toBeUndefined()
    expect(readState().goals.ses_worker.phase).toBe("working")
    expect(patchGoalIf("ses_worker", (goal) => goal.revision === 2, { phase: "verifying" })?.phase).toBe("verifying")
  })

  test("persists status visibility independently for concurrent sessions", () => {
    scratch()
    setStatusVisibility("ses_one", "hide")
    setStatusVisibility("ses_two", "show")

    expect(readState().status.sessions).toEqual({ ses_one: "hide", ses_two: "show" })
    setStatusVisibility("ses_one", "auto")
    expect(readState().status.sessions).toEqual({ ses_two: "show" })
    removeGoal("ses_two")
    expect(readState().status.sessions).toEqual({})
  })
})
