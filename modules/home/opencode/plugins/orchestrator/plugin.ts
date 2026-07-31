/**
 * Parallel Orchestrator — a single-file opencode plugin for the `orchestrator`
 * agent. It bundles four cooperating, self-contained concerns:
 *
 * - {@link LaneBoard}: tracks the background specialist lanes the orchestrator
 *   launches (via native `session.*` events), injects a live "Background Job
 *   Board" plus a per-turn scheduler reminder, surfaces completed sessions as
 *   a capped reusable pool, and reports lane health (running / stale / failed
 *   / cancelled / runaway-on-turns) so the orchestrator never waits forever on
 *   a dead lane.
 * - {@link ModelFailover}: on a provider rate-limit, aborts the stuck turn and
 *   re-issues it on the next model in a baked fallback chain. Gated to the
 *   `orchestrator` agent only, so pinned council seats are never re-prompted
 *   onto a different model.
 * - {@link DelegateRetry}: appends a fix hint to a failed `task()` result so the
 *   model self-corrects instead of repeating the same bad call.
 * - a `cancel_task` tool: lets the orchestrator abort a known-bad lane. This is
 *   NOT a rollback — a cancelled writer lane may have already touched files.
 * - {@link PresetManager}: snapshots a server-side orchestration model preset
 *   (from a small JSON state file) once per new top-level session, and
 *   applies it to the managed agents' model on every message. Child sessions
 *   inherit the parent's snapshot rather than re-reading state. The preset
 *   table itself is host-provided (see `parallelOrchestration.presets` in
 *   the Nix module) — this file defines no presets of its own.
 *
 * Everything is injection-only except the failover re-prompt and the
 * cancel_task abort call, and every branch is defensive (never throws). All
 * activity is written to a dedicated log file
 * (`~/.local/share/opencode/log/orchestrator.log`) for debugging.
 *
 * The `@fallbackChain@` and `@presetsFile@` tokens are substituted at build
 * time by Nix `replaceVars`. `@presetsFile@` is a Nix store path (never
 * user-controlled JSON text), so it is always a syntactically-safe string
 * literal — unlike substituting raw JSON, which can contain quote/backtick
 * characters that break the surrounding TS literal.
 *
 * Exports exactly one runtime value and imports no packages at runtime.
 *
 * Silent non-load? Import errors only reach a client toast, never a log. Copy
 * this file somewhere without node_modules and `opencode run` it via OPENCODE_CONFIG.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Hooks, Plugin } from "@opencode-ai/plugin"

/**
 * Fallback model chain, baked at build time as a comma-separated list.
 *
 * Overridable via `OPENCODE_ORCHESTRATOR_FALLBACK_CHAIN` — read lazily inside
 * {@link ParallelOrchestrator} (not here at module scope) so tests can set a
 * synthetic chain per test without a module reload, and so this override
 * mechanism adds no runtime export.
 */
const FALLBACK_CHAIN_TOKEN = "@fallbackChain@"
const parseChain = (raw: string): readonly string[] => raw.split(",").filter((m) => m.length > 0)

/** Stable identifier used for the log file and all metadata tags. */
const PLUGIN_ID = "orchestrator"
const ORCHESTRATOR = "orchestrator"
const REMINDER_KEY = `${PLUGIN_ID}.reminder`
const BOARD_KEY = `${PLUGIN_ID}.board`

/** Completed sessions retained per specialist before the oldest is evicted. */
const MAX_REUSABLE_PER_AGENT = 2
/** Ignore repeat rate-limit events for one incident within this window. */
const FAILOVER_DEDUP_MS = 5_000

/**
 * A lane still "running" past this age is reported as stale rather than as
 * something to keep waiting on. 20 minutes is deliberately above the longest
 * legitimate MCP timeout in this setup (ghidra tools can take up to 900s /
 * 15min), so a genuinely slow-but-alive lane should not be flagged here; a
 * lane stuck in a bash→read→bash loop with no terminal event, however, will
 * cross this threshold and get surfaced for investigation.
 */
const LANE_STALE_MS = 20 * 60_000

/**
 * A running lane with more assistant turns than this is suspect (looping or
 * thrashing) even if it isn't old enough to be "stale" yet. OMO's fix for the
 * equivalent failure (PR #2575) used a hard 300-turn cap; we can only warn
 * (opencode owns the agent loop, a plugin cannot hard-abort a turn budget),
 * so we surface earlier, at half that, and leave the decision to cancel with
 * the orchestrator via cancel_task.
 */
const LANE_TURN_WARN = 150

const REMINDER_TEXT =
  "<system-reminder>\n" +
  "Scheduler mode: for non-trivial work, plan the independent lanes first and " +
  "dispatch them to specialists with task(..., background: true) rather than " +
  "doing multi-step work yourself. One writer per file/folder. Reconcile the " +
  "terminal results of all relevant lanes before you finalize.\n" +
  "</system-reminder>"

// ─────────────────────────────────────────────────────────────────────────────
// Loosely-typed opencode runtime shapes (verified against SDK v1.18.x)
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error"

interface MessagePart {
  readonly type?: string
  readonly text?: string
  readonly synthetic?: boolean
  readonly metadata?: Record<string, unknown>
  readonly mime?: string
  readonly filename?: string
  readonly url?: string
}

interface MessageInfo {
  readonly id?: string
  readonly role?: string
  readonly agent?: string
  readonly sessionID?: string
  readonly providerID?: string
  readonly modelID?: string
  readonly error?: unknown
}

interface TransformMessage {
  readonly info?: MessageInfo
  parts?: MessagePart[]
}

interface OpencodeEvent {
  readonly type?: string
  readonly properties?: {
    readonly info?: { id?: string; parentID?: string; title?: string } & MessageInfo
    readonly sessionID?: string
    readonly status?: { type?: string; message?: string }
    readonly error?: unknown
  }
}

