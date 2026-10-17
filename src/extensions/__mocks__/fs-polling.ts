import type * as fs from "node:fs"
import { unwatchFile, watch, watchFile } from "node:fs"
import { vi } from "vitest"

/**
 * Shared support for tests that exercise `startStatPoller` consumers: installs
 * a capture on the mocked `watchFile` so tests can fire the poll listener
 * directly (elapsed time is not a reliable readiness signal for stat polling).
 *
 * Each test file still needs its own inline `vi.mock("node:fs", factory)` —
 * vitest hoists `vi.mock` above imports, so the factory cannot live here —
 * but the capture/reset wiring below is the single shared implementation.
 *
 * Typical use:
 *
 * ```ts
 * vi.mock("node:fs", async (importOriginal) => ({
 * 	...(await importOriginal<typeof fs>()),
 * 	watch: vi.fn(),
 * 	watchFile: vi.fn(),
 * 	unwatchFile: vi.fn(),
 * }))
 * // in beforeEach:
 * resetFsPollingMock()
 * // then:
 * pollListener()(statSync(path), statSync(path))
 * ```
 */
let captured: fs.StatsListener | undefined

/** Resets the `node:fs` watch mocks and arms listener capture on `watchFile`. */
export function resetFsPollingMock(): void {
	captured = undefined
	vi.mocked(watch).mockReset()
	vi.mocked(unwatchFile).mockReset()
	vi.mocked(watchFile).mockReset()
	vi.mocked(watchFile).mockImplementation(((_filename: unknown, optionsOrListener: unknown, listener?: unknown) => {
		captured = (typeof optionsOrListener === "function" ? optionsOrListener : listener) as fs.StatsListener
		return undefined as unknown as fs.StatWatcher
	}) as unknown as typeof fs.watchFile)
}

/** The most recently registered poll listener; throws if none was armed. */
export function pollListener(): fs.StatsListener {
	if (!captured) throw new Error("fs poller did not register a listener")
	return captured
}
