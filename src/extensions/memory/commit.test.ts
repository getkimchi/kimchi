import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type CaptureBackend,
	CapturedHashLedger,
	createCommitStoreView,
	normalizeFactText,
	recordCommittedFact,
} from "./commit.js"
import { createTraceRecorder } from "./trace.js"

function backend(facts: string[], calls: string[]): CaptureBackend {
	return {
		add: async () => undefined,
		delete: async () => undefined,
		getAll: async () => {
			calls.push("getAll")
			return { results: facts.map((memory, index) => ({ id: `m${index}`, memory })) }
		},
		search: async () => ({ results: [] }),
	}
}

describe("commit store view", () => {
	it("shares normalized texts and mutable dedupe state across jobs", async () => {
		const calls: string[] = []
		const view = await createCommitStoreView(backend([" A  durable     fact ", "another fact"], calls))
		expect(calls).toEqual(["getAll"])
		const normalized = normalizeFactText("a     durable fact")
		expect(normalizeFactText(" A durable fact")).toBe(normalized)
		expect(view.texts.has(normalized)).toBe(true)
		expect(view.rawTexts).toEqual([" A  durable     fact ", "another fact"])

		// Appending through the shared view makes an identical fact from a later
		// job visible without rereading the backend.
		view.texts.add("new fact")
		expect(view.texts.has("new fact")).toBe(true)
		expect(calls).toEqual(["getAll"])
		recordCommittedFact(view, "a later observation")
		expect(view.texts.has("a later observation")).toBe(true)
		expect(view.entries.at(-1)?.text).toBe("a later observation")
		expect(view.rawTexts.at(-1)).toBe("a later observation")
	})

	it("falls back to an empty view without blocking capture when a read fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const failing: CaptureBackend = {
				add: async () => undefined,
				delete: async () => undefined,
				getAll: async () => {
					throw new Error("store unavailable")
				},
				search: async () => ({ results: [] }),
			}
			const view = await createCommitStoreView(failing)
			expect(view.texts.size).toBe(0)
			expect(view.entries).toEqual([])
			expect(view.rawTexts).toEqual([])
		} finally {
			error.mockRestore()
		}
	})
})

describe("captured hash ledger", () => {
	const realHome = process.env.HOME
	let home: string

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kimchi-commit-ledger-"))
		process.env.HOME = home
	})
	afterEach(() => {
		process.env.HOME = realHome
		rmSync(home, { recursive: true, force: true })
	})

	it("merges on save and gives each write a unique temp path", () => {
		const dir = join(home, ".config", "kimchi", "memory")
		const path = join(dir, "captured-hashes.json")
		const first = new CapturedHashLedger(new Set(["one", "shared"]))
		first.mark(["two", "shared"])
		first.save()
		const second = new CapturedHashLedger(new Set(["three"]))
		second.mark(["shared"])
		second.save()
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(["three", "shared", "one", "two"])
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length).toBe(0)
	})

	it("does not create a ledger file when no new hashes commit", () => {
		const ledger = new CapturedHashLedger(new Set())
		ledger.mark([])
		ledger.save()
		expect(existsSync(join(home, ".config", "kimchi", "memory", "captured-hashes.json"))).toBe(false)
	})

	it("records ledger checkpoint timing without changing the merged hashes", async () => {
		const dir = join(home, ".config", "kimchi", "memory")
		const trace = createTraceRecorder()
		const ledger = new CapturedHashLedger(new Set(["one", "shared"]), trace)
		ledger.mark(["two", "shared"])
		ledger.save()
		const next = new CapturedHashLedger(new Set(["three"]), trace)
		next.mark(["shared"])
		next.save()
		expect(JSON.parse(readFileSync(join(dir, "captured-hashes.json"), "utf-8"))).toEqual([
			"three",
			"shared",
			"one",
			"two",
		])
		await trace?.flush?.()
		const events = readFileSync(join(dir, "traces", trace?.file.split("/").pop() ?? ""), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { kind?: string; status?: string; durationMs?: number; entries?: number })
		expect(events).toHaveLength(2)
		expect(events[0]).toMatchObject({
			kind: "ledger-save",
			status: "completed",
			durationMs: expect.any(Number),
			entries: 3,
		})
		expect(events[1]).toMatchObject({
			kind: "ledger-save",
			status: "completed",
			durationMs: expect.any(Number),
			entries: 4,
		})
	})
})
