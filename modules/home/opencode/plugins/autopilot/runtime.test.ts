import { describe, expect, test } from "bun:test"

import {
  AUTOPILOT_RUNTIME,
  parseRuntimeRequest,
  parseRuntimeResponse,
  runtimeMatches,
  runtimeRequest,
  runtimeResponse,
} from "./runtime"

describe("autopilot runtime identity", () => {
  test("round-trips a runtime handshake", () => {
    const request = runtimeRequest()
    const parsedRequest = parseRuntimeRequest(request.command)
    expect(parsedRequest?.runtime).toEqual(AUTOPILOT_RUNTIME)

    const parsedResponse = parseRuntimeResponse(runtimeResponse(request.nonce))
    expect(parsedResponse).toEqual({ nonce: request.nonce, runtime: AUTOPILOT_RUNTIME })
    expect(runtimeMatches(parsedResponse?.runtime)).toBe(true)
  })

  test("rejects malformed or mismatched runtime identities", () => {
    expect(parseRuntimeRequest("autopilot.runtime.request:bad:3:not-a-hash")).toBeUndefined()
    expect(
      runtimeMatches({ protocol: AUTOPILOT_RUNTIME.protocol + 1, fingerprint: AUTOPILOT_RUNTIME.fingerprint }),
    ).toBe(false)
    expect(runtimeMatches({ protocol: AUTOPILOT_RUNTIME.protocol, fingerprint: "0".repeat(64) })).toBe(false)
  })
})
