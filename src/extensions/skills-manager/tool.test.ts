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

	it("accepts empty string for content in edit action", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		const result = await tool.execute("id", { action: "edit", name: "foo", content: "" })
		expect(manager.edit).toHaveBeenCalledWith("foo", "")
		expect(result.details.success).toBe(true)
	})

	it("accepts empty string for new_string in patch action", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		const result = await tool.execute("id", {
			action: "patch",
			name: "foo",
			old_string: "bar",
			new_string: "",
		})
		expect(manager.patch).toHaveBeenCalledWith("foo", "bar", "", undefined)
		expect(result.details.success).toBe(true)
	})

	it("rejects undefined required string fields but allows empty strings", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		// Missing `content` entirely → undefined → rejected
		const missing = await tool.execute("id", { action: "edit", name: "foo" })
		expect(missing.details.success).toBe(false)
		expect(missing.content[0].text).toContain("requires 'content'")
		// Empty `content` → allowed
		const empty = await tool.execute("id", { action: "edit", name: "foo", content: "" })
		expect(empty.details.success).toBe(true)
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

	it("returns error for unknown actions", async () => {
		const { manager, tracker } = makeMocks()
		const tool = createSkillManageTool(manager, tracker)
		const result = await tool.execute("id", { action: "frobnicate", name: "foo" })
		expect(result.details.success).toBe(false)
		expect((result.details as { error?: string }).error).toContain("Unknown action: 'frobnicate'")
	})
})

/**
 * Regression tests for the Anthropic `400 (no body)` bug.
 *
 * Background: The OpenAI Chat Completions → Anthropic Messages translation
 * performed by the LiteLLM gateway breaks on tool `parameters` schemas that
 * contain `anyOf` (or `oneOf`), particularly when combined with `const`
 * discriminators (which TypeBox emits for `Type.Literal()`). The original
 * `SkillManageSchema` was a `Type.Union([...8 discriminated objects...])`,
 * which rendered as top-level `anyOf` and triggered the 400.
 *
 * The fix flattened the schema to a single `Type.Object` with a plain string
 * `action` discriminator and all variant-specific fields as `Type.Optional`.
 *
 * These tests lock that shape in. If any of them fails, the schema has
 * regressed to a pattern that LiteLLM cannot translate to Anthropic, and
 * `skill_manage` will produce 400s on Anthropic-backed sessions.
 */
describe("SkillManageSchema (Anthropic via LiteLLM compat)", () => {
	const serialized = JSON.stringify(SkillManageSchema)

	it("must not contain anyOf — LiteLLM cannot translate it to Anthropic", () => {
		expect(serialized).not.toContain('"anyOf"')
	})

	it("must not contain oneOf — same translation failure mode as anyOf", () => {
		expect(serialized).not.toContain('"oneOf"')
	})

	it("must not use const discriminators — toxic in combination with anyOf", () => {
		// `Type.Literal("create")` → `{ "type": "string", "const": "create" }`.
		// Even without anyOf, providers (Google, Anthropic-via-LiteLLM) handle
		// `const` poorly. The fix replaces literal discriminators with a plain
		// string field whose description enumerates the valid values.
		expect(serialized).not.toContain('"const"')
	})

	it("is a flat top-level object", () => {
		// `parameters` must be a single `type: "object"` schema for the
		// Anthropic Messages API tool format. Type.Union(...) at the top
		// level renders as `anyOf` instead.
		const schema = SkillManageSchema as { type?: string }
		expect(schema.type).toBe("object")
	})

	it("declares `action` as a plain string discriminator (not a literal union)", () => {
		const schema = SkillManageSchema as {
			properties?: Record<string, { type?: string; const?: unknown }>
		}
		const action = schema.properties?.action
		expect(action).toBeDefined()
		expect(action?.type).toBe("string")
		// Guard against future "improvements" that re-introduce a literal enum
		// via Type.Literal / Type.Union of literals.
		expect(action?.const).toBeUndefined()
	})

	it("requires only `action` — every variant-specific field is optional", () => {
		// A flat object with all-optional siblings is the canonical
		// Anthropic-safe shape. Adding more required fields would force the
		// LLM to supply them for every action (most actions don't need them)
		// and is also the first step back toward a discriminated union.
		const schema = SkillManageSchema as { required?: string[] }
		expect(schema.required).toEqual(["action"])
	})

	it("exposes every field needed by the per-action handlers", () => {
		// If a handler in `execute()` references a field that the schema
		// doesn't declare, the LLM has no way to supply it. Keep this list
		// in sync with the switch statement in `createSkillManageTool`.
		const schema = SkillManageSchema as { properties?: Record<string, unknown> }
		const props = schema.properties ?? {}
		for (const field of [
			"action",
			"name",
			"content",
			"category",
			"old_string",
			"new_string",
			"file_path",
			"file_content",
			"absorbed_into",
			"pin",
		]) {
			expect(props, `missing property: ${field}`).toHaveProperty(field)
		}
	})
})
