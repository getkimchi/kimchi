import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { emptyState, inputsHash, parseState, type State, serializeState } from "./state.ts"

const state: State = {
	v: 1,
	digests: { "1.3.0..1.4.0": { from: "1.3.0", to: "1.4.0" } },
	lastRun: { baseline: "1.3.0", target: "1.4.0", inputsHash: "abc", at: "2026-10-27T00:00:00.000Z" },
}

describe("state marker", () => {
	it("round-trips through a plain marker", () => {
		const body = serializeState(state)
		expect(body).toContain("<!-- pi-upgrade-state: ")
		expect(parseState(`Some intro text\n\n${body}\n\ntrailer`)).toEqual(state)
	})

	it("round-trips through a gzip marker when the plain one exceeds the limit", () => {
		const big: State = { ...state, digests: { ...state.digests, pad: { text: "x".repeat(500) } } }
		const body = serializeState(big, 300)
		expect(body).toContain("<!-- pi-upgrade-state-gz: ")
		expect(body.length).toBeLessThanOrEqual(300)
		expect(parseState(body)).toEqual(big)
	})

	it("returns an empty state when no marker is present", () => {
		expect(parseState(undefined)).toEqual(emptyState())
		expect(parseState("just a comment")).toEqual(emptyState())
	})

	it("returns an empty state when the marker is corrupt", () => {
		expect(parseState("<!-- pi-upgrade-state: {not json -->")).toEqual(emptyState())
	})
})

describe("serializeState errors", () => {
	it("throws when even the gzip marker exceeds the limit", () => {
		expect(() => serializeState(state, 10)).toThrow(/exceeds/)
	})
})

describe("inputsHash", () => {
	it("changes when a patch file changes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-upgrade-state-"))
		onTestFinished(() => rmSync(root, { recursive: true, force: true }))
		mkdirSync(join(root, "patches"))
		writeFileSync(join(root, "patches", "a.patch"), "one")
		const before = inputsHash(root, "1.3.0", "1.4.0")
		expect(inputsHash(root, "1.3.0", "1.4.0")).toBe(before)
		writeFileSync(join(root, "patches", "a.patch"), "two")
		expect(inputsHash(root, "1.3.0", "1.4.0")).not.toBe(before)
		expect(inputsHash(root, "1.3.0", "1.5.0")).not.toBe(inputsHash(root, "1.3.0", "1.4.0"))
	})
})
