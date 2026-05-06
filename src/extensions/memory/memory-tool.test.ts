import { describe, expect, it, vi } from "vitest"
import type { MemoryStore } from "./memory-store.js"
import { createMemoryTool } from "./memory-tool.js"

describe("createMemoryTool", () => {
	it("returns a tool object with correct schema", () => {
		const mockStore = {
			add: vi.fn().mockResolvedValue({ success: true }),
			replace: vi.fn().mockResolvedValue({ success: true }),
			remove: vi.fn().mockResolvedValue({ success: true }),
			read: vi.fn().mockResolvedValue({ success: true }),
		} as unknown as MemoryStore
		const tool = createMemoryTool(mockStore)
		expect(tool.name).toBe("memory")
		expect(tool.description).toContain("Save durable information")
	})

	it("dispatches add action to store.add()", async () => {
		const mockStore = {
			add: vi.fn().mockResolvedValue({ success: true, message: "Added" }),
			replace: vi.fn(),
			remove: vi.fn(),
			read: vi.fn(),
		} as unknown as MemoryStore
		const tool = createMemoryTool(mockStore)
		const result = await tool.execute("tc1", { action: "add", target: "memory", content: "note" })
		expect(mockStore.add).toHaveBeenCalledWith("memory", "note")
		expect(result.details).toEqual({ success: true, message: "Added" })
		expect(result.content[0].text).toBe("Added")
	})

	it("dispatches replace action to store.replace()", async () => {
		const mockStore = {
			add: vi.fn(),
			replace: vi.fn().mockResolvedValue({ success: true }),
			remove: vi.fn(),
			read: vi.fn(),
		} as unknown as MemoryStore
		const tool = createMemoryTool(mockStore)
		await tool.execute("tc1", { action: "replace", target: "user", old_text: "old", content: "new" })
		expect(mockStore.replace).toHaveBeenCalledWith("user", "old", "new")
	})

	it("returns error for unknown action", async () => {
		const mockStore = {
			add: vi.fn(),
			replace: vi.fn(),
			remove: vi.fn(),
			read: vi.fn(),
		} as unknown as MemoryStore
		const tool = createMemoryTool(mockStore)
		const result = await tool.execute("tc1", { action: "invalid" as never, target: "memory" })
		expect(result.details.success).toBe(false)
	})
})
