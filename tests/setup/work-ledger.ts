import { afterEach, beforeEach, vi } from "vitest"
import type * as Records from "../../src/extensions/pr-cost-reporting/ledger/records.js"

const ledger = vi.hoisted(() => ({
	reset: undefined as (() => void) | undefined,
	close: undefined as (() => void) | undefined,
}))

// Only initialize when a test actually imports the ledger. Unrelated suites may use
// partial SDK/filesystem mocks that cannot load the ledger's dependency graph.
// Keep exports and state across vi.resetModules(); real Bun subprocesses are unaffected.
vi.mock("../../src/extensions/pr-cost-reporting/ledger/records.js", async (importOriginal) => {
	const records = await importOriginal<typeof Records>()
	const { createMemoryRecords } = await import("../../src/extensions/pr-cost-reporting/ledger/memory-records.js")
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
