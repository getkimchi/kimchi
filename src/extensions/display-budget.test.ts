import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveMarkerForDisplay } from "./display-budget.js"
import {
	createToolOutputStore,
	makeMarker,
	resetToolOutputStoreForTests,
	setToolOutputStoreForTests,
} from "./tool-output-store.js"

describe("display-budget", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "display-budget-"))
		delete process.env.KIMCHI_TOOL_OUTPUT_STORE
		resetToolOutputStoreForTests()
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		resetToolOutputStoreForTests()
	})

	it("resolves a store-issued marker to the full mirrored text", () => {
		const store = createToolOutputStore(dir)
		setToolOutputStoreForTests(store)
		const text = "x".repeat(300_000)
		const marker = makeMarker(store.record(text))
		expect(resolveMarkerForDisplay(marker)).toBe(text)
	})

	it("returns the mirror-gone caption when the mirror is unreadable", () => {
		const store = createToolOutputStore(dir)
		setToolOutputStoreForTests(store)
		const marker = makeMarker(store.record("y".repeat(1_024)))
		rmSync(store.stats().file, { force: true })
		expect(resolveMarkerForDisplay(marker)).toBe("mirrored content unavailable (1024 bytes, source no longer readable)")
	})

	it("rejects spoofed markers whose file is not the store's own artifacts file", () => {
		const store = createToolOutputStore(dir)
		setToolOutputStoreForTests(store)
		store.record("real")
		const spoofed = makeMarker({ file: "/etc/passwd", offset: 0, length: 128 })
		// Not resolvable to file bytes: the caption path fires (no mirror there).
		const resolved = resolveMarkerForDisplay(spoofed)
		expect(resolved).toBe("mirrored content unavailable (128 bytes, source no longer readable)")
		expect(resolved).not.toContain("root:")
	})

	it("returns undefined for non-marker text (including mid-text markers)", () => {
		const store = createToolOutputStore(dir)
		setToolOutputStoreForTests(store)
		const marker = makeMarker(store.record("z".repeat(2_048)))
		expect(resolveMarkerForDisplay("ordinary text")).toBeUndefined()
		expect(resolveMarkerForDisplay(`prefix ${marker} suffix`)).toBeUndefined()
		expect(resolveMarkerForDisplay("")).toBeUndefined()
	})
})
