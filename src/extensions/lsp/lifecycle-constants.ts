/**
 * Leaf constants bounding LSP client lifetime and size.
 *
 * Import-free on purpose — see src/extensions/bash-timeout-constants.ts for
 * why (module evaluation order under Bun can hit TDZ ReferenceErrors on
 * circular imports; constants leaves avoid the cycle entirely).
 */

/** Max documents held open per LSP client before LRU didClose eviction. */
export const OPEN_DOCS_MAX = 50

/** Max concurrent LSP client chains; spawning past this evicts the LRU chain. */
export const MAX_CHAINS = 2

/** A chain with no activity for this long is shut down by the reaper. */
export const LSP_IDLE_EVICT_MS = 15 * 60_000

/** Reaper sweep period. */
export const LSP_REAPER_SWEEP_MS = 60_000

/** Grace between LSP "shutdown" request and SIGTERM when evicting a chain. */
export const LSP_EVICT_GRACE_MS = 2_000

/**
 * Test-only override for the idle-evict threshold (mirrors the documented
 * KIMCHI_LSP_BINARIES override pattern in servers.ts): lets live verification
 * exercise the reaper without waiting 15 wall-clock minutes.
 */
export const EFFECTIVE_IDLE_EVICT_MS = (() => {
	const override = process.env.KIMCHI_LSP_IDLE_EVICT_MS
	if (override === undefined) return LSP_IDLE_EVICT_MS
	const parsed = Number.parseInt(override, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : LSP_IDLE_EVICT_MS
})()
