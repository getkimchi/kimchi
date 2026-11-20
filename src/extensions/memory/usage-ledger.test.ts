import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { recordUsage, type UsageRecord, usageLedgerPath } from "./usage-ledger.js"

// The ledger resolves its path from HOME (via defaultMemoryDir) — an
// isolated temp home keeps the suite off the developer's real ledger.
const realHome = process.env.HOME
let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "kimchi-usage-ledger-"))
	process.env.HOME = home
})

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME
	else process.env.HOME = realHome
	rmSync(home, { recursive: true, force: true })
})

/** Parse the ledger rows written so far in this test's temp home. */
function rows(): Array<UsageRecord & { ts?: string }> {
	return readFileSync(usageLedgerPath(), "utf-8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as UsageRecord & { ts?: string })
}

describe("usage ledger", () => {
	it("appends one JSONL row per call, newest last", () => {
		recordUsage({ kind: "extraction", model: "m", inputTokens: 10, outputTokens: 2 })
		recordUsage({ kind: "triage", model: "d3", inputTokens: 5, questions: 1 })
		const written = rows()
		expect(written).toHaveLength(2)
		expect(written[0]).toMatchObject({ kind: "extraction", model: "m", inputTokens: 10, outputTokens: 2 })
		expect(written[1]).toMatchObject({ kind: "triage", model: "d3", inputTokens: 5, questions: 1 })
		// Every row is timestamped.
		for (const row of written) {
			expect(typeof row.ts === "string" && !Number.isNaN(Date.parse(row.ts))).toBe(true)
		}
	})

	it("records failed rows (outage visibility — no token counts by construction)", () => {
		recordUsage({ kind: "supersede", model: "m", failed: true })
		expect(rows()[0]).toMatchObject({ kind: "supersede", model: "m", failed: true })
	})

	it("drops undefined count fields from the row (no null noise)", () => {
		recordUsage({ kind: "embedding", model: "bge-m3" })
		const raw = JSON.parse(readFileSync(usageLedgerPath(), "utf-8")) as {
			inputTokens?: number
			outputTokens?: number
		}
		expect(raw.inputTokens).toBeUndefined()
		expect(raw.outputTokens).toBeUndefined()
	})

	it("never throws when the ledger path is unwritable — warns once per streak, then recovers", () => {
		// A directory at the ledger path makes appendFileSync fail.
		mkdirSync(usageLedgerPath(), { recursive: true })
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			expect(() => recordUsage({ kind: "extraction" })).not.toThrow()
			expect(() => recordUsage({ kind: "extraction" })).not.toThrow()
			// Once per streak, not once per call.
			expect(consoleWarn).toHaveBeenCalledTimes(1)
		} finally {
			consoleWarn.mockRestore()
		}
		// A writable path again: recording resumes and a NEW failure warns
		// fresh (the streak reset).
		rmSync(usageLedgerPath(), { recursive: true, force: true })
		writeFileSync(usageLedgerPath(), "", "utf-8")
		expect(() => recordUsage({ kind: "extraction" })).not.toThrow()
		expect(rows()).toHaveLength(1)
	})
})
