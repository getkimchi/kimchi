/**
 * Adaptive GC: bound JSC heap growth in long
 * sessions with two collection paths:
 *
 * 1. Idle collection — after the agent has been idle for a delay
 *    (default 120 s), one full collection. Bounds the transient garbage
 *    that accumulates over long idle stretches (measured: 383 MiB of JSC
 *    heap holding ~180 KiB of live session content).
 * 2. Growth collection — during long UNINTERRUPTED runs (hours of turns
 *    with no idle window), check RSS growth at message boundaries; when
 *    growth exceeds a threshold (default 128 MiB above the post-GC
 *    baseline), collect. Keeps a continuously-working agent bounded too.
 *
 * Mid-run safety: growth checks run on message_end (between messages, never
 * mid-stream), are time-throttled (default 30 s minimum between growth
 * collections), and a full collection is ~10–40 ms on a ~100 MiB heap.
 * Cross-session safety: a module-level registry tracks every session's
 * agent (busy while a turn is in flight); EVERY collection — idle, zero-delay
 * and growth — is gated on "no OTHER session is mid-request" because
 * `Bun.gc(true)` is stop-the-world and would freeze it. Idle timers are
 * unref()ed so they never hold the event loop open. A session that vanishes
 * without firing agent_end (crash, aborted request) is evicted by a
 * staleness watchdog after `staleBusyMs` (default 10 min) so one dead
 * session cannot gate the whole process forever.
 *
 * Knobs:
 *   - KIMCHI_IDLE_GC=off           disable entirely (escape hatch)
 *   - KIMCHI_IDLE_GC_DELAY_MS      idle delay (default 120000)
 *   - KIMCHI_GC_GROWTH_BYTES       growth threshold (default 134217728)
 *   - KIMCHI_GC_MIN_INTERVAL_MS    min interval between growth GCs (default 30000)
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { parseEnvInt } from "../shared/env-int.js"

export const IDLE_GC_DELAY_MS = 120_000
export const GC_GROWTH_BYTES = 128 * 1024 * 1024
export const GC_MIN_INTERVAL_MS = 30_000

export function idleGcDelayMs(): number {
	return parseEnvInt("KIMCHI_IDLE_GC_DELAY_MS", IDLE_GC_DELAY_MS)
}

export function gcGrowthBytes(): number {
	return parseEnvInt("KIMCHI_GC_GROWTH_BYTES", GC_GROWTH_BYTES)
}

export function gcMinIntervalMs(): number {
	return parseEnvInt("KIMCHI_GC_MIN_INTERVAL_MS", GC_MIN_INTERVAL_MS)
}

/**
 * Module-level registry of every session's agent (one entry per scheduler
 * instance). `busy` tracks whether that session has a turn in flight; the
 * token stays registered for the session's lifetime (removed on
 * session_shutdown) so the gate can exclude SELF rather than count heads.
 */
interface ActiveAgentEntry {
	busy: boolean
	busySince: number
}
const activeAgents = new Map<symbol, ActiveAgentEntry>()

/** A busy entry older than this is treated as a vanished session and evicted. */
export const GC_STALE_BUSY_MS = 10 * 60_000

/** Test-only: clear the cross-session registry so tests cannot pollute each other. */
export function resetAdaptiveGcForTests(): void {
	activeAgents.clear()
}

export function idleGcEnabled(): boolean {
	return process.env.KIMCHI_IDLE_GC !== "off"
}

export interface AdaptiveGcOptions {
	/** Idle delay before an idle collection (default 120s; 0 = immediate). */
	idleDelayMs?: number
	/** RSS growth above the post-GC baseline that triggers a collection (default 128 MiB; 0 = every check). */
	growthBytes?: number
	/** Minimum time between growth collections (default 30s). */
	minIntervalMs?: number
	/** RSS reader, injectable for tests. */
	rssOf?: () => number
	/** Test hook: cross-session activity gate (defaults to the module registry). */
	othersActive?: () => boolean
	/** How long a foreign busy entry may block collections before it is treated as a vanished session (default 10 min). */
	staleBusyMs?: number
}

/**
 * The adaptive GC scheduler. Exported for unit tests; the extension factory
 * wires the same pieces to pi events.
 */
