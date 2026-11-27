import type * as Records from "@getkimchi/kimchi-bridge/ledger"
import { afterEach, beforeEach, vi } from "vitest"

const ledger = vi.hoisted(() => ({
	reset: undefined as (() => void) | undefined,
	close: undefined as (() => void) | undefined,
}))

// Only initialize when a test actually imports the ledger. Unrelated suites may use
// partial SDK/filesystem mocks that cannot load the ledger's dependency graph.
// Keep exports and state across vi.resetModules(); real Bun subprocesses are unaffected.
vi.mock("@getkimchi/kimchi-bridge/ledger", async (importOriginal) => {
	const records = await importOriginal<typeof Records>()
	const { createMemoryRecords } = await import("@getkimchi/kimchi-bridge/ledger")
	ledger.reset = () => {
		records.closeBackends()
		records.useBackendFactory(() => createMemoryRecords())
	}
	ledger.close = () => records.closeBackends()
	ledger.reset()
	return records
})

beforeEach(() => ledger.reset?.())
afterEach(() => ledger.close?.())
