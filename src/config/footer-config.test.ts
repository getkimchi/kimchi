import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_FOOTER_PINNED,
	FOOTER_ELEMENTS,
	_invalidateFooterConfigCache,
	isPinned,
	readFooterConfig,
	setPinned,
	writeFooterConfig,
} from "./footer-config.js"

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
	_invalidateFooterConfigCache()
})

afterEach(() => {
	vi.restoreAllMocks()
	memfs.clear()
})

// ── FOOTER_ELEMENTS metadata ──────────────────────────────────────────────────

describe("FOOTER_ELEMENTS", () => {
	it("has 9 entries", () => {
		expect(FOOTER_ELEMENTS).toHaveLength(9)
	})

	it("every entry has id, label, description", () => {
		for (const el of FOOTER_ELEMENTS) {
			expect(typeof el.id).toBe("string")
			expect(typeof el.label).toBe("string")
			expect(typeof el.description).toBe("string")
		}
	})

	it("covers all FooterElementId values", () => {
		const ids = FOOTER_ELEMENTS.map((e) => e.id).sort()
		const expected = ["permissions", "model", "ferment", "agents", "context", "usage", "phase", "tags", "team"].sort()
		expect(ids).toEqual(expected)
	})
})

// ─── readFooterConfig ─────────────────────────────────────────────────────────

describe("readFooterConfig", () => {
	it("returns DEFAULT_FOOTER_PINNED when no footer key exists in settings", () => {
		memfs.set(SETTINGS_PATH, "{}")
		expect(readFooterConfig().pinned).toEqual(DEFAULT_FOOTER_PINNED)
	})

	it("DEFAULT_FOOTER_PINNED contains agents, context, usage", () => {
		expect(DEFAULT_FOOTER_PINNED).toEqual(expect.arrayContaining(["agents", "context", "usage"]))
		expect(DEFAULT_FOOTER_PINNED).toHaveLength(3)
	})

	it("agents, context, usage are all isPinned=true on first read with no config", () => {
		for (const id of ["agents", "context", "usage"] as const) {
			expect(isPinned(id)).toBe(true)
		}
	})

	it("ferment, tags, team are not pinned by default even though context is", () => {
		expect(isPinned("context")).toBe(true)
		expect(isPinned("ferment")).toBe(false)
		expect(isPinned("tags")).toBe(false)
		expect(isPinned("team")).toBe(false)
	})

	it("returns { pinned: [] } when footer key exists with empty pinned array", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ footer: { pinned: [] } }, null, 2))
		expect(readFooterConfig().pinned).toEqual([])
	})

	it("returns { pinned: ['context'] } when config exists", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ footer: { pinned: ["context"] } }, null, 2))
		expect(readFooterConfig().pinned).toEqual(["context"])
	})

	it("ignores non-string items in the pinned array", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ footer: { pinned: ["context", 42, null, "model"] } }, null, 2))
		expect(readFooterConfig().pinned).toEqual(["context", "model"])
	})
})

// ─── writeFooterConfig ────────────────────────────────────────────────────────

describe("writeFooterConfig", () => {
	it("writes footer.pinned to disk", () => {
		writeFooterConfig({ pinned: ["model"] })
		const stored = JSON.parse(memfs.get(SETTINGS_PATH) ?? "{}")
		expect(stored.footer).toEqual({ pinned: ["model"] })
	})

	it("writing empty pinned keeps the key present so defaults do not re-apply on next read", () => {
		writeFooterConfig({ pinned: [] })
		_invalidateFooterConfigCache()
		expect(readFooterConfig().pinned).toEqual([])
	})

	it("merge-safety: does not clobber sibling top-level keys", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ modelRoles: { orchestrator: "kimi" }, other: "value" }, null, 2))
		writeFooterConfig({ pinned: ["permissions"] })
		const stored = JSON.parse(memfs.get(SETTINGS_PATH) ?? "{}")
		expect(stored.modelRoles).toEqual({ orchestrator: "kimi" })
		expect(stored.other).toBe("value")
		expect(stored.footer).toEqual({ pinned: ["permissions"] })
	})
})

// ─── setPinned / isPinned ─────────────────────────────────────────────────────

describe("setPinned", () => {
	beforeEach(() => {
		memfs.set(SETTINGS_PATH, "{}")
	})

	it("adds id to pinned array when pinned=true", () => {
		setPinned("context", true)
		expect(readFooterConfig().pinned).toContain("context")
	})

	it("removes id from pinned array when pinned=false", () => {
		memfs.set(SETTINGS_PATH, JSON.stringify({ footer: { pinned: ["model"] } }, null, 2))
		setPinned("model", false)
		expect(readFooterConfig().pinned).not.toContain("model")
	})

	it("is idempotent (adding twice does not duplicate)", () => {
		setPinned("permissions", true)
		setPinned("permissions", true)
		const pinned = readFooterConfig().pinned.filter((x) => x === "permissions")
		expect(pinned).toHaveLength(1)
	})
})

describe("isPinned", () => {
	beforeEach(() => {
		memfs.set(SETTINGS_PATH, "{}")
	})

	it("returns true for a pinned element", () => {
		setPinned("ferment", true)
		expect(isPinned("ferment")).toBe(true)
	})

	it("returns false for an element not in defaults", () => {
		expect(isPinned("ferment")).toBe(false)
	})

	it("returns false after element is unpinned", () => {
		setPinned("tags", true)
		expect(isPinned("tags")).toBe(true)
		setPinned("tags", false)
		expect(isPinned("tags")).toBe(false)
	})

	it("can toggle multiple elements independently", () => {
		setPinned("context", true)
		setPinned("model", true)
		setPinned("ferment", true)
		setPinned("model", false)
		const pinned = readFooterConfig().pinned
		expect(pinned).toEqual(expect.arrayContaining(["context", "ferment"]))
		expect(pinned).not.toContain("model")
	})
})
