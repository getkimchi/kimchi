import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_invalidateStatusLineConfigCache,
	DEFAULT_STATUS_LINE_PINNED,
	isStatusLineElementPinned,
	readStatusLineConfig,
	STATUS_LINE_ELEMENTS,
	setStatusLineElementPinned,
	writeStatusLineConfig,
} from "./status-line-config.js"

// ── Real-cache mock of ./json.js (mirrors src/config/settings.test.ts) ───────
// All json.js reads/writes are remapped onto a per-process temp settings
// file so these tests run against the REAL stat-gated cache. A bare
// `...original` spread would NOT work: the original readJsonCached internally
// binds the original readJson, which would read the real user settings file
// instead of the temp path.
const testDir = join(tmpdir(), `kimchi-statusline-test-${process.pid}`)
const testPath = join(testDir, "settings.json")

vi.mock("./json.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./json.js")>()
	return {
		...original,
		readJson: (_path: string) => original.readJson(testPath),
		readJsonCached: (_path: string) => original.readJsonCached(testPath),
		writeJson: (_path: string, data: unknown) => original.writeJson(testPath, data),
		invalidateJsonCache: (_path: string) => original.invalidateJsonCache(testPath),
	}
})

/** Seed the temp settings file with raw JSON text. */
function seed(raw: string): void {
	writeFileSync(testPath, raw, "utf-8")
}

beforeEach(() => {
	rmSync(testDir, { recursive: true, force: true })
	mkdirSync(testDir, { recursive: true })
	seed("{}")
	_invalidateStatusLineConfigCache()
})

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true })
	vi.restoreAllMocks()
})

// ── STATUS_LINE_ELEMENTS metadata ────────────────────────────────────────────

describe("STATUS_LINE_ELEMENTS", () => {
	it("has 12 entries", () => {
		expect(STATUS_LINE_ELEMENTS).toHaveLength(12)
	})

	it("every entry has id, label, description", () => {
		for (const el of STATUS_LINE_ELEMENTS) {
			expect(typeof el.id).toBe("string")
			expect(typeof el.label).toBe("string")
			expect(typeof el.description).toBe("string")
		}
	})

	it("covers all StatusLineElementId values", () => {
		const ids = STATUS_LINE_ELEMENTS.map((e) => e.id).sort()
		const expected = [
			"permissions",
			"model",
			"thinking",
			"ferment",
			"agents",
			"context",
			"usage",
			"phase",
			"tags",
			"team",
			"credits",
			"budget",
		].sort()
		expect(ids).toEqual(expected)
	})
})

// ─── readStatusLineConfig ────────────────────────────────────────────────────

