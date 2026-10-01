import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	deriveDeprecationState,
	modelDeprecationsPath,
	pickReplacementSlug,
	readModelDeprecations,
	writeModelDeprecations,
} from "./model-deprecation.js"

// Fixed reference time: noon UTC. UTC-midnight truncation puts "today" at 2026-09-10T00:00:00Z.
const NOW = Date.parse("2026-09-10T12:00:00Z")

describe("pickReplacementSlug", () => {
	it("prefers the explicit replacement model", () => {
		expect(pickReplacementSlug({ replacement_model: "kimi-k3", alternatives: [{ slug: "kimi-k2.7" }] })).toBe("kimi-k3")
	})

	it("falls back to the first alternative in feed order", () => {
		expect(pickReplacementSlug({ alternatives: [{ slug: "kimi-k2.7" }, { slug: "kimi-k2.6" }] })).toBe("kimi-k2.7")
	})

	it("returns undefined when no replacement is recorded", () => {
		expect(pickReplacementSlug({ deprecated_at: "2026-09-20T00:00:00Z" })).toBeUndefined()
	})
})

describe("deriveDeprecationState", () => {
	it("returns none when no fields are set", () => {
		expect(deriveDeprecationState({}, NOW)).toBe("none")
	})

	it("returns announced when deprecated_at is in the future", () => {
		expect(deriveDeprecationState({ deprecated_at: "2026-09-29T00:00:00Z" }, NOW)).toBe("announced")
	})

	it("returns announced when deprecated_at is later the same day (UTC-midnight truncation)", () => {
		expect(deriveDeprecationState({ deprecated_at: "2026-09-11T00:00:00Z" }, NOW)).toBe("announced")
	})

	it("returns past when deprecated_at equals today's midnight (mirrors backend exclusion)", () => {
		expect(deriveDeprecationState({ deprecated_at: "2026-09-10T00:00:00Z" }, NOW)).toBe("past")
	})

	it("returns past when deprecated_at has passed", () => {
		expect(deriveDeprecationState({ deprecated_at: "2026-09-01T00:00:00Z" }, NOW)).toBe("past")
	})

	it("returns sunset when sunset_at has passed", () => {
		expect(deriveDeprecationState({ sunset_at: "2026-09-01T00:00:00Z" }, NOW)).toBe("sunset")
	})

	it("sunset supersedes deprecated states", () => {
		const info = {
			deprecated_at: "2026-09-29T00:00:00Z", // would be "announced" on its own
			sunset_at: "2026-09-01T00:00:00Z",
		}
		expect(deriveDeprecationState(info, NOW)).toBe("sunset")
	})

	it("future sunset_at does not affect state", () => {
		const info = {
			deprecated_at: "2026-09-29T00:00:00Z",
			sunset_at: "2027-01-01T00:00:00Z",
		}
		expect(deriveDeprecationState(info, NOW)).toBe("announced")
	})

	it("invalid dates fail open to none", () => {
		expect(deriveDeprecationState({ deprecated_at: "not-a-date" }, NOW)).toBe("none")
		expect(deriveDeprecationState({ deprecated_at: "2026-09-29T00:00:00Z", sunset_at: "junk" }, NOW)).toBe("announced")
	})
})

describe("model-deprecations sidecar", () => {
	let dir: string

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	function modelsJson(): string {
		dir = mkdtempSync(join(tmpdir(), "kimchi-deprecation-"))
		return join(dir, "models.json")
	}

	it("stores sidecar next to models.json", () => {
		const path = modelsJson()
		expect(modelDeprecationsPath(path)).toBe(join(dir, "model-deprecations.json"))
	})

	it("reads empty map when file is absent or corrupt", () => {
		const path = modelsJson()
		expect(readModelDeprecations(path).size).toBe(0)
		mkdirSync(dir, { recursive: true })
		writeFileSync(modelDeprecationsPath(path), "{not json", "utf-8")
		expect(readModelDeprecations(path).size).toBe(0)
	})

	it("round-trips records keyed by slug", () => {
		const path = modelsJson()
		writeModelDeprecations(path, [
			{ slug: "kimi-k2.7", deprecated_at: "2026-09-29T00:00:00Z", replacement_model: "kimi-k3" },
		])
		const read = readModelDeprecations(path)
		expect(read.size).toBe(1)
		expect(read.get("kimi-k2.7")).toEqual({
			deprecated_at: "2026-09-29T00:00:00Z",
			replacement_model: "kimi-k3",
		})
		const onDisk = JSON.parse(readFileSync(modelDeprecationsPath(path), "utf-8"))
		expect(onDisk["kimi-k2.7"].replacement_model).toBe("kimi-k3")
	})

	it("drops models with no deprecation fields", () => {
		const path = modelsJson()
		writeModelDeprecations(path, [{ slug: "kimi-k3" }, { slug: "glm-5.3", deprecation_note: "https://x" }])
		const read = readModelDeprecations(path)
		expect(read.has("kimi-k3")).toBe(false)
		expect(read.size).toBe(1)
	})

	it("union-merges: entries for models absent from a later write are preserved", () => {
		const path = modelsJson()
		writeModelDeprecations(path, [{ slug: "kimi-k2.7", replacement_model: "kimi-k3" }])
		// A later fetch no longer lists kimi-k2.7 (backend excludes it), but its
		// replacement info must survive for role remapping.
		writeModelDeprecations(path, [{ slug: "glm-5.3", deprecated_at: "2027-01-01T00:00:00Z" }])
		const read = readModelDeprecations(path)
		expect(read.get("kimi-k2.7")?.replacement_model).toBe("kimi-k3")
		expect(read.get("glm-5.3")?.deprecated_at).toBe("2027-01-01T00:00:00Z")
	})

	it("fresh data overwrites previous fields", () => {
		const path = modelsJson()
		writeModelDeprecations(path, [
			{ slug: "kimi-k2.7", deprecated_at: "2026-09-29T00:00:00Z", replacement_model: "kimi-k3" },
		])
		writeModelDeprecations(path, [{ slug: "kimi-k2.7", deprecated_at: "2026-10-15T00:00:00Z" }])
		const read = readModelDeprecations(path)
		expect(read.get("kimi-k2.7")).toEqual({ deprecated_at: "2026-10-15T00:00:00Z" })
	})
})
