import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  formatLimit,
  formatModel,
  parseCriteria,
  patchGoal,
  patchGoalIf,
  putGoal,
  readState,
  removeGoal,
  setStatusVisibility,
  statePath,
} from "./state"
import { AUTOPILOT_RUNTIME } from "./runtime"

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

  test("formats a selected model and variant", () => {
    expect(
      formatModel({
        providerID: "provider",
        modelID: "model",
        variant: "high",
      }),
    ).toBe("provider/model · high")
    expect(formatModel({ providerID: "provider", modelID: "model" })).toBe("provider/model")
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
      reviewModel: { providerID: "provider", modelID: "model", variant: "high" },
      runtime: AUTOPILOT_RUNTIME,
      mode: "drive",
      questionPolicy: "hybrid",
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

    expect(readState().goals.ses_worker).toMatchObject({
      phase: "verifying",
      round: 1,
      reviewModel: { providerID: "provider", modelID: "model", variant: "high" },
      runtime: AUTOPILOT_RUNTIME,
    })
    expect(statSync(statePath()).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(statePath(), "utf8")).version).toBe(3)
  })

  test("persists structured recovery details", () => {
    scratch()
    putGoal({
      workerSessionID: "ses_worker",
      directory: "/workspace",
      criteria: [],
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "blocked",
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
      recovery: {
        kind: "worker-error",
        summary: "APIError: Provider quota exhausted",
        messageID: "msg_failed",
        errorName: "APIError",
        detail: "Provider quota exhausted",
      },
    })

    expect(readState().goals.ses_worker.recovery).toEqual({
      kind: "worker-error",
      summary: "APIError: Provider quota exhausted",
      messageID: "msg_failed",
      errorName: "APIError",
      detail: "Provider quota exhausted",
    })
  })

  test("only patches a goal when the current revision matches", () => {
    scratch()
    putGoal({
      workerSessionID: "ses_worker",
      directory: "/workspace",
      text: "Finish the feature",
      criteria: [],
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "working",
      startedAt: 1,
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 2,
    })

    expect(
      patchGoalIf("ses_worker", (goal) => goal.revision === 1, {
        phase: "verifying",
      }),
    ).toBeUndefined()
    expect(readState().goals.ses_worker.phase).toBe("working")
    expect(
      patchGoalIf("ses_worker", (goal) => goal.revision === 2, {
        phase: "verifying",
      })?.phase,
    ).toBe("verifying")
  })

  test("persists status visibility independently for concurrent sessions", () => {
    scratch()
    setStatusVisibility("ses_one", "hide")
    setStatusVisibility("ses_two", "show")

    expect(readState().status.sessions).toEqual({
      ses_one: "hide",
      ses_two: "show",
    })
    setStatusVisibility("ses_one", "auto")
    expect(readState().status.sessions).toEqual({ ses_two: "show" })
    removeGoal("ses_two")
    expect(readState().status.sessions).toEqual({ ses_two: "show" })
  })

  test("migrates an active v1 goal to hybrid question handling", () => {
    scratch()
    const legacy = {
      version: 1,
      questions: { global: "recommended", sessions: {} },
      goals: {
        ses_worker: {
          workerSessionID: "ses_worker",
          directory: "/workspace",
          criteria: [],
          mode: "drive",
          maxRounds: 12,
          phase: "working",
          updatedAt: 1,
          round: 0,
          continuations: 0,
          noProgressLimit: 2,
          noProgressRounds: 0,
          revision: 1,
        },
      },
    }
    mkdirSync(join(process.env.XDG_DATA_HOME!, "opencode"), {
      recursive: true,
    })
    writeFileSync(statePath(), JSON.stringify(legacy))

    expect(readState()).toMatchObject({
      version: 3,
      status: { sessions: {} },
      goals: { ses_worker: { questionPolicy: "hybrid", maxCheckpoints: 12 } },
    })
  })

  test("keeps explicit manual question handling after migration", () => {
    scratch()
    putGoal({
      workerSessionID: "ses_worker",
      directory: "/workspace",
      criteria: [],
      mode: "drive",
      questionPolicy: "manual",
      phase: "working",
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
    })

    expect(readState().goals.ses_worker.questionPolicy).toBe("manual")
  })

  test("keeps explicit hybrid question handling after migration", () => {
    scratch()
    putGoal({
      workerSessionID: "ses_worker",
      directory: "/workspace",
      criteria: [],
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "working",
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
    })

    expect(readState().goals.ses_worker.questionPolicy).toBe("hybrid")
  })

  test("keeps legacy goals without a selected review model for runtime resolution", () => {
    scratch()
    putGoal({
      workerSessionID: "ses_worker",
      directory: "/workspace",
      criteria: [],
      mode: "drive",
      questionPolicy: "hybrid",
      phase: "working",
      updatedAt: 1,
      round: 0,
      continuations: 0,
      noProgressLimit: 2,
      noProgressRounds: 0,
      revision: 1,
    })

    expect(readState().goals.ses_worker.reviewModel).toBeUndefined()
  })

  test("migrates a v2 goal model to the isolated review model", () => {
    scratch()
    const persisted = {
      version: 2,
      status: { sessions: {} },
      goals: {
        ses_worker: {
          workerSessionID: "ses_worker",
          directory: "/workspace",
          criteria: [],
          model: { providerID: "review", modelID: "model", variant: "high" },
          mode: "drive",
          questionPolicy: "hybrid",
          phase: "working",
          updatedAt: 1,
          round: 0,
          continuations: 0,
          noProgressLimit: 2,
          noProgressRounds: 0,
          revision: 1,
        },
      },
    }
    mkdirSync(join(process.env.XDG_DATA_HOME!, "opencode"), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(persisted))

    expect(readState()).toMatchObject({
      version: 3,
      goals: { ses_worker: { reviewModel: { providerID: "review", modelID: "model", variant: "high" } } },
    })
    expect("model" in readState().goals.ses_worker).toBe(false)
  })

  test("ignores malformed persisted review-model selections", () => {
    scratch()
    const persisted = {
      version: 2,
      status: { sessions: {} },
      goals: {
        ses_worker: {
          workerSessionID: "ses_worker",
          directory: "/workspace",
          criteria: [],
          model: { providerID: "provider", modelID: 42, variant: true },
          mode: "drive",
          questionPolicy: "hybrid",
          phase: "working",
          updatedAt: 1,
          round: 0,
          continuations: 0,
          noProgressLimit: 2,
          noProgressRounds: 0,
          revision: 1,
        },
      },
    }
    mkdirSync(join(process.env.XDG_DATA_HOME!, "opencode"), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(persisted))

    expect(readState().goals.ses_worker.reviewModel).toBeUndefined()
  })
})