export function createAdaptiveGcScheduler(
	gather: () => void,
	options: AdaptiveGcOptions = {},
): {
	onAgentEnd: () => void
	onAgentStart: () => void
	onMessageEnd: () => void
	onSessionShutdown: () => void
} {
	const idleDelayMs = options.idleDelayMs ?? idleGcDelayMs()
	const growthBytes = options.growthBytes ?? gcGrowthBytes()
	const minIntervalMs = options.minIntervalMs ?? gcMinIntervalMs()
	const rssOf = options.rssOf ?? (() => process.memoryUsage().rss)
	const staleBusyMs = options.staleBusyMs ?? GC_STALE_BUSY_MS
	const agentToken = Symbol("adaptive-gc-agent")

	/**
	 * True when any OTHER session has a request in flight. Stale entries
	 * (busy for longer than `staleBusyMs`, i.e. a session that vanished
	 * without firing agent_end) are evicted with a warning so one dead
	 * session cannot gate the whole process forever.
	 */
	const othersActive =
		options.othersActive ??
		(() => {
			const now = Date.now()
			let blocked = false
			for (const [token, entry] of activeAgents) {
				if (token === agentToken || !entry.busy) continue
				if (now - entry.busySince > staleBusyMs) {
					console.warn("[adaptive-gc] evicting a stale busy session from the GC gate (no agent_end for a while)")
					activeAgents.delete(token)
					continue
				}
				blocked = true
			}
			return blocked
		})

	let idleTimer: ReturnType<typeof setTimeout> | undefined
	let baseline = rssOf()
	let lastGrowthGcAt = 0

	const clearIdle = () => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer)
			idleTimer = undefined
		}
	}

	const collect = () => {
		try {
			gather()
		} catch (error) {
			console.error("[adaptive-gc] collection failed:", error)
		}
		// Re-baseline AFTER the collection so growth measures garbage, not
		// legitimately resident content.
		baseline = rssOf()
	}

	const armIdle = () => {
		idleTimer = setTimeout(() => {
			idleTimer = undefined
			// Another session is mid-request: a stop-the-world collection now
			// would freeze it. Re-arm and try again (never a 0 ms spin — at
			// least 1 s between checks while blocked).
			if (othersActive()) {
				idleTimer = setTimeout(
					() => {
						idleTimer = undefined
						if (!othersActive()) collect()
					},
					Math.max(idleDelayMs, 1_000),
				)
				idleTimer.unref?.()
				return
			}
			collect()
		}, idleDelayMs)
		// Never hold the event loop open just for a pending collection.
		idleTimer.unref?.()
	}

	return {
		onAgentEnd: () => {
			const entry = activeAgents.get(agentToken)
			if (entry) entry.busy = false
			clearIdle()
			if (idleDelayMs === 0) {
				// Zero-delay is a debug knob; when another session is mid-request
				// skip (the next boundary retries) rather than spin.
				if (!othersActive()) collect()
				return
			}
			armIdle()
		},
		onAgentStart: () => {
			const now = Date.now()
			const entry = activeAgents.get(agentToken)
			if (entry) {
				entry.busy = true
				entry.busySince = now
			} else {
				activeAgents.set(agentToken, { busy: true, busySince: now })
			}
			clearIdle()
		},
		onMessageEnd: () => {
			// Time-throttle: at most one growth collection per minIntervalMs,
			// so an oscillating RSS cannot thrash the collector mid-run.
			const now = Date.now()
			if (now - lastGrowthGcAt < minIntervalMs) return
			if (rssOf() - baseline >= growthBytes) {
				// Cross-session gate: this session is between messages (a safe
				// checkpoint for itself), but a full collection is stop-the-world —
				// skip while any other session has a request in flight.
				if (othersActive()) return
				lastGrowthGcAt = now
				collect()
			}
		},
		onSessionShutdown: () => {
			// The session is gone: drop its token and any pending timer. Unlike
			// agent_end this must NOT re-arm a collection for a dead session.
			activeAgents.delete(agentToken)
			clearIdle()
		},
	}
}

const adaptiveGcExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	if (!idleGcEnabled()) return

	// Node tests / non-Bun runtimes lack Bun.gc; the scheduler is inert there.
	const gather = () => {
		;(globalThis as { Bun?: { gc: (force: boolean) => void } }).Bun?.gc(true)
	}

	const scheduler = createAdaptiveGcScheduler(gather)

	pi.on("agent_end", () => scheduler.onAgentEnd())
	pi.on("agent_start", () => scheduler.onAgentStart())
	// message_end is between messages — a safe mid-run checkpoint for the
	// growth path (never mid-stream).
	pi.on("message_end", () => scheduler.onMessageEnd())
	// Session shutdown: the session is gone — drop its registry token and any
	// pending idle timer (no collection, no re-arm).
	pi.on("session_shutdown", () => scheduler.onSessionShutdown())
}

export default adaptiveGcExtension