/** Minimal surface of the plugin client the failover / cancel_task paths use. */
interface SessionClient {
  messages(opts: { path: { id: string } }): Promise<unknown>
  abort(opts: { path: { id: string } }): Promise<unknown>
  promptAsync?(opts: PromptOptions): Promise<unknown>
  prompt(opts: PromptOptions): Promise<unknown>
}
type PromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename?: string; url: string }
interface PromptOptions {
  path: { id: string }
  body: { model: { providerID: string; modelID: string }; parts: PromptPart[] }
}
interface PluginClient {
  readonly session: SessionClient
}

type LaneState = "running" | "done" | "failed" | "cancelled"
interface Lane {
  readonly child: string
  readonly agent: string
  readonly desc: string
  state: LaneState
  seq: number
  /** Date.now() when the lane was created; used to compute staleness lazily. */
  readonly startedAt: number
  /** Count of ALL assistant turns seen for this lane (never reset on success —
   * see {@link LANE_TURN_WARN} for why counting only errors would be useless). */
  turns: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

/** Structured sink the plugin components log through (see {@link Logger}). */
export interface Log {
  debug(component: string, message: string, data?: unknown): void
  info(component: string, message: string, data?: unknown): void
  warn(component: string, message: string, data?: unknown): void
  error(component: string, message: string, data?: unknown): void
}

/**
 * Best-effort, append-only JSON-lines file logger. Never throws.
 *
 * The directory is overridable via `OPENCODE_ORCHESTRATOR_LOG_DIR` so tests
 * write to a scratch path instead of the real log the running plugin uses —
 * test output mixed into that file makes live debugging genuinely misleading.
 */
class Logger implements Log {
  private readonly file: string

  constructor(name: string) {
    const dir =
      process.env.OPENCODE_ORCHESTRATOR_LOG_DIR ?? join(homedir(), ".local", "share", "opencode", "log")
    this.file = join(dir, `${name}.log`)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch {
      /* ignore */
    }
    this.info("logger", "initialized", { file: this.file })
  }

