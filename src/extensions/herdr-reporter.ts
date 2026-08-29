/**
 * herdr-reporter — kimchi → herdr agent-state reporter.
 *
 * herdr is a desktop app that renders per-pane agent status. This extension
 * is the kimchi-side reporter that talks to the herdr control socket and
 * surfaces agent state (idle / working / blocked) and session metadata so
 * herdr can render the pane correctly.
 *
 * The reporter is best-effort and intentionally non-throwing — herdr is an
 * out-of-process UI dependency, and a transient failure (herdr not running,
 * socket disconnected, slow handshake) must never wedge a kimchi session.
 * All socket errors are swallowed and retried once with a longer timeout;
 * after the second failure the report is dropped silently.
 *
 * Activation is driven entirely by environment variables:
 *
 *   - HERDR_ENV=1            master switch
 *   - HERDR_SOCKET_PATH      path to the herdr control socket (or pipe name)
 *   - HERDR_PANE_ID          pane identifier reported with every event
 *   - HERDR_BIN_PATH         optional path to the herdr binary (read by the
 *                            installer / daemon, not by this extension)
 *
 * When HERDR_ENV is unset, the extension is a no-op: no socket is opened
 * and no reporter is exposed on `pi`. The wiring step (separate) decides
 * what to do with `pi.herdrReporter`.
 *
 * Transport:
 *
 *   - Unix domain socket at HERDR_SOCKET_PATH on non-Windows.
 *   - Named pipe `\\.\pipe\<HERDR_SOCKET_PATH>` on Windows.
 *
 * Wire format: JSON-RPC 2.0 over newline-delimited frames (one JSON object
 * per line, terminated by `\n`). We do not currently consume responses —
 * herdr treats writes as fire-and-forget state updates — but the framing
 * matches JSON-RPC so a future version could add bidirectional control
 * without changing the transport.
 *
 * Sequence numbers start at `Date.now() * 1000` (a monotonic microsecond-ish
 * counter that is also unique across the process) and increment by 1 per
 * report. herdr uses these to detect dropped or out-of-order events.
 */

import net from "node:net"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HerdrAgentState = "idle" | "working" | "blocked"

export interface HerdrSessionRef {
	id?: string
	path?: string
}

export interface HerdrReporterOptions {
	paneId: string
	socketPath: string
	source: string
	agent: string
}

export interface HerdrReporter {
	reportState(state: HerdrAgentState, message?: string): void
	reportSession(sessionRef: HerdrSessionRef, sessionStartSource?: string): void
	/** Update the reporter's tracked session ref without emitting a report. */
	updateSessionRef(sessionRef: HerdrSessionRef): void
	/** Stop accepting new reports and wait for the queue to drain. */
	release(): Promise<void>
	/** Wait for all pending reports to be sent (or dropped). */
	drain(): Promise<void>
}

