import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { formatStats, getSessionMemoryStats, type SessionMemoryStats } from "./session-memory-stats.js"
import { getToolOutputStore, resetToolOutputStoreForTests } from "./tool-output-store.js"

describe("session-memory-stats", () => {
	beforeEach(() => {
		delete process.env.KIMCHI_TOOL_OUTPUT_STORE
		resetToolOutputStoreForTests()
	})
	afterEach(() => {
		delete process.env.KIMCHI_TOOL_OUTPUT_STORE
		resetToolOutputStoreForTests()
	})

	it("reports the enabled state with store stats", () => {
		const store = getToolOutputStore()
		expect(store).toBeDefined()
		const stats = getSessionMemoryStats()
		expect(stats.storeEnabled).toBe(true)
		expect(stats.mirrorFile).toBeDefined()
		expect(stats.mirrorBytes).toBe(0)
		expect(stats.cacheEntries).toBe(0)
		expect(stats.cacheBytes).toBe(0)
	})

	it("reports disabled when KIMCHI_TOOL_OUTPUT_STORE=off", () => {
		process.env.KIMCHI_TOOL_OUTPUT_STORE = "off"
		resetToolOutputStoreForTests()
		const stats = getSessionMemoryStats()
		expect(stats.storeEnabled).toBe(false)
	})

	it("formatStats renders the off message when disabled", () => {
		process.env.KIMCHI_TOOL_OUTPUT_STORE = "off"
		resetToolOutputStoreForTests()
		const text = formatStats(getSessionMemoryStats())
		expect(text).toContain("off")
		expect(text).toContain("KIMCHI_TOOL_OUTPUT_STORE=off")
	})

	it("formatStats renders store details when enabled", () => {
		const text = formatStats({
			storeEnabled: true,
			mirrorFile: "/tmp/fake.log",
			mirrorBytes: 1024,
			cacheEntries: 2,
			cacheBytes: 512,
		} satisfies SessionMemoryStats)
		expect(text).toContain("on")
		expect(text).toContain("1024")
		expect(text).toContain("512")
		expect(text).toContain("/tmp/fake.log")
	})
})
