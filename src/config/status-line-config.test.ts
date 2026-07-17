import { homedir } from "node:os"
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

// ── memfs-backed mock of ./json.js ───────────────────────────────────────────
// The mock factory computes the settings path at call time (after vi.mock hoisting).
const memfs: Map<string, string> = new Map()

vi.mock("./json.js", () => ({
	readJson: (path: string) => {
		const raw = memfs.get(path)
		if (!raw) return {}
		try {
			return JSON.parse(raw)
		} catch {
			return {}
		}
	},
	writeJson: (path: string, data: unknown) => {
		memfs.set(path, `${JSON.stringify(data, null, 2)}\n`)
	},
}))

const SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

beforeEach(() => {
	memfs.clear()
	memfs.set(SETTINGS_PATH, "{}")
	_invalidateStatusLineConfigCache()
})

afterEach(() => {
	vi.restoreAllMocks()
	memfs.clear()
})

// ── STATUS_LINE_ELEMENTS metadata ────────────────────────────────────────────

describe("STATUS_LINE_ELEMENTS", () => {
	it("has 10 entries", () => {
		expect(STATUS_LINE_ELEMENTS).toHaveLength(10)
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
			"ferment",
			"agents",
			"context",
			"usage",
			"phase",
			"tags",
			"team",
			"billing",
		].sort()
		expect(ids).toEqual(expected)
	})
})

// ─── readStatusLineConfig ────────────────────────────────────────────────────

describe("readStatusLineConfig", () => {
	it("returns DEFAULT_STATUS_LINE_PINNED when no statusLine key exists in settings", () => {
		memfs.set(SETTINGS_PATH, "{}")
		expect(readStatusLineConfig().pinned).toEqual(DEFAULT_STATUS_LINE_PINNED)
	})

	it("DEFAULT_STATUS_LINE_PINNED contains agents, context, usage", () => {
		expect(DEFAULT_STATUS_LINE_PINNED).toEqual(expect.arrayContaining(["agents", "context", "usage"]))
		expect(DEFAULT_STATUS_LINE_PINNED).toHaveLength(3)
	})

	it("agents, context, usage are all isStatusLineElementPinned=true on first read with no config", () => {
		for (const id of ["agents", "context", "usage"] as const) {
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
		memfs.set(SETTINGS_PATH, JSON.stringify({ statusLine: { pinned: [] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual([])
	})

	it("returns { pinned: ['context'] } when config exists", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ statusLine: { pinned: ["context"] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual(["context"])
	})

	it("keeps billing when pinned in config", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ statusLine: { pinned: ["billing"] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual(["billing"])
	})

	it("ignores non-string items in the pinned array", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ statusLine: { pinned: ["context", 42, null, "model"] } }, null, 2))
		expect(readStatusLineConfig().pinned).toEqual(["context", "model"])
	})
})

// ─── writeStatusLineConfig ───────────────────────────────────────────────────

describe("writeStatusLineConfig", () => {
	it("writes statusLine.pinned to disk", () => {
		writeStatusLineConfig({ pinned: ["model"] })
		const stored = JSON.parse(memfs.get(SETTINGS_PATH) ?? "{}")
		expect(stored.statusLine).toEqual({ pinned: ["model"] })
	})

	it("writing empty pinned keeps the key present so defaults do not re-apply on next read", () => {
		writeStatusLineConfig({ pinned: [] })
		_invalidateStatusLineConfigCache()
		expect(readStatusLineConfig().pinned).toEqual([])
	})

	it("merge-safety: does not clobber sibling top-level keys", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ modelRoles: { orchestrator: "kimi" }, other: "value" }, null, 2))
		writeStatusLineConfig({ pinned: ["permissions"] })
		const stored = JSON.parse(memfs.get(SETTINGS_PATH) ?? "{}")
		expect(stored.modelRoles).toEqual({ orchestrator: "kimi" })
		expect(stored.other).toBe("value")
		expect(stored.statusLine).toEqual({ pinned: ["permissions"] })
	})
})

// ─── setStatusLineElementPinned / isStatusLineElementPinned ─────────────────

describe("setStatusLineElementPinned", () => {
	beforeEach(() => {
		memfs.set(SETTINGS_PATH, "{}")
	})

	it("adds id to pinned array when pinned=true", () => {
		setStatusLineElementPinned("context", true)
		expect(readStatusLineConfig().pinned).toContain("context")
	})

	it("removes id from pinned array when pinned=false", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ statusLine: { pinned: ["model"] } }, null, 2))
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
		memfs.set(SETTINGS_PATH, "{}")
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