interface HerdrRequest {
	jsonrpc: "2.0"
	id: string
	method: string
	params: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** First-attempt timeout (ms). Short — we expect the herdr socket to be local. */
const INITIAL_TIMEOUT_MS = 500
/** Retry-attempt timeout (ms). Longer — gives herdr a chance to come back. */
const RETRY_TIMEOUT_MS = 1500

// ---------------------------------------------------------------------------
// Process-level beforeExit backstop (singleton)
// ---------------------------------------------------------------------------
//
// A module-level beforeExit listener is registered exactly once per process.
// Each extension instance adds its `release` callback to `beforeExitReleasers`
// and removes it on shutdown. This avoids the per-instance listener
// accumulation that would otherwise trip Node's
// MaxListenersExceededWarning when the extension is loaded repeatedly
// (tests, extension reloads, multi-session hosts).

// Exported so the regression test in `herdr-reporter.test.ts` can assert
// that each instance unregisters its release callback and the registry is
// restored to its prior size. The set itself is otherwise untouched.
export const beforeExitReleasers = new Set<() => void>()

if (typeof process !== "undefined" && typeof process.on === "function") {
	process.on("beforeExit", async () => {
		// Snapshot to allow re-entry (a release callback must not mutate
		// the set while we iterate). Collect every returned promise so
		// `await Promise.all` keeps the event loop alive until all
		// reporters have drained — otherwise the process can exit before
		// the final state report has been written to herdr's socket.
		const promises: Array<Promise<unknown>> = []
		for (const release of Array.from(beforeExitReleasers)) {
			try {
				const result = release() as unknown
				if (result && typeof (result as { then?: unknown }).then === "function") {
					promises.push(result as Promise<unknown>)
				}
			} catch {
				// best-effort — a throwing release must not block siblings
			}
		}
		await Promise.all(promises)
	})
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function unrefTimer(t: NodeJS.Timeout): void {
	// Some test/mock timers don't expose unref; ignore those.
	const maybe = t as unknown as { unref?: () => void }
	maybe.unref?.()
}

function socketAddress(socketPath: string): string {
	if (process.platform === "win32") {
		// Named-pipe path — escape backslashes for the JS string literal so the
		// runtime sees `\\.\pipe\<name>`.
		return `\\\\.\\pipe\\${socketPath}`
	}
	return socketPath
}

/**
 * Attempt a single send with the given timeout. Resolves once
 * `socket.end(data, callback)` fires — that callback runs when the data
 * has been flushed to the OS and FIN has been queued, which is the
 * earliest point we can consider the write "done". The peer's half of
 * the socket may stay open longer than our short timeouts, so we do
 * not wait for a remote `close` event — that was the source of
 * spurious "herdr send timeout" failures. Rejects on socket error or
 * timeout. Never throws synchronously.
 */
function sendOnce(request: HerdrRequest, socketPath: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const address = socketAddress(socketPath)
		const socket = net.createConnection(address)
		let settled = false

		const finish = (err?: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			// Destroy the socket so its handle is released even if the
			// remote has not yet closed its half. Idempotent and safe to
			// call after `end` has flushed.
			try {
				socket.destroy()
			} catch {
				// best-effort
			}
			if (err) reject(err)
			else resolve()
		}

		const timer = setTimeout(() => finish(new Error("herdr send timeout")), timeoutMs)
		unrefTimer(timer)

		socket.once("error", (err) => finish(err))
		socket.once("connect", () => {
			try {
				// `end(data, callback)` is equivalent to `write(data)` then
				// `end()`, with the callback registered as a one-time
				// `'finish'` listener. Resolving on `'finish'` is what gives
				// us "data flushed / FIN sent" semantics without waiting for
				// the far end to close.
				socket.end(`${JSON.stringify(request)}\n`, () => {
					finish()
				})
			} catch (err) {
				finish(err as Error)
			}
		})
	})
}

/**
 * Send a request, retrying once with a longer timeout on failure. The
 * second failure is logged (kimchi is best-effort but the user may want
 * to know herdr stopped responding) and then swallowed — callers (the
 * queue) must not surface errors.
 */
