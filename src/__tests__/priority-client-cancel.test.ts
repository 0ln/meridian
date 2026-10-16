/**
 * A client that cancels a request routed by priority stops the model.
 *
 * Every attempt of a priority-routed request adopts the request's abort link,
 * which hears the client go away, the turn watchdog, a parent's cancellation
 * and shutdown. Only the outer handler, once the request is over, detaches it.
 * An attempt that detached it as it returned left the rest of the
 * request deaf: the client was gone and the model went on to the end of its
 * turn, on the account's allowance. A streaming client that had already
 * received bytes still stopped it by cancelling the body; one cancelled before
 * the first byte, in the queue for an SDK slot, or while the CLI started, did
 * not, and neither did any non-streaming one.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

/** Each model turn's abort signal, in the order the turns started. */
let turns: Array<AbortSignal | undefined> = []
/** An account whose API refuses every turn. */
let refusing: string | undefined

installSdkMock(() => ({
  query: (params: any) => (async function* () {
    const dir: string = params.options?.env?.CLAUDE_CONFIG_DIR ?? ""
    if (refusing && dir.endsWith(`/${refusing}`)) throw new Error("API Error: 429 rate limited")
    const signal: AbortSignal | undefined = params.options?.abortController?.signal
    turns.push(signal)
    // A long turn, which ends early only when it is aborted.
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 3000)
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
    })
    yield { ...assistantMessage([{ type: "text", text: "the whole turn" }]), session_id: resolveMockSdkSessionId(params.options, "cancel-session") }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "priority-client-cancel.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")

const savedEnv: Record<string, string | undefined> = {}
let root = ""

beforeEach(() => {
  turns = []
  refusing = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-priority-cancel-")))
  resetOAuthUsageCache()
  clearSessionCache()
  resetActiveProfile()
  rateLimitStore.clear()
  __setFetchOAuthUsageOverride(async () => null)
  for (const key of ["MERIDIAN_ROUTING", "MERIDIAN_PROFILE_ORDER", "MERIDIAN_SESSION_TURN_MAX_HOLD_MS"]) {
    savedEnv[key] = process.env[key]
  }
  process.env.MERIDIAN_ROUTING = "active+priority"
  process.env.MERIDIAN_PROFILE_ORDER = "work,spare"
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __setFetchOAuthUsageOverride(null)
  rateLimitStore.clear()
  resetActiveProfile()
  rmSync(root, { recursive: true, force: true })
})

async function until(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not so after ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Send one request to a fresh proxy with two accounts, `work` first. */
function startRequest(stream: boolean, session: string, signal?: AbortSignal): Promise<Response> {
  const profiles = ["work", "spare"].map(id => ({ id, claudeConfigDir: join(root, id) }))
  const app = createProxyServer({ port: 0, host: "127.0.0.1", profiles, defaultProfile: "work" }).app
  return Promise.resolve(app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "x-opencode-session": session },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream, messages: [{ role: "user", content: "a long task" }] }),
  })))
}

/** Read a response out, streamed or not, so the request is over. */
async function drain(pending: Promise<Response>): Promise<void> {
  const response = await pending.catch(() => undefined)
  await response?.text().catch(() => "")
}

/**
 * Start a request, wait for its model turn to begin, cancel it, and say
 * whether the turn was stopped and how long the request ran on after the
 * cancel. A turn runs 3 s unless it is aborted.
 */
async function cancelDuringTurn(stream: boolean, session: string): Promise<{ stopped: boolean; endedAfterMs: number }> {
  const cancel = new AbortController()
  const pending = startRequest(stream, session, cancel.signal)
  // A failover waits out the refused account's retries before it moves on.
  await until(() => turns.length > 0, 10_000)
  const cancelledAt = Date.now()
  cancel.abort()
  let stopped = true
  await until(() => turns.at(-1)?.aborted === true, 500).catch(() => { stopped = false })
  await drain(pending)
  return { stopped, endedAfterMs: Date.now() - cancelledAt }
}

describe("a client that cancels a request routed by priority", () => {
  it("stops the model", async () => {
    const outcome = await cancelDuringTurn(false, "cancel-plain")
    expect(outcome.stopped).toBe(true)
    // Ended by the cancel, not by the turn running out.
    expect(outcome.endedAfterMs).toBeLessThan(1500)
  })

  it("stops the model when it streams and goes before the first byte", async () => {
    const outcome = await cancelDuringTurn(true, "cancel-stream")
    expect(outcome.stopped).toBe(true)
    expect(outcome.endedAfterMs).toBeLessThan(1500)
  })

  it("stops the model on the account a failover reached", async () => {
    // `work` refuses the turn, and the request fails over to `spare`:
    // the first attempt's end must not leave the second deaf to the client.
    refusing = "work"
    const outcome = await cancelDuringTurn(false, "cancel-failover")
    expect(outcome.stopped).toBe(true)
    expect(outcome.endedAfterMs).toBeLessThan(1500)
  }, 20_000)

  it("lets the session-turn watchdog stop the model", async () => {
    // The watchdog aborts through the same request-wide link as the client.
    process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = "300"
    const startedAt = Date.now()
    await drain(startRequest(false, "watchdog-plain"))
    expect(turns).toHaveLength(1)
    expect(turns[0]?.aborted).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })
})

describe("a client that cancels a request under manual routing", () => {
  // The control: without priority dispatch the handler that runs the turn is
  // the one the request entered, so its link stayed attached through the turn.
  it("stops the model", async () => {
    process.env.MERIDIAN_ROUTING = "manual"
    const outcome = await cancelDuringTurn(false, "cancel-manual")
    expect(outcome.stopped).toBe(true)
    expect(outcome.endedAfterMs).toBeLessThan(1500)
  })
})