  private write(level: LogLevel, component: string, message: string, data?: unknown): void {
    try {
      const entry = {
        ts: new Date().toISOString(),
        level,
        component,
        message,
        ...(data === undefined ? {} : { data }),
      }
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  debug(component: string, message: string, data?: unknown): void {
    this.write("debug", component, message, data)
  }
  info(component: string, message: string, data?: unknown): void {
    this.write("info", component, message, data)
  }
  warn(component: string, message: string, data?: unknown): void {
    this.write("warn", component, message, data)
  }
  error(component: string, message: string, data?: unknown): void {
    this.write("error", component, message, data)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared cache-safe part helpers
// ─────────────────────────────────────────────────────────────────────────────

const isTagged = (part: MessagePart | undefined, key: string): boolean => part?.metadata?.[key] === true

const hasRealText = (message: TransformMessage): boolean =>
  Array.isArray(message.parts) &&
  message.parts.some((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)

// ─────────────────────────────────────────────────────────────────────────────
// LaneBoard: job board, reminder, reusable-session surfacing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tracks specialist lanes per orchestrator session and injects, cache-safely,
 * a scheduler reminder (deterministic, per user message) plus a volatile
 * "Background Job Board" (its own trailing message so churn only costs the tail).
 */
class LaneBoard {
  /** sessionID → agent name; identifies which sessions are the orchestrator. */
  private readonly sessionAgent = new Map<string, string>()
  /** orchestrator sessionID → (child sessionID → lane). */
  private readonly lanes = new Map<string, Map<string, Lane>>()
  /** Monotonic completion counter for reusable-pool eviction ordering. */
  private seq = 0

  constructor(
    private readonly log: Log,
    private readonly now: () => number = Date.now,
  ) {}

  observeAgent(sessionID: string | undefined, agent: string | undefined): void {
    if (sessionID && typeof agent === "string") {
      this.sessionAgent.set(sessionID, agent)
      this.log.debug("board", "session→agent", { sessionID, agent })
    }
  }

  /** Public accessor so other components (e.g. {@link ModelFailover}) can gate
   * on agent identity without a hard circular dependency on LaneBoard internals. */
  isOrchestratorSession(sessionID: string | undefined): boolean {
    return this.isOrchestrator(sessionID)
  }

  /** All tracked lanes for a given orchestrator (parent) session. */
  listChildren(parent: string): readonly Lane[] {
    return [...(this.lanes.get(parent)?.values() ?? [])]
  }

  /** Mark a tracked child lane cancelled. Returns an error listing valid ids
   * when the child is not tracked for this parent, so callers (the cancel_task
   * tool) can give the model a helpful message instead of blindly aborting. */
  cancelLane(parent: string, child: string): { ok: true } | { ok: false; error: string } {
    const map = this.lanes.get(parent)
    const lane = map?.get(child)
    if (!lane) {
      const ids = map ? [...map.keys()] : []
      return {
        ok: false,
        error:
          ids.length > 0
            ? `Unknown task id "${child}". Tracked ids: ${ids.join(", ")}`
            : `Unknown task id "${child}". No tracked lanes for this session.`,
      }
    }
    lane.state = "cancelled"
    this.log.info("board", "lane cancelled", { parent, child })
    return { ok: true }
  }

  onEvent(event: OpencodeEvent): void {
    const { type, properties: props } = event
    if (!props) return

    if (type === "session.created") {
      const parent = props.info?.parentID
      const child = props.info?.id
      if (parent && child && this.isOrchestrator(parent)) {
        const { agent, desc } = LaneBoard.parseTitle(props.info?.title)
        this.laneMap(parent).set(child, {
          child,
          agent,
          desc,
          state: "running",
          seq: 0,
          startedAt: this.now(),
          turns: 0,
        })
        this.log.info("board", "lane launched", { parent, child, agent, desc })
      }
      return
    }

    if (type === "session.idle" || (type === "session.status" && props.status?.type === "idle")) {
      const sid = props.sessionID ?? props.info?.id
      if (!sid) return
      // A child lane going idle means it finished; native opencode re-prompts
      // the parent with the result, so no nudge is needed here.
      for (const [parent, map] of this.lanes) {
        const lane = map.get(sid)
        if (lane && lane.state === "running") {
          lane.state = "done"
          lane.seq = ++this.seq
          this.capReusable(parent)
          this.log.info("board", "lane completed", { parent, child: sid, agent: lane.agent })
        }
      }
      return
    }

    if (type === "session.error") {
      const sid = props.sessionID ?? props.info?.id
      if (!sid) return
      for (const [parent, map] of this.lanes) {
        const lane = map.get(sid)
        if (lane && lane.state === "running") {
          lane.state = "failed"
          this.log.info("board", "lane failed", { parent, child: sid, agent: lane.agent })
        }
      }
      return
    }

    if (type === "message.updated") {
      const info = props.info
      // Count ALL assistant turns, not just errors. A counter that only
      // advances on tool/message errors is useless — an agent that generates
      // prose forever (rather than erroring) would never trip it.
      if (info?.role === "assistant" && info.sessionID) this.recordTurn(info.sessionID)
      return
    }

    if (type === "session.deleted") {
      const sid = props.info?.id ?? props.sessionID
      if (sid) {
        this.sessionAgent.delete(sid)
        this.lanes.delete(sid)
        for (const map of this.lanes.values()) map.delete(sid)
        this.log.debug("board", "session deleted", { sessionID: sid })
      }
    }
  }

  /** Inject the reminder and board into an outgoing message array (in place). */
  injectInto(messages: TransformMessage[]): void {
    // Board is volatile: strip any prior copy (parts + emptied messages).
    this.stripTagged(messages, BOARD_KEY)

    // Reminder: append once to each orchestrator user message with real text.
    for (const message of messages) {
      if (!this.isOrchestratorMessage(message) || !hasRealText(message)) continue
      const parts = message.parts
      if (!parts || parts.some((p) => isTagged(p, REMINDER_KEY))) continue
      parts.push({ type: "text", synthetic: true, text: REMINDER_TEXT, metadata: { [REMINDER_KEY]: true } })
    }

    // Board: append as its own trailing message after the latest orchestrator
    // user message, so board churn (including volatile ages/turn counts) only
    // costs the prompt tail and never touches the deterministic reminder text
    // above — that keeps prompt caching intact.
    let base: TransformMessage | undefined
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (this.isOrchestratorMessage(messages[i]) && hasRealText(messages[i])) {
        base = messages[i]
        break
      }
    }
    if (!base) return
    const sid = base.info?.sessionID
    const board = sid ? this.boardText(sid) : null
    if (!board) return
    const baseId = typeof base.info?.id === "string" ? base.info.id : "msg"
    messages.push({
      info: { ...base.info, id: `${baseId}-${PLUGIN_ID}-board` },
      parts: [{ type: "text", synthetic: true, text: board, metadata: { [BOARD_KEY]: true } }],
    })
    this.log.debug("board", "board injected", { sessionID: sid })
  }

  private isOrchestrator(sid: string | undefined): boolean {
    return !!sid && this.sessionAgent.get(sid) === ORCHESTRATOR
  }

  private isOrchestratorMessage(message: TransformMessage): boolean {
    const info = message.info
    if (info?.role !== "user") return false
    if (typeof info.agent === "string") return info.agent === ORCHESTRATOR
    return this.isOrchestrator(info.sessionID)
  }

  private laneMap(parent: string): Map<string, Lane> {
    let map = this.lanes.get(parent)
    if (!map) {
      map = new Map()
      this.lanes.set(parent, map)
    }
    return map
  }

  private recordTurn(sid: string): void {
    for (const map of this.lanes.values()) {
      const lane = map.get(sid)
      if (lane && lane.state === "running") lane.turns += 1
    }
  }

  /** Keep at most {@link MAX_REUSABLE_PER_AGENT} completed lanes per specialist.
   * Only `done` lanes are reusable — a stale/failed/cancelled lane's context
   * is untrustworthy and must never be offered for warm-context reuse. */
  private capReusable(parent: string): void {
    const map = this.lanes.get(parent)
    if (!map) return
    const byAgent = new Map<string, Lane[]>()
    for (const lane of map.values()) {
      if (lane.state !== "done") continue
      const list = byAgent.get(lane.agent) ?? []
      list.push(lane)
      byAgent.set(lane.agent, list)
    }
    for (const list of byAgent.values()) {
      if (list.length <= MAX_REUSABLE_PER_AGENT) continue
      list.sort((a, b) => a.seq - b.seq)
      for (const lane of list.slice(0, list.length - MAX_REUSABLE_PER_AGENT)) {
        map.delete(lane.child)
        this.log.debug("board", "reusable lane evicted", { parent, child: lane.child, agent: lane.agent })
      }
    }
  }

  /** Classify a snapshot of lanes into the health buckets shared by
   * {@link boardText} and {@link compactionContext} (running / stale /
   * runaway / failed / cancelled / reusable). */
  private classify(map: Map<string, Lane>): {
    active: Lane[]
    runaway: Lane[]
    stale: Lane[]
    failed: Lane[]
    cancelled: Lane[]
    reusable: Lane[]
  } {
    const now = this.now()
    const all = [...map.values()]

    const isStale = (l: Lane) => l.state === "running" && now - l.startedAt > LANE_STALE_MS
    const isRunaway = (l: Lane) => l.state === "running" && !isStale(l) && l.turns > LANE_TURN_WARN

    return {
      active: all.filter((l) => l.state === "running" && !isStale(l) && !isRunaway(l)),
      runaway: all.filter(isRunaway),
      stale: all.filter(isStale),
      failed: all.filter((l) => l.state === "failed"),
      cancelled: all.filter((l) => l.state === "cancelled"),
      reusable: all.filter((l) => l.state === "done").sort((a, b) => b.seq - a.seq),
    }
  }

  /**
   * Compact, deterministic delegation-state summary for opencode's
   * `experimental.session.compacting` hook. The LLM-written compaction
   * summary otherwise drops task ids and lane status entirely (the default
   * template has no delegation section), which strands the continuing agent
   * without a way to resume warm sessions or know what is still running.
   *
   * Returns `null` for non-orchestrator sessions or sessions with no tracked
   * lanes, so unrelated compactions get nothing injected.
   *
   * Deliberately excludes clock-derived text (ages, timestamps) — this must
   * be stable across repeat compactions of unchanged state, and it feeds a
   * one-shot summarization prompt rather than the cached main conversation,
   * so there is no cache-churn reason to include them either.
   */
  compactionContext(sessionID: string): string | null {
    if (!this.isOrchestrator(sessionID)) return null
    const map = this.lanes.get(sessionID)
    if (!map || map.size === 0) return null
    const { active, runaway, stale, failed, cancelled, reusable } = this.classify(map)
    if (
      active.length + runaway.length + stale.length + failed.length + cancelled.length + reusable.length ===
      0
    )
      return null

    const rows: string[] = []
    for (const l of stale)
      rows.push(`- @${l.agent} ${l.child} — STALE, running — ${LaneBoard.shorten(l.desc)}`)
    for (const l of runaway)
      rows.push(`- @${l.agent} ${l.child} — RUNAWAY, running — ${LaneBoard.shorten(l.desc)}`)
    for (const l of active) rows.push(`- @${l.agent} ${l.child} — running — ${LaneBoard.shorten(l.desc)}`)
    for (const l of failed) rows.push(`- @${l.agent} ${l.child} — failed — ${LaneBoard.shorten(l.desc)}`)
    for (const l of cancelled)
      rows.push(`- @${l.agent} ${l.child} — cancelled — ${LaneBoard.shorten(l.desc)}`)
    for (const l of reusable)
      rows.push(`- @${l.agent} ${l.child} — done, reusable — ${LaneBoard.shorten(l.desc)}`)

    const body = rows.join("\n")

    return (
      "## Delegated Lanes (preserve verbatim)\n" +
      "Preserve every task id and its state exactly in the summary. To continue any of this work, resume via " +
      "its task_id rather than re-dispatching a fresh lane for the same work. If a writer lane above owns files, " +
      "restate that ownership explicitly — it may still be in effect after compaction.\n" +
      `${body}`
    )
  }

  private boardText(sid: string): string | null {
    const map = this.lanes.get(sid)
    if (!map || map.size === 0) return null
    const { active, runaway, stale, failed, cancelled, reusable } = this.classify(map)
    const now = this.now()

    const sections: string[] = []
    if (active.length > 0) {
      const rows = active.map((l) => `  \u25cf @${l.agent} \u2014 ${LaneBoard.shorten(l.desc)}`)
      sections.push(`Active lanes (${active.length} running):\n${rows.join("\n")}`)
    }
    if (runaway.length > 0) {
      const rows = runaway.map(
        (l) =>
          `  \u26a0 @${l.agent}  ${l.child}  ${l.turns} turns \u2014 ${LaneBoard.shorten(l.desc)} (consider cancel_task)`,
      )
      sections.push(`Runaway (excessive turns; may be looping):\n${rows.join("\n")}`)
    }
    if (stale.length > 0) {
      const rows = stale.map((l) => {
        const ageMin = Math.floor((now - l.startedAt) / 60_000)
        return `  \u26a0 @${l.agent}  ${l.child}  stale ${ageMin}m \u2014 ${LaneBoard.shorten(l.desc)} (consider cancel_task)`
      })
      sections.push(`Stale (no terminal result past threshold):\n${rows.join("\n")}`)
    }
    if (failed.length > 0) {
      const rows = failed.map((l) => `  \u2717 @${l.agent}  ${l.child} \u2014 ${LaneBoard.shorten(l.desc)}`)
      sections.push(`Failed:\n${rows.join("\n")}`)
    }
    if (cancelled.length > 0) {
      const rows = cancelled.map(
        (l) => `  \u25a0 @${l.agent}  ${l.child} \u2014 ${LaneBoard.shorten(l.desc)}`,
      )
      sections.push(
        `Cancelled (not a rollback; inspect the working tree before replacing this work):\n${rows.join("\n")}`,
      )
    }
    if (reusable.length > 0) {
      const rows = reusable.map((l) => `  @${l.agent}  ${l.child}  (${LaneBoard.shorten(l.desc)})`)
      sections.push(
        `Reusable sessions (to continue with warm context, pass the id as task_id):\n${rows.join("\n")}`,
      )
    }
    if (sections.length === 0) return null

    // Only genuinely-active (non-stale, non-runaway) lanes justify blocking.
    // Stale/failed/runaway lanes must never be described as things to wait
    // for — that was the #2571 failure mode (a dead lane silently kept the
    // orchestrator waiting forever).
    const blocking = active.length > 0
    const needsAttention = stale.length > 0 || failed.length > 0 || runaway.length > 0
    let tail: string
    if (blocking && needsAttention) {
      tail =
        "Do not finalize while the active lanes above are running; wait for their terminal results. " +
        "The stale/failed/runaway lanes above are NOT worth waiting on — investigate or cancel_task them and reconcile without blocking on them."
    } else if (blocking) {
      tail = "Do not finalize while lanes are running; wait for their terminal results, then reconcile."
    } else if (needsAttention) {
      tail =
        "No lanes are actively progressing. Investigate, cancel_task, or reconcile the stale/failed/runaway lanes above before finalizing; do not keep waiting on them."
    } else {
      tail = "Reuse a listed session for related follow-ups; spawn a fresh one only for unrelated work."
    }
    return `<system-reminder>\n### Background Job Board\n${sections.join("\n")}\n${tail}\n</system-reminder>`
  }

  private stripTagged(messages: TransformMessage[], key: string): void {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const parts = messages[i]?.parts
      if (!Array.isArray(parts)) continue
      const had = parts.length > 0
      messages[i].parts = parts.filter((p) => !isTagged(p, key))
      if (had && messages[i].parts?.length === 0) messages.splice(i, 1)
    }
  }

  /** Child sessions are titled "<description> (@<agent> subagent)". */
  private static parseTitle(title: string | undefined): { agent: string; desc: string } {
    if (typeof title !== "string" || !title) return { agent: "subagent", desc: "task" }
    const m = title.match(/^(.*?)\s*\(@([\w-]+)\s+subagent\)\s*$/)
    if (m) return { desc: m[1].trim() || "task", agent: m[2] }
    return { agent: "subagent", desc: title }
  }

  private static shorten(s: string): string {
    return s.length > 72 ? `${s.slice(0, 69)}...` : s
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ModelFailover: cross-model retry on rate-limit
// ─────────────────────────────────────────────────────────────────────────────

const RETRYABLE =
  /(^|[^0-9])(429|403)([^0-9]|$)|rate.?limit|too many requests|quota.?exceeded|usage.?(exceeded|limit)|resource.?exhausted|overloaded|forbidden|service unavailable|bad gateway|gateway timeout|internal server error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i
const OUTAGE_CODES = new Set([429, 403, 500, 502, 503, 504])

/**
 * Re-issues a rate-limited turn on the next model in the fallback chain.
 * Complements opencode's native same-model backoff by switching models when a
 * model's quota is exhausted. Guarded by dedup, in-flight lock, per-session
 * tried-set, chain exhaustion, and an agent-eligibility gate so it cannot loop
 * and cannot fire on sessions it doesn't own.
 */
class ModelFailover {
  private readonly currentModel = new Map<string, string>()
  private readonly tried = new Map<string, Set<string>>()
  private readonly inProgress = new Set<string>()
  private readonly lastTrigger = new Map<string, number>()
  /** Total replay attempts fired for a session; hard-capped at chain length
   * as belt-and-braces against any path that might repopulate `tried`. */
  private readonly attempts = new Map<string, number>()

  constructor(
    private readonly client: PluginClient | undefined,
    private readonly chain: readonly string[],
    private readonly log: Log,
    /** Predicate deciding whether a session may be failed over. Defaults to
     * always-eligible for standalone use/tests; production wiring passes a
     * predicate backed by {@link LaneBoard.isOrchestratorSession} so a
     * pinned council seat (e.g. councillor-gpt) is never silently re-prompted
     * onto a different model. */
    private readonly isEligible: (sessionID: string) => boolean = () => true,
    /** Injectable clock, mainly so tests can simulate long gaps without real sleeps. */
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return !!this.client?.session && this.chain.length > 0
  }

  async onEvent(event: OpencodeEvent): Promise<void> {
    if (!this.enabled) return
    const { type, properties: props } = event
    if (!props) return

    if (type === "message.updated") {
      const info = props.info
      const provider = info?.providerID
      const model = info?.modelID
      const sid = info?.sessionID
      // Track current model regardless of eligibility — harmless, and needed
      // so an eligible session's baseline model is known once it does fail over.
      if (sid && provider && model) this.currentModel.set(sid, `${provider}/${model}`)
      if (sid && info?.error && ModelFailover.retryable(info.error))
        await this.tryFallback(sid, false, "message.error")
      return
    }
    if (type === "session.error") {
      const sid = props.sessionID ?? props.info?.id
      if (sid && ModelFailover.retryable(props.error)) await this.tryFallback(sid, false, "session.error")
      return
    }
    if (type === "session.status") {
      const sid = props.sessionID ?? props.info?.id
      const status = props.status
      const retryable =
        ModelFailover.retryable(status) ||
        ModelFailover.retryable(props.error) ||
        (status?.message !== undefined && ModelFailover.retryable(status.message))
      if (sid && retryable) await this.tryFallback(sid, true, "session.status.retry")
      return
    }
    if (type === "session.deleted") {
      const sid = props.info?.id ?? props.sessionID
      if (sid) {
        this.currentModel.delete(sid)
        this.tried.delete(sid)
        this.inProgress.delete(sid)
        this.lastTrigger.delete(sid)
        this.attempts.delete(sid)
      }
    }
  }

  private async tryFallback(sessionID: string, withAbort: boolean, reason: string): Promise<void> {
    if (!sessionID || this.inProgress.has(sessionID)) return

    // Fail-closed agent gate: an unknown agent (no chat.message seen yet for
    // this session) must be treated as NOT eligible, same as a confirmed
    // non-orchestrator session. Silently re-prompting an unidentified session
    // on a different model is exactly the bug this gate exists to prevent
    // (see module doc / FIX 1: council seats losing model diversity).
    if (!this.isEligible(sessionID)) {
      this.log.debug("failover", "skipped: session is not the orchestrator (or agent unknown)", {
        sessionID,
        reason,
      })
      return
    }

    const now = this.now()
    const last = this.lastTrigger.get(sessionID) ?? 0
    if (last + FAILOVER_DEDUP_MS > now) {
      this.log.debug("failover", "deduped", { sessionID, reason })
      return
    }
    this.lastTrigger.set(sessionID, now)

    // A session's fallback chain is consumed at most once per session
    // lifetime — no time-based reset. A provider flapping indefinitely must
    // not produce unbounded cross-model replays; it should simply exhaust the
    // chain once and then stop (see session.deleted for the only reset path).
    const used = this.attempts.get(sessionID) ?? 0
    if (used >= this.chain.length) {
      this.log.warn("failover", "max attempts per session reached", { sessionID, reason, used })
      return
    }

    const next = this.pickNextModel(sessionID)
    if (!next) {
      this.log.warn("failover", "chain exhausted", {
        sessionID,
        reason,
        tried: [...(this.tried.get(sessionID) ?? [])],
      })
      return
    }

    this.inProgress.add(sessionID)
    try {
      const replay = await this.lastUserReplay(sessionID)
      if (!replay || (!replay.text && replay.fileParts.length === 0)) {
        this.log.warn("failover", "no replayable user content", { sessionID })
        return
      }
      const slash = next.indexOf("/")
      if (slash < 0) return
      const providerID = next.slice(0, slash)
      const modelID = next.slice(slash + 1)

      const tried = this.tried.get(sessionID) ?? new Set<string>()
      tried.add(next)
      this.tried.set(sessionID, tried)
      this.attempts.set(sessionID, used + 1)
      const from = this.currentModel.get(sessionID)
      this.currentModel.set(sessionID, next)

      this.log.info("failover", "switching model", { sessionID, reason, from, to: next, withAbort })

      const session = this.client?.session
      if (!session) return
      if (withAbort) await session.abort({ path: { id: sessionID } }).catch(() => {})
      const fire = session.promptAsync ?? session.prompt
      const parts: PromptPart[] = []
      if (replay.text) parts.push({ type: "text", text: replay.text })
      for (const fp of replay.fileParts) parts.push(fp)
      void Promise.resolve(
        fire.call(session, {
          path: { id: sessionID },
          body: { model: { providerID, modelID }, parts },
        }),
      ).catch((err: unknown) =>
        this.log.error("failover", "re-prompt failed", { sessionID, err: String(err) }),
      )
    } finally {
      this.inProgress.delete(sessionID)
    }
  }

  private pickNextModel(sessionID: string): string | null {
    const cur = this.currentModel.get(sessionID)
    const tried = this.tried.get(sessionID) ?? new Set<string>()
    for (const m of this.chain) {
      if (m === cur || tried.has(m)) continue
      return m
    }
    return null
  }

  /**
   * Last real user message content (text + any file attachments), skipping
   * injected/synthetic parts, ready to replay on the fallback model.
   *
   * SAFETY: if the message contains a part type we cannot faithfully
   * reconstruct (anything other than text or file), replay is aborted
   * entirely (returns null) rather than silently dropping it — a lossy
   * replay (e.g. losing a reasoning/tool part that changes the meaning of
   * the request) is worse than no replay.
   */
  private async lastUserReplay(sessionID: string): Promise<{
    text: string
    fileParts: Array<{ type: "file"; mime: string; filename?: string; url: string }>
  } | null> {
    try {
      const res = (await this.client?.session.messages({ path: { id: sessionID } })) as
        | { data?: unknown[] }
        | unknown[]
        | undefined
      const arr: unknown[] = Array.isArray(res) ? res : (res?.data ?? [])
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        const msg = arr[i] as { info?: { role?: string }; role?: string; parts?: MessagePart[] }
        const role = msg?.info?.role ?? msg?.role
        if (role !== "user") continue
        const real = (msg?.parts ?? []).filter((p) => !p?.synthetic)
        const unreconstructable = real.filter((p) => p?.type !== "text" && p?.type !== "file")
        if (unreconstructable.length > 0) {
          this.log.warn("failover", "unreplayable part type; aborting replay to avoid a lossy re-prompt", {
            sessionID,
            types: unreconstructable.map((p) => p?.type),
          })
          return null
        }
        const text = real
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
          .trim()
        const fileParts = real
          .filter((p) => p?.type === "file")
          .map((p) => ({
            type: "file" as const,
            mime: typeof p.mime === "string" ? p.mime : "application/octet-stream",
            filename: p.filename,
            url: typeof p.url === "string" ? p.url : "",
          }))
        if (text || fileParts.length > 0) return { text, fileParts }
      }
    } catch (err) {
      this.log.error("failover", "messages() failed", { sessionID, err: String(err) })
    }
    return null
  }

  private static retryable(err: unknown): boolean {
    if (!err) return false
    if (typeof err === "string") return RETRYABLE.test(err)
    if (typeof err !== "object") return false
    try {
      const record = err as { statusCode?: unknown; data?: { statusCode?: unknown } }
      const sc = record.statusCode ?? record.data?.statusCode
      if (typeof sc === "number" && OUTAGE_CODES.has(sc)) return true
      return RETRYABLE.test(JSON.stringify(err))
    } catch {
      return false
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DelegateRetry: fix hints for failed task() calls
// ─────────────────────────────────────────────────────────────────────────────

interface RetryPattern {
  readonly match: string
  readonly hint: string
}

/** Appends an actionable hint to a native opencode task-tool error (v1.18.x). */
class DelegateRetry {
  private static readonly PATTERNS: readonly RetryPattern[] = [
    { match: "is not a valid agent type", hint: "Use a valid subagent_type from the available specialists." },
    {
      match: "Subagent depth limit reached",
      hint: "This subagent cannot nest deeper. Do the work here or report to the user; do not retry.",
    },
    {
      match: "Background subagents require",
      hint: "Background subagents are unavailable here; retry the same task without background: true.",
    },
  ]

  constructor(private readonly log: Log) {}

  apply(input: { tool?: string }, output: { output?: unknown }): void {
    try {
      if (input?.tool !== "task") return
      const text = typeof output?.output === "string" ? output.output : ""
      if (!text) return
      const hit = DelegateRetry.PATTERNS.find((p) => text.includes(p.match))
      if (!hit) return
      output.output = `${text}\n\n<system-reminder>\ntask() failed. ${hit.hint} Do not repeat the identical call.\n</system-reminder>`
      this.log.info("retry", "hint appended", { matched: hit.match })
    } catch (err) {
      this.log.error("retry", "apply failed", { err: String(err) })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PresetManager: per-session orchestration model preset application
// ─────────────────────────────────────────────────────────────────────────────

/** Agents whose model the preset may override. Council seats are excluded. */
const MANAGED_AGENTS = new Set(["orchestrator", "explorer", "librarian", "oracle", "fixer"])

interface ModelRef {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}
type Preset = Readonly<Record<string, ModelRef>>

/** Parses "provider/model" at the first slash (model ids may contain dots/dashes). */
function m(spec: string, variant?: string): ModelRef {
  const slash = spec.indexOf("/")
  const providerID = slash >= 0 ? spec.slice(0, slash) : ""
  const modelID = slash >= 0 ? spec.slice(slash + 1) : ""
  if (!providerID || !modelID) throw new Error(`invalid model spec: ${spec}`)
  return variant ? { providerID, modelID, variant } : { providerID, modelID }
}

/**
 * Preset table file, substituted at build time by Nix `replaceVars` with the
 * store path of a JSON file written from `builtins.toJSON
 * parallelCfg.presets` (see `presetsFile` in default.nix). This file defines
 * no presets itself — they are entirely host-provided, so a reusable
 * checkout of this module carries no host-specific model IDs.
 *
 * A file path (rather than inlining the JSON text into the source) is used
 * deliberately: JSON can contain `"` and `` ` `` characters that would break
 * out of a quoted or template-literal TS string once substituted, while a
 * Nix store path is always a plain, quote-free string.
 *
 * Overridable via `OPENCODE_ORCHESTRATOR_PRESETS_FILE` — read lazily inside
 * the plugin entry (not at module scope) so tests can point at a synthetic
 * fixture file without a module reload.
 */
const PRESETS_FILE_TOKEN = "@presetsFile@"

/**
 * Reads and validates the host-provided preset table from `path`. Malformed
 * input never throws: an unsubstituted token, empty path, unreadable file,
 * invalid JSON, or a non-object root all fall back to an empty table (no
 * presets, no overrides). A malformed *individual* preset (unknown
 * managed-agent key, missing/invalid `model`, or invalid `variant`) is
 * rejected as a whole — partial application of a broken preset would be
 * worse than none.
 */
function loadPresets(path: string, log: Log): Readonly<Record<string, Preset>> {
  if (path.trim().length === 0 || (path.startsWith("@") && path.endsWith("@"))) return {}

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (err) {
    log.warn("preset", "presets file unreadable; ignoring", { path, err: String(err) })
    return {}
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    log.warn("preset", "invalid presets JSON; ignoring", { err: String(err) })
    return {}
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    log.warn("preset", "presets JSON root must be an object; ignoring")
    return {}
  }

  const result: Record<string, Preset> = {}
  for (const [name, entryRaw] of Object.entries(data as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      log.warn("preset", "malformed preset entry; rejecting", { name })
      continue
    }
    const preset: Record<string, ModelRef> = {}
    let ok = true
    for (const [agent, refRaw] of Object.entries(entryRaw as Record<string, unknown>)) {
      if (!MANAGED_AGENTS.has(agent)) {
        log.warn("preset", "unknown agent key in preset; rejecting whole preset", { name, agent })
        ok = false
        break
      }
      if (!refRaw || typeof refRaw !== "object") {
        ok = false
        break
      }
      const { model, variant } = refRaw as { model?: unknown; variant?: unknown }
      if (typeof model !== "string" || model.indexOf("/") <= 0) {
        ok = false
        break
      }
      if (variant !== undefined && variant !== null && typeof variant !== "string") {
        ok = false
        break
      }
      try {
        preset[agent] = m(model, typeof variant === "string" ? variant : undefined)
      } catch {
        ok = false
        break
      }
    }
    if (!ok) {
      log.warn("preset", "invalid preset entry; rejecting whole preset", { name })
      continue
    }
    result[name] = preset
  }
  return result
}

/** Resolves the preset state file path lazily, honoring XDG_DATA_HOME (and
 * test overrides), never at module scope. */
function presetStatePath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "orchestrator-preset.json")
}

/**
 * Reads the preset name from disk, once per call site. Returns `null` for a
 * missing file (silent — this is the normal "no override" state, host Nix
 * config stays effective) or a malformed/unknown value (logs a warning).
 */
function readPresetName(log: Log, presets: Readonly<Record<string, Preset>>): string | null {
  let raw: string
  try {
    raw = readFileSync(presetStatePath(), "utf8")
  } catch {
    return null // missing/unreadable file: fail-open, no override, no log.
  }
  try {
    const data: unknown = JSON.parse(raw)
    const preset = (data as { preset?: unknown } | null)?.preset
    if (typeof preset === "string" && preset in presets) return preset
    log.warn("preset", "unknown or malformed preset value", { preset })
    return null
  } catch (err) {
    log.warn("preset", "malformed preset state file", { err: String(err) })
    return null
  }
}

/**
 * Snapshots the orchestration preset once per new top-level session (on its
 * first chat.message) and applies it to every subsequent message for that
 * session and its descendants, mutating only the managed agents' model.
 *
 * Child sessions inherit the parent's already-taken snapshot rather than
 * re-reading the state file, so a mid-conversation preset change on disk
 * never splits one logical run across two presets. A `null` snapshot means
 * "no override" (missing file, malformed value, empty preset table, or an
 * uninherited parent) and is cached just like a real preset so it is never
 * rechecked.
 */
class PresetManager {
  private readonly snapshots = new Map<string, Preset | null>()
  private readonly childParent = new Map<string, string>()

  constructor(
    private readonly log: Log,
    private readonly presets: Readonly<Record<string, Preset>>,
  ) {}

  onEvent(event: OpencodeEvent): void {
    const { type, properties: props } = event
    if (!props) return
    if (type === "session.created") {
      const parent = props.info?.parentID
      const child = props.info?.id
      if (parent && child) this.childParent.set(child, parent)
      return
    }
    if (type === "session.deleted") {
      const sid = props.info?.id ?? props.sessionID
      if (sid) {
        this.snapshots.delete(sid)
        this.childParent.delete(sid)
      }
    }
  }

  /** Mutates `message.model` in place for managed agents, per the session's
   * snapshotted preset (taken lazily on first use, see class doc). */
  apply(
    sessionID: string | undefined,
    agent: string | undefined,
    message: { model?: unknown } | undefined,
  ): void {
    if (!sessionID) return
    this.ensureSnapshot(sessionID)
    const preset = this.snapshots.get(sessionID)
    if (!preset || !message || !agent || !MANAGED_AGENTS.has(agent)) return
    const entry = preset[agent]
    if (!entry) return
    message.model = entry.variant
      ? { providerID: entry.providerID, modelID: entry.modelID, variant: entry.variant }
      : { providerID: entry.providerID, modelID: entry.modelID }
  }

  private ensureSnapshot(sessionID: string): void {
    if (this.snapshots.has(sessionID)) return
    const parent = this.childParent.get(sessionID)
    if (parent !== undefined) {
      // Child: inherit whatever the parent already snapshotted (possibly
      // `null`), never re-read the state file for a child session.
      this.snapshots.set(sessionID, this.snapshots.get(parent) ?? null)
      return
    }
    const name = readPresetName(this.log, this.presets)
    const preset = name ? this.presets[name] : null
    this.snapshots.set(sessionID, preset ?? null)
    if (preset) this.log.info("preset", "snapshot taken", { sessionID, preset: name })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin entry
// ─────────────────────────────────────────────────────────────────────────────

export const ParallelOrchestrator: Plugin = async (ctx): Promise<Hooks> => {
  const log = new Logger(PLUGIN_ID)
  // Read lazily (not at module scope) so tests can set a synthetic chain per
  // test via the environment without a module reload; see the module-scope
  // comment above FALLBACK_CHAIN_TOKEN.
  const chain = parseChain(process.env.OPENCODE_ORCHESTRATOR_FALLBACK_CHAIN ?? FALLBACK_CHAIN_TOKEN)
  log.info("plugin", "loaded", { chain })

  // Injectable clock: overridable via OPENCODE_ORCHESTRATOR_CLOCK_MS, read on
  // every call, so tests can simulate stale/runaway lanes and dedup windows
  // deterministically (no real sleeps) without a runtime export of the clock.
  const now = (): number => {
    const override = process.env.OPENCODE_ORCHESTRATOR_CLOCK_MS
    return override !== undefined ? Number(override) : Date.now()
  }

  const board = new LaneBoard(log, now)
  const client = ctx.client as unknown as PluginClient
  // Only the orchestrator agent may trigger cross-model failover — see the
  // module doc and ModelFailover's own comment for the fail-closed rationale.
  const failover = new ModelFailover(client, chain, log, (sid) => board.isOrchestratorSession(sid), now)
  const retry = new DelegateRetry(log)
  // Read lazily so tests can inject a synthetic table via the environment;
  // see the module-scope comment above PRESETS_FILE_TOKEN.
  const presetsPath = process.env.OPENCODE_ORCHESTRATOR_PRESETS_FILE ?? PRESETS_FILE_TOKEN
  const presetsTable = loadPresets(presetsPath, log)
  const presets = new PresetManager(log, presetsTable)

  return {
    "chat.message": async (input, output) => {
      board.observeAgent(input.sessionID, input.agent ?? output?.message?.agent)
      // /model policy: the preset is authoritative for managed agents and is
      // reapplied every message — no attempt to detect an explicit /model
      // override, which would be unreliable from this hook alone.
      presets.apply(
        input.sessionID,
        input.agent ?? output?.message?.agent,
        output?.message as { model?: unknown } | undefined,
      )
    },

    event: async (input) => {
      const event = input.event as OpencodeEvent
      board.onEvent(event)
      presets.onEvent(event)
      await failover.onEvent(event)
    },

    "tool.execute.after": async (input, output) => {
      retry.apply(input as { tool?: string }, output as { output?: unknown })
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages as unknown as TransformMessage[]
      if (Array.isArray(messages)) board.injectInto(messages)
    },

    // Only ADD a section, never replace the default 8-section compaction
    // template (Goal / Constraints / Progress / Decisions / Next Steps /
    // Critical Context / Relevant Files) — that template is good, it simply
    // has no delegation-state section. Setting output.prompt would discard
    // all of it for the sake of the one section we care about.
    "experimental.session.compacting": async (input, output) => {
      try {
        const text = board.compactionContext(input.sessionID)
        if (!text) {
          log.debug("compaction", "no delegation context to inject", { sessionID: input.sessionID })
          return
        }
        output.context.push(text)
        log.info("compaction", "delegation context injected", {
          sessionID: input.sessionID,
          lanes: board.listChildren(input.sessionID).length,
        })
      } catch (err) {
        log.error("compaction", "failed", { sessionID: input.sessionID, err: String(err) })
      }
    },

    // Plain object, not `tool(...)`: importing that helper at runtime would
    // abort plugin load. The cast covers the untyped JSON-Schema arg shape.
    tool: {
      cancel_task: {
        description:
          "Cancel a running background lane (subagent session) shown in the Background Job Board. " +
          "IMPORTANT: this is NOT a rollback. A writer lane may have already modified files before " +
          "cancellation; inspect the working tree / partial changes before replacing that work.",
        args: {
          task_id: {
            type: "string",
            description: "The child session id to cancel, as shown in the Background Job Board.",
          },
        },
        execute: async (args: { task_id?: unknown }, context: { sessionID: string; agent: string }) => {
          try {
            // Plain JSON Schema args get NO host-side validation before
            // execute (Schema.Unknown on the host side), so validate here.
            if (typeof args?.task_id !== "string" || args.task_id.length === 0) {
              return "cancel_task failed: task_id is required and must be a non-empty string."
            }
            if (context.agent !== ORCHESTRATOR) {
              return "cancel_task refused: only the orchestrator agent may cancel a lane."
            }
            const taskId = args.task_id
            const parent = context.sessionID
            const known = board.listChildren(parent)
            const result = board.cancelLane(parent, taskId)
            if (!result.ok) {
              log.warn("cancel_task", "unknown id", { parent, taskId, known: known.map((l) => l.child) })
              return result.error
            }
            try {
              await client.session.abort({ path: { id: taskId } })
            } catch (err) {
              log.error("cancel_task", "abort failed", { parent, taskId, err: String(err) })
              return `Marked ${taskId} cancelled locally, but the abort call failed (${String(err)}). This is NOT a rollback — inspect the working tree / partial changes before replacing that work.`
            }
            log.info("cancel_task", "cancelled", { parent, taskId })
            return `Cancelled ${taskId}. This is NOT a rollback: the lane may have already written files. Inspect the working tree / partial changes before replacing that work.`
          } catch (err) {
            log.error("cancel_task", "execute failed", { err: String(err) })
            return `cancel_task failed: ${String(err)}`
          }
        },
      },
    } as unknown as Hooks["tool"],
  }
}
