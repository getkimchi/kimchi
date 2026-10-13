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
} {
	const idleDelayMs = options.idleDelayMs ?? idleGcDelayMs()
	const growthBytes = options.growthBytes ?? gcGrowthBytes()
	const minIntervalMs = options.minIntervalMs ?? gcMinIntervalMs()
	const rssOf = options.rssOf ?? (() => process.memoryUsage().rss)

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

	return {
		onAgentEnd: () => {
			clearIdle()
			if (idleDelayMs === 0) {
				collect()
				return
			}
			idleTimer = setTimeout(() => {
				idleTimer = undefined
				collect()
			}, idleDelayMs)
		},
		onAgentStart: () => {
			clearIdle()
		},
		onMessageEnd: () => {
			// Time-throttle: at most one growth collection per minIntervalMs,
			// so an oscillating RSS cannot thrash the collector mid-run.
			const now = Date.now()
			if (now - lastGrowthGcAt < minIntervalMs) return
			if (rssOf() - baseline >= growthBytes) {
				lastGrowthGcAt = now
				collect()
			}
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
	// Session shutdown: nothing to collect into, just drop the timer.
	pi.on("session_shutdown", () => scheduler.onAgentStart())
}

export default adaptiveGcExtension