async function sendWithRetry(request: HerdrRequest, socketPath: string): Promise<void> {
	try {
		await sendOnce(request, socketPath, INITIAL_TIMEOUT_MS)
		return
	} catch {
		// first attempt failed — fall through to retry
	}
	try {
		await sendOnce(request, socketPath, RETRY_TIMEOUT_MS)
	} catch (err) {
		// Final failure after retry — herdr socket unreachable. Log so the
		// operator notices in long-lived sessions, then swallow.
		console.warn(
			`herdr reporter: dropping report (method=${request.method}) after retry — socket at ${socketPath} unreachable: ${
				err instanceof Error ? err.message : String(err)
			}`,
		)
	}
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export function createHerdrReporter(options: HerdrReporterOptions): HerdrReporter {
	const { paneId, socketPath, source, agent } = options

	// Start at wall-clock-microseconds so the first id is unique within the
	// process and roughly tracks session start. Monotonic thereafter.
	let nextSeq = Date.now() * 1000
	let queue: Promise<void> = Promise.resolve()
	let released = false

	const buildRequest = (method: string, params: Record<string, unknown>): HerdrRequest => {
		const seq = nextSeq++
		// herdr requires the JSON-RPC id field to be a string. We keep a
		// monotonic numeric counter for ordering and stringify it for the
		// framing id.
		const id = String(seq)
		// herdr uses the per-method `seq` counter to detect dropped or
		// out-of-order events; mirror the JSON-RPC id so consumers see a
		// monotonic sequence number alongside the framing id.
		return { jsonrpc: "2.0", id, method, params: { ...params, seq } }
	}

	// Tracked session ref shared across reports. Updated by
	// `updateSessionRef`; stamped onto every state report via
	// `withSessionRef` so herdr can correlate agent state with the
	// session that produced it.
	let currentSessionRef: HerdrSessionRef = {}

	function withSessionRef(params: Record<string, unknown>): void {
		// Prefer path when available, otherwise fall back to id — this
		// matches herdr's preference for a stable on-disk handle.
		if (currentSessionRef.path !== undefined) {
			params.agent_session_path = currentSessionRef.path
		} else if (currentSessionRef.id !== undefined) {
			params.agent_session_id = currentSessionRef.id
		}
	}

	const enqueue = (request: HerdrRequest): void => {
		// Chain onto the existing tail so reports are processed strictly in
		// submission order with a single in-flight writer.
		queue = queue
			.then(() => sendWithRetry(request, socketPath))
			.catch(() => {
				// Belt-and-braces — sendWithRetry already swallows, but the
				// queue tail must never reject or every later enqueue would
				// short-circuit.
			})
	}

	return {
		reportState(state, message) {
			if (released) return
			const params: Record<string, unknown> = {
				pane_id: paneId,
				source,
				agent,
				state,
			}
			if (message !== undefined) params.message = message
			withSessionRef(params)
			enqueue(buildRequest("pane.report_agent", params))
		},

		reportSession(sessionRef, sessionStartSource) {
			if (released) return
			const params: Record<string, unknown> = {
				pane_id: paneId,
				source,
				agent,
			}
			// Prefer path when available, otherwise fall back to id.
			if (sessionRef.path !== undefined) {
				params.agent_session_path = sessionRef.path
			} else if (sessionRef.id !== undefined) {
				params.agent_session_id = sessionRef.id
			}
			if (sessionStartSource !== undefined) {
				params.session_start_source = sessionStartSource
			}
			enqueue(buildRequest("pane.report_agent_session", params))
		},

		updateSessionRef(sessionRef) {
			currentSessionRef = {
				id: sessionRef.id,
				path: sessionRef.path,
			}
		},

		async release() {
			released = true
			await this.drain()
		},

		async drain() {
			await queue
		},
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

interface HerdrReporterExtensionApi extends ExtensionAPI {
	herdrReporter?: HerdrReporter
}

/**
 * Read the herdr environment and return the parsed view. Exported for
 * the wiring step and for tests that need to assert activation logic
 * without touching `process.env` directly.
 */
export function readHerdrEnv(): {
	enabled: boolean
	socketPath?: string
	paneId?: string
	binPath?: string
} {
	const env = process.env.HERDR_ENV
	const socketPath = process.env.HERDR_SOCKET_PATH
	const paneId = process.env.HERDR_PANE_ID
	const binPath = process.env.HERDR_BIN_PATH

	const enabled = env === "1" && Boolean(socketPath) && Boolean(paneId)
	return { enabled, socketPath, paneId, binPath }
}

export default function herdrReporterExtension(pi: ExtensionAPI): void {
	const view = readHerdrEnv()
	if (!view.enabled || !view.socketPath || !view.paneId) return

	const reporter = createHerdrReporter({
		paneId: view.paneId,
		socketPath: view.socketPath,
		source: "herdr:kimchi",
		agent: "kimchi",
	})

	// Expose the reporter on `pi` so external consumers (e.g. tests, the
	// daemon bridge) can introspect or send custom reports without having
	// to re-read the environment or re-create the reporter.
	const piWithReporter = pi as HerdrReporterExtensionApi
	piWithReporter.herdrReporter = reporter

	// -------------------------------------------------------------------
	// State machine
	// -------------------------------------------------------------------
	//
	// We track three orthogonal bits of state and collapse them to one
	// of three herdr-facing states:
	//
	//   - blocked   when at least one herdr:blocked activation is active
	//   - working   when the agent loop is currently running
	//   - idle      when nothing is happening
	//
	// blocked > working > idle — a prompt that opens while the agent is
	// mid-turn still surfaces as blocked, because that's the state the
	// user actually cares about.
	//
	// We only drive this state machine for the root TUI session. RPC and
	// JSON modes may also emit session_start, but those runtimes drive
	// their own UX and shouldn't pin a herdr pane.
	let agentActive = false
	let blockedCount = 0
	let blockedMessage: string | undefined
	let lastState: HerdrAgentState | undefined
	let lastMessage: string | undefined
	let rootSession = false
	let released = false

	function updateSessionRef(ctx: ExtensionContext | undefined): HerdrSessionRef {
		const ref: HerdrSessionRef = {}
		try {
			const file = ctx?.sessionManager?.getSessionFile?.()
			if (typeof file === "string" && file.length > 0) {
				ref.path = file
			}
		} catch {
			// best-effort — leave path unset
		}
		try {
			const id = ctx?.sessionManager?.getSessionId?.()
			if (typeof id === "string" && id.length > 0) {
				ref.id = id
			}
		} catch {
			// best-effort — leave id unset
		}
		// Sync the reporter's tracked ref so subsequent state reports pick
		// up the latest session handle via `withSessionRef`.
		reporter.updateSessionRef(ref)
		return ref
	}

	function desiredState(): { state: HerdrAgentState; message?: string } {
		if (blockedCount > 0) {
			return { state: "blocked", message: blockedMessage }
		}
		if (agentActive) {
			return { state: "working" }
		}
		return { state: "idle" }
	}

	function publishState(force = false): void {
		const next = desiredState()
		if (!force && next.state === lastState && next.message === lastMessage) {
			return
		}
		lastState = next.state
		lastMessage = next.message
		reporter.reportState(next.state, next.message)
	}

	function resetForRootSession(ctx: ExtensionContext, sessionStartSource?: string): void {
		rootSession = true
		const ref = updateSessionRef(ctx)
		reporter.reportSession(ref, sessionStartSource)
		agentActive = ctx?.isIdle?.() === false
		publishState()
	}

	// The very first session_start in TUI mode anchors the root session.
	// `event.reason` carries the source (e.g. "startup", "resume") that
	// herdr uses to render session badges.
	pi.on("session_start", async (event, ctx) => {
		if (ctx?.mode !== "tui") return
		const reason = (event as { reason?: unknown } | undefined)?.reason
		const sessionStartSource = typeof reason === "string" ? reason : undefined
		resetForRootSession(ctx, sessionStartSource)
	})

	pi.on("agent_start", (_event, ctx) => {
		if (!rootSession) return
		const ref = updateSessionRef(ctx)
		reporter.reportSession(ref)
		agentActive = true
		publishState()
	})

	pi.on("agent_settled", (_event, ctx) => {
		if (!rootSession) return
		if (ctx?.isIdle?.() === true) {
			agentActive = false
			publishState()
		}
	})

	// Subscriptions to herdr:blocked refcount nested activations across
	// every prompt surface (permissions, questionnaires, manual confirm).
	// The bus emits activations BEFORE the prompt and deactivations in a
	// finally — paired counts are the source of truth for "blocked".
	pi.events.on("herdr:blocked", (data) => {
		if (!rootSession) return
		const payload = data as { active?: unknown; label?: unknown } | undefined
		const active = payload?.active
		const label = typeof payload?.label === "string" ? payload.label : undefined

		if (active === true) {
			blockedCount += 1
			if (label !== undefined) blockedMessage = label
			publishState()
			return
		}

		if (active === false) {
			blockedCount = Math.max(0, blockedCount - 1)
			if (blockedCount === 0) blockedMessage = undefined
			publishState()
		}
	})

	// Release lifecycle authority on session shutdown so the herdr pane
	// can hand off to another integrator. beforeExit is a backstop for
	// abnormal exits that bypass session_shutdown.
	//
	// Returns the promise from `reporter.release()` so callers
	// (session_shutdown, the beforeExit backstop) can await the drain.
	// The returned promise is also collected by the module-level
	// `beforeExit` listener to keep the event loop alive until the
	// final state report has been written.
	const releaseReporter = (): Promise<void> => {
		if (released) return Promise.resolve()
		// Force a final idle state report BEFORE marking released so the
		// reporter still accepts the enqueue. Without this, herdr would
		// keep whatever the last `working` / `blocked` state was — the
		// pane would appear stuck after kimchi exits.
		agentActive = false
		blockedCount = 0
		blockedMessage = undefined
		publishState(true)
		released = true
		// De-register from the process-level backstop so repeated
		// extension instances (e.g. test reloads) do not accumulate
		// beforeExit listeners and trip Node's
		// MaxListenersExceededWarning.
		beforeExitReleasers.delete(releaseReporter)
		return reporter.release()
	}

	// Register this instance's release with the process-level backstop.
	beforeExitReleasers.add(releaseReporter)

	pi.on("session_shutdown", () => {
		// Fire-and-forget — the module-level `beforeExit` handler awaits
		// the returned promise so abnormal exits still drain the final
		// report.
		void releaseReporter()
	})
}
