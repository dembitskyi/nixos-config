import { describe, expect, test } from "bun:test"

import { errorName, errorText, interruptedError } from "./question"

describe("autopilot errors", () => {
  test("formats OpenCode named errors from their data message", () => {
    const error = { name: "MessageAbortedError", data: { message: "The operation was aborted." } }
    expect(errorText(error)).toBe("The operation was aborted.")
    expect(errorName(error)).toBe("MessageAbortedError")
    expect(interruptedError(error)).toBe(true)
  })

  test("serializes structured errors instead of returning object Object", () => {
    expect(errorText({ name: "UnexpectedError", data: { code: 42 } })).toBe(
      '{"name":"UnexpectedError","data":{"code":42}}',
    )
  })
})
