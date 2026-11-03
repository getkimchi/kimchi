import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { backendFor, capture, readRecords } from "./records.js"

const agentDir = join(tmpdir(), "kimchi-node-unit-ledger-setup")
const WORK = "11111111-1111-4111-8111-111111111111"

it.each([1, 2])("keeps seeded Node history across %i module resets without opening SQLite", async (resets) => {
	const backend = backendFor(agentDir)
	expect(backend.recordCount()).toBe(0)
	capture(agentDir, { version: 1, type: "work", workId: WORK, sessionId: "node-test" }, "node-test")
	for (let count = 0; count < resets; count++) {
		vi.resetModules()
		const reloaded = await import("./records.js")
		expect(reloaded.backendFor(agentDir)).toBe(backend)
		expect(reloaded.readRecords(agentDir)).toEqual(readRecords(agentDir))
		expect(reloaded.readRecords(agentDir)).toHaveLength(1)
	}
	expect(existsSync(join(agentDir, "pr-cost-reporting", "ledger.db"))).toBe(false)
})