describe("readStatusLineConfig", () => {
	it("returns DEFAULT_STATUS_LINE_PINNED when no statusLine key exists in settings", () => {
		seed("{}")
		expect(readStatusLineConfig().pinned).toEqual(DEFAULT_STATUS_LINE_PINNED)
	})

	it("DEFAULT_STATUS_LINE_PINNED contains thinking, agents, context, usage", () => {
		expect(DEFAULT_STATUS_LINE_PINNED).toEqual(expect.arrayContaining(["thinking", "agents", "context", "usage"]))
		expect(DEFAULT_STATUS_LINE_PINNED).toHaveLength(4)
	})

	it("thinking, agents, context, usage are all isStatusLineElementPinned=true on first read with no config", () => {
		for (const id of ["thinking", "agents", "context", "usage"] as const) {
			expect(isStatusLineElementPinned(id)).toBe(true)
		}
	})

	it("ferment, tags, team are not pinned by default even though context is", () => {
		expect(isStatusLineElementPinned("context")).toBe(true)
		expect(isStatusLineElementPinned("ferment")).toBe(false)
		expect(isStatusLineElementPinned("tags")).toBe(false)
		expect(isStatusLineElementPinned("team")).toBe(false)
	})

	it("returns { pinned: [] } when statusLine key exists with empty pinned array", () => {
		seed(JSON.stringify({ statusLine: { pinned: [] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual([])
	})

	it("returns { pinned: ['context'] } when config exists", () => {
		seed(JSON.stringify({ statusLine: { pinned: ["context"] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual(["context"])
	})

	it("migrates the legacy billing toggle to credits and budget", () => {
		seed(JSON.stringify({ statusLine: { pinned: ["billing"] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual(["credits", "budget"])
	})

	it("ignores non-string items in the pinned array", () => {
		seed(JSON.stringify({ statusLine: { pinned: ["context", 42, null, "model"] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual(["context", "model"])
	})
})

// ─── writeStatusLineConfig ───────────────────────────────────────────────────

describe("writeStatusLineConfig", () => {
	it("writes statusLine.pinned to disk", () => {
		writeStatusLineConfig({ pinned: ["model"] })
		const stored = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(stored.statusLine).toEqual({ pinned: ["model"] })
	})

	it("writing empty pinned keeps the key present so defaults do not re-apply on next read", () => {
		writeStatusLineConfig({ pinned: [] })
		_invalidateStatusLineConfigCache()
		expect(readStatusLineConfig().pinned).toEqual([])
	})

	it("merge-safety: does not clobber sibling top-level keys", () => {
		seed(JSON.stringify({ modelRoles: { orchestrator: "kimi" }, other: "value" }, null, 2))
		writeStatusLineConfig({ pinned: ["permissions"] })
		const stored = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(stored.modelRoles).toEqual({ orchestrator: "kimi" })
		expect(stored.other).toBe("value")
		expect(stored.statusLine).toEqual({ pinned: ["permissions"] })
	})
})

// ─── setStatusLineElementPinned / isStatusLineElementPinned ─────────────────

describe("setStatusLineElementPinned", () => {
	beforeEach(() => {
		seed("{}")
	})

	it("adds id to pinned array when pinned=true", () => {
		setStatusLineElementPinned("context", true)
		expect(readStatusLineConfig().pinned).toContain("context")
	})

	it("removes id from pinned array when pinned=false", () => {
		seed(JSON.stringify({ statusLine: { pinned: ["model"] } }, null, 2))
		setStatusLineElementPinned("model", false)
		expect(readStatusLineConfig().pinned).not.toContain("model")
	})

	it("is idempotent (adding twice does not duplicate)", () => {
		setStatusLineElementPinned("permissions", true)
		setStatusLineElementPinned("permissions", true)
		const pinned = readStatusLineConfig().pinned.filter((x) => x === "permissions")
		expect(pinned).toHaveLength(1)
	})
})

describe("isStatusLineElementPinned", () => {
	beforeEach(() => {
		seed("{}")
	})

	it("returns true for a pinned element", () => {
		setStatusLineElementPinned("ferment", true)
		expect(isStatusLineElementPinned("ferment")).toBe(true)
	})

	it("returns false for an element not in defaults", () => {
		expect(isStatusLineElementPinned("ferment")).toBe(false)
	})

	it("returns false after element is unpinned", () => {
		setStatusLineElementPinned("tags", true)
		expect(isStatusLineElementPinned("tags")).toBe(true)
		setStatusLineElementPinned("tags", false)
		expect(isStatusLineElementPinned("tags")).toBe(false)
	})

	it("can toggle multiple elements independently", () => {
		setStatusLineElementPinned("context", true)
		setStatusLineElementPinned("model", true)
		setStatusLineElementPinned("ferment", true)
		setStatusLineElementPinned("model", false)
		const pinned = readStatusLineConfig().pinned
		expect(pinned).toEqual(expect.arrayContaining(["context", "ferment"]))
		expect(pinned).not.toContain("model")
	})
})

// ─── stat-gated cache integration ────────────────────────────────────────────
// These exercise the real readJsonCached/invalidateJsonCache on the temp
// settings path — the behaviors the module gained with the stat gate.

describe("readStatusLineConfig (stat cache)", () => {
	it("picks up an external write to the settings file without explicit invalidation", () => {
		seed(JSON.stringify({ statusLine: { pinned: ["context"] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual(["context"])
		// Simulate another process editing the file: plain writeFileSync,
		// NOT our writeJson — only the mtime/size stat gate can catch it.
		writeFileSync(testPath, JSON.stringify({ statusLine: { pinned: ["ferment", "usage"] } }), "utf-8")
		expect(readStatusLineConfig().pinned).toEqual(["ferment", "usage"])
	})

	it("writeStatusLineConfig is visible to the next read without explicit invalidation", () => {
		seed("{}")
		expect(readStatusLineConfig().pinned).toEqual(DEFAULT_STATUS_LINE_PINNED)
		writeStatusLineConfig({ pinned: ["phase"] })
		expect(readStatusLineConfig().pinned).toEqual(["phase"])
	})
})
