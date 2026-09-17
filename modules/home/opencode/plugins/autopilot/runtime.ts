import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

export type RuntimeIdentity = {
  protocol: number
  fingerprint: string
}

export const AUTOPILOT_RUNTIME_PROTOCOL = 3

const RUNTIME_FILES = ["runtime.ts", "state.ts", "question.ts", "log.ts", "server.ts", "tui.tsx"] as const

export const AUTOPILOT_RUNTIME_FINGERPRINT = runtimeFingerprint(import.meta.url)

export const AUTOPILOT_RUNTIME: RuntimeIdentity = {
  protocol: AUTOPILOT_RUNTIME_PROTOCOL,
  fingerprint: AUTOPILOT_RUNTIME_FINGERPRINT,
}

export function runtimeFingerprint(baseURL: string | URL): string {
  return createHash("sha256")
    .update(RUNTIME_FILES.map((name) => `${name}\0${readFileSync(new URL(name, baseURL), "utf8")}\0`).join(""))
    .digest("hex")
}

const REQUEST = "autopilot.runtime.request"
const RESPONSE = "autopilot.runtime.response"

export function runtimeMatches(left: RuntimeIdentity | undefined, right = AUTOPILOT_RUNTIME): boolean {
  return Boolean(left && left.protocol === right.protocol && left.fingerprint === right.fingerprint)
}

export function runtimeLabel(runtime: RuntimeIdentity): string {
  return `protocol ${runtime.protocol} · ${runtime.fingerprint.slice(0, 12)}`
}

export function runtimeRequest(): { nonce: string; command: string } {
  const nonce = randomUUID().replaceAll("-", "")
  return { nonce, command: encode(REQUEST, nonce, AUTOPILOT_RUNTIME) }
}

export function runtimeResponse(nonce: string, runtime = AUTOPILOT_RUNTIME): string {
  return encode(RESPONSE, nonce, runtime)
}

export function parseRuntimeRequest(command: string): { nonce: string; runtime: RuntimeIdentity } | undefined {
  return parse(command, REQUEST)
}

export function parseRuntimeResponse(command: string): { nonce: string; runtime: RuntimeIdentity } | undefined {
  return parse(command, RESPONSE)
}

function encode(kind: string, nonce: string, runtime: RuntimeIdentity): string {
  return `${kind}:${nonce}:${runtime.protocol}:${runtime.fingerprint}`
}

function parse(command: string, kind: string): { nonce: string; runtime: RuntimeIdentity } | undefined {
  const [actualKind, nonce, protocolText, fingerprint, extra] = command.split(":")
  const protocol = Number(protocolText)
  if (actualKind !== kind || extra !== undefined) return
  if (!nonce || !/^[a-z0-9]+$/i.test(nonce)) return
  if (!Number.isSafeInteger(protocol) || protocol <= 0) return
  if (!fingerprint || !/^[a-f0-9]{64}$/i.test(fingerprint)) return
  return { nonce, runtime: { protocol, fingerprint: fingerprint.toLowerCase() } }
}
