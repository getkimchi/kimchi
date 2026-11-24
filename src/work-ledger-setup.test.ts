/**
 * Regression tests for tests/setup/work-ledger.ts: the vitest ledger mock must
 * load lazily (a suite that never imports the ledger never pulls its dependency
 * graph) and keep its seeded history and exports across vi.resetModules() — real
 * Bun subprocesses are unaffected. Ported from the deleted
 * pr-cost-reporting/ledger/node-test-*.test.ts when the ledger moved to
 * @getkimchi/kimchi-bridge (the setup stayed in Kimchi, so its coverage stays too).
 */
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backendFor, capture, readRecords } from "@getkimchi/kimchi-bridge/ledger"
import { beforeEach, expect, it, vi } from "vitest"

const agentDir = join(tmpdir(), "kimchi-node-unit-ledger-setup")
const WORK = "11111111-1111-4111-8111-111111111111"

const sdk = vi.hoisted(() => ({ loads: 0 }))

// An unrelated suite must not need the ledger's dependency graph merely to run.
vi.mock("@earendil-works/pi-coding-agent", () => {
	sdk.loads++
	throw new Error("This suite does not use the SDK or ledger")
})

// The fixed path predates the per-file isolated home; a leftover from an older run
// of this suite (or the deleted ledger copy) must not read as this run opening SQLite.
beforeEach(() => rmSync(agentDir, { recursive: true, force: true }))

it.each([1, 2])("does not import the ledger dependencies in an unrelated test (%i)", () => {
	expect(sdk.loads).toBe(0)
})

it.each([1, 2])("keeps seeded Node history across %i module resets without opening SQLite", async (resets) => {
	const backend = backendFor(agentDir)
	expect(backend.recordCount()).toBe(0)
	capture(agentDir, { version: 1, type: "work", workId: WORK, sessionId: "node-test" }, "node-test")
	for (let count = 0; count < resets; count++) {
		vi.resetModules()
		const reloaded = await import("@getkimchi/kimchi-bridge/ledger")
		expect(reloaded.backendFor(agentDir)).toBe(backend)
		expect(reloaded.readRecords(agentDir)).toEqual(readRecords(agentDir))
		expect(reloaded.readRecords(agentDir)).toHaveLength(1)
	}
	expect(existsSync(join(agentDir, "pr-cost-reporting", "ledger.db"))).toBe(false)
})
