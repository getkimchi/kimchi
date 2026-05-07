import { describe, expect, it, vi } from "vitest"
import { SkillManager } from "./skill-manager.js"
import { SkillManageSchema, createSkillManageTool } from "./tool.js"
import { UsageTracker } from "./usage.js"

describe("createSkillManageTool", () => {
	function makeMocks() {
		const manager = {
			create: vi.fn().mockResolvedValue({ success: true, message: "Created." }),
			edit: vi.fn().mockResolvedValue({ success: true, message: "Edited." }),
			patch: vi.fn().mockResolvedValue({ success: true, message: "Patched." }),
			delete: vi.fn().mockResolvedValue({ success: true, message: "Deleted." }),
			writeFile: vi.fn().mockResolvedValue({ success: true, message: "Wrote." }),
			removeFile: vi.fn().mockResolvedValue({ success: true, message: "Removed." }),
			listInventory: vi.fn().mockResolvedValue([
				{ name: "skill-a", path: "/skills/skill-a" },
				{ name: "skill-b", category: "ops", path: "/skills/ops/skill-b" },
			]),
		} as unknown as SkillManager
		const tracker = {
			bumpCreate: vi.fn().mockResolvedValue(undefined),
			bumpPatch: vi.fn().mockResolvedValue(undefined),
			archive: vi.fn().mockResolvedValue(undefined),
			setPin: vi.fn().mockResolvedValue(undefined),
		} as unknown as UsageTracker
		return { manager, tracker }
	}

	it("returns tool object with correct properties", () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		expect(tool.name).toBe("skill_manage")
		expect(tool.label).toBe("Skill Manager")
		expect(tool.parameters).toBe(SkillManageSchema)
		expect(typeof tool.execute).toBe("function")
	})

	it("dispatches create and bumps create", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		const result = await tool.execute("id", { action: "create", name: "foo", content: "body" })
		expect(manager.create).toHaveBeenCalledWith("foo", "body", undefined)
		expect(tracker.bumpCreate).toHaveBeenCalledWith("foo", false)
		expect(result.content[0].text).toBe("Created.")
		expect(result.details.success).toBe(true)
	})

	it("dispatches patch and bumps patch", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		await tool.execute("id", {
			action: "patch",
			name: "foo",
			old_string: "a",
			new_string: "b",
			file_path: "refs/x.md",
		})
		expect(manager.patch).toHaveBeenCalledWith("foo", "a", "b", "refs/x.md")
		expect(tracker.bumpPatch).toHaveBeenCalledWith("foo")
	})

	it("dispatches delete and archives", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		await tool.execute("id", { action: "delete", name: "foo", absorbed_into: "bar" })
		expect(manager.delete).toHaveBeenCalledWith("foo", "bar")
		expect(tracker.archive).toHaveBeenCalledWith("foo", "bar")
	})

	it("dispatches pin and sets pin", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		const result = await tool.execute("id", { action: "pin", name: "foo", pin: true })
		expect(tracker.setPin).toHaveBeenCalledWith("foo", true)
		expect(result.details.success).toBe(true)
	})

	it("dispatches list and returns inventory", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		const result = await tool.execute("id", { action: "list" })
		expect(manager.listInventory).toHaveBeenCalled()
		expect(result.details.success).toBe(true)
		const inventory = JSON.parse(result.content[0].text)
		expect(inventory).toHaveLength(2)
	})

	it("description includes inline creation guidance", () => {
		const manager = new SkillManager("/tmp")
		const tracker = new UsageTracker("/tmp")
		const tool = createSkillManageTool(manager, tracker)
		expect(tool.description).toContain("Create when: complex task succeeded")
		expect(tool.description).toContain("Update when: instructions stale")
		expect(tool.description).toContain("Confirm with user before creating")
	})

	it("returns error on exception", async () => {
		const { manager, tracker } = makeMocks()
		manager.create = vi.fn().mockRejectedValue(new Error("boom"))
		const tool = createSkillManageTool(manager, tracker)
		const result = await tool.execute("id", { action: "create", name: "foo", content: "body" })
		expect(result.details.success).toBe(false)
		expect((result.details as { error?: string }).error).toContain("boom")
	})
})
