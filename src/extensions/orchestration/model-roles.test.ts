import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	DEFAULT_MODEL_ROLES,
	type ModelRoles,
	modelIdFromRef,
	parseModelRoles,
	resetModelRolesCache,
	saveModelRoles,
	splitModelRef,
	validateModelRoles,
} from "./model-roles.js"

afterEach(() => {
	resetModelRolesCache()
})

describe("parseModelRoles", () => {
	it("returns defaults when raw is undefined", () => {
		const { roles, warnings } = parseModelRoles(undefined)
		expect(roles).toEqual(DEFAULT_MODEL_ROLES)
		expect(warnings).toHaveLength(0)
	})

	it("returns defaults when raw is null", () => {
		const { roles, warnings } = parseModelRoles(null)
		expect(roles).toEqual(DEFAULT_MODEL_ROLES)
		expect(warnings).toHaveLength(0)
	})

	it("returns defaults when raw is not an object", () => {
		const { roles, warnings } = parseModelRoles("not-an-object")
		expect(roles).toEqual(DEFAULT_MODEL_ROLES)
		expect(warnings).toHaveLength(0)
	})

	it("returns defaults when raw is an empty object", () => {
		const { roles, warnings } = parseModelRoles({})
		expect(roles).toEqual(DEFAULT_MODEL_ROLES)
		expect(warnings).toHaveLength(0)
	})

	it("overrides individual roles", () => {
		const { roles } = parseModelRoles({
			builder: "anthropic/claude-sonnet-4-5",
		})
		expect(roles.orchestrator).toBe(DEFAULT_MODEL_ROLES.orchestrator)
		expect(roles.builder).toBe("anthropic/claude-sonnet-4-5")
		expect(roles.reviewer).toBe(DEFAULT_MODEL_ROLES.reviewer)
	})

	it("overrides all roles", () => {
		const custom: ModelRoles = {
			orchestrator: "anthropic/claude-opus-4-7",
			planner: "anthropic/claude-sonnet-4-5",
			builder: "anthropic/claude-sonnet-4-5",
			reviewer: "openai/gpt-4o",
			explorer: "kimchi-dev/nemotron-3-super-fp4",
			judge: "kimchi-dev/claude-opus-4-6",
		}
		const { roles } = parseModelRoles(custom)
		expect(roles).toEqual(custom)
	})

	it("warns on non-string role values", () => {
		const { roles, warnings } = parseModelRoles({
			builder: 42,
		})
		expect(roles.builder).toBe(DEFAULT_MODEL_ROLES.builder)
		expect(warnings).toHaveLength(1)
		expect(warnings[0].role).toBe("builder")
		expect(warnings[0].message).toContain("non-empty string")
	})

	it("warns on empty-string role values", () => {
		const { roles, warnings } = parseModelRoles({
			orchestrator: "",
		})
		expect(roles.orchestrator).toBe(DEFAULT_MODEL_ROLES.orchestrator)
		expect(warnings).toHaveLength(1)
		expect(warnings[0].role).toBe("orchestrator")
	})

	it("warns on whitespace-only role values", () => {
		const { roles, warnings } = parseModelRoles({
			reviewer: "   ",
		})
		expect(roles.reviewer).toBe(DEFAULT_MODEL_ROLES.reviewer)
		expect(warnings).toHaveLength(1)
	})

	it("trims whitespace from valid values", () => {
		const { roles } = parseModelRoles({
			builder: "  anthropic/claude-sonnet-4-5  ",
		})
		expect(roles.builder).toBe("anthropic/claude-sonnet-4-5")
	})

	it("ignores unknown keys", () => {
		const { roles, warnings } = parseModelRoles({
			orchestrator: "kimchi-dev/kimi-k2.6",
			unknownRole: "some/model",
		})
		expect(roles.orchestrator).toBe("kimchi-dev/kimi-k2.6")
		expect(warnings).toHaveLength(0)
	})

	it("ignores array input", () => {
		const { roles } = parseModelRoles(["not", "valid"])
		expect(roles).toEqual(DEFAULT_MODEL_ROLES)
	})

	it("handles mixed valid and invalid roles", () => {
		const { roles, warnings } = parseModelRoles({
			orchestrator: "anthropic/claude-opus-4-7",
			planner: "anthropic/claude-sonnet-4-5",
			builder: null,
			reviewer: 123,
			explorer: "kimchi-dev/nemotron-3-super-fp4",
		})
		expect(roles.orchestrator).toBe("anthropic/claude-opus-4-7")
		expect(roles.planner).toBe("anthropic/claude-sonnet-4-5")
		expect(roles.builder).toBe(DEFAULT_MODEL_ROLES.builder)
		expect(roles.reviewer).toBe(DEFAULT_MODEL_ROLES.reviewer)
		expect(roles.explorer).toBe("kimchi-dev/nemotron-3-super-fp4")
		// null is skipped silently, number warns
		expect(warnings).toHaveLength(1)
		expect(warnings[0].role).toBe("reviewer")
	})
})

describe("splitModelRef", () => {
	it("splits a valid provider/model-id string", () => {
		expect(splitModelRef("kimchi-dev/kimi-k2.6")).toEqual({
			provider: "kimchi-dev",
			modelId: "kimi-k2.6",
		})
	})

	it("splits a provider with nested path", () => {
		expect(splitModelRef("anthropic/claude-sonnet-4-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		})
	})

	it("returns undefined for string without slash", () => {
		expect(splitModelRef("kimi-k2.6")).toBeUndefined()
	})

	it("returns undefined for string starting with slash", () => {
		expect(splitModelRef("/kimi-k2.6")).toBeUndefined()
	})

	it("returns undefined for empty string", () => {
		expect(splitModelRef("")).toBeUndefined()
	})
})

describe("modelIdFromRef", () => {
	it("extracts model ID from provider/model-id", () => {
		expect(modelIdFromRef("kimchi-dev/kimi-k2.6")).toBe("kimi-k2.6")
	})

	it("returns full string when no slash", () => {
		expect(modelIdFromRef("kimi-k2.6")).toBe("kimi-k2.6")
	})

	it("handles multiple slashes — takes everything after the first", () => {
		expect(modelIdFromRef("provider/model/variant")).toBe("model/variant")
	})
})

describe("DEFAULT_MODEL_ROLES", () => {
	it("defaults to kimchi-dev OSS models", () => {
		expect(DEFAULT_MODEL_ROLES.orchestrator).toBe("kimchi-dev/kimi-k2.6")
		expect(DEFAULT_MODEL_ROLES.planner).toBe("kimchi-dev/kimi-k2.6")
		expect(DEFAULT_MODEL_ROLES.builder).toBe("kimchi-dev/minimax-m2.7")
		expect(DEFAULT_MODEL_ROLES.reviewer).toBe("kimchi-dev/minimax-m2.7")
		expect(DEFAULT_MODEL_ROLES.explorer).toBe("kimchi-dev/nemotron-3-super-fp4")
		expect(DEFAULT_MODEL_ROLES.judge).toBe("kimchi-dev/kimi-k2.6")
	})

	it("all defaults contain a provider prefix", () => {
		for (const ref of Object.values(DEFAULT_MODEL_ROLES)) {
			expect(splitModelRef(ref)).toBeDefined()
		}
	})
})

describe("saveModelRoles", () => {
	const testDir = join(tmpdir(), `kimchi-model-roles-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("creates the settings file and directory if absent", () => {
		const roles: ModelRoles = { ...DEFAULT_MODEL_ROLES, builder: "anthropic/claude-sonnet-4-5" }
		saveModelRoles(roles, testPath)
		expect(existsSync(testPath)).toBe(true)
		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelRoles.builder).toBe("anthropic/claude-sonnet-4-5")
	})

	it("only writes non-default values", () => {
		const roles: ModelRoles = { ...DEFAULT_MODEL_ROLES, reviewer: "openai/gpt-4o" }
		saveModelRoles(roles, testPath)
		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelRoles).toEqual({ reviewer: "openai/gpt-4o" })
		expect(saved.modelRoles.orchestrator).toBeUndefined()
		expect(saved.modelRoles.builder).toBeUndefined()
	})

	it("removes modelRoles key when all values are defaults", () => {
		// First save a non-default
		saveModelRoles({ ...DEFAULT_MODEL_ROLES, builder: "anthropic/claude-sonnet-4-5" }, testPath)
		// Then save all defaults
		saveModelRoles({ ...DEFAULT_MODEL_ROLES }, testPath)
		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelRoles).toBeUndefined()
	})

	it("preserves other settings in the file", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(testPath, JSON.stringify({ multiModel: true, theme: "dark" }, null, 2))
		saveModelRoles({ ...DEFAULT_MODEL_ROLES, orchestrator: "anthropic/claude-opus-4-7" }, testPath)
		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.multiModel).toBe(true)
		expect(saved.theme).toBe("dark")
		expect(saved.modelRoles.orchestrator).toBe("anthropic/claude-opus-4-7")
	})
})

describe("validateModelRoles", () => {
	const available = new Set(["kimi-k2.6", "minimax-m2.7", "nemotron-3-super-fp4"])

	it("returns no unavailable roles when all defaults are available", () => {
		const result = validateModelRoles(DEFAULT_MODEL_ROLES, available)
		expect(result.unavailable).toHaveLength(0)
	})

	it("flags a role whose model is not available", () => {
		const roles: ModelRoles = {
			...DEFAULT_MODEL_ROLES,
			builder: "anthropic/claude-sonnet-4-5",
		}
		const result = validateModelRoles(roles, available)
		expect(result.unavailable).toHaveLength(1)
		expect(result.unavailable[0].role).toBe("builder")
		expect(result.unavailable[0].configuredModel).toBe("anthropic/claude-sonnet-4-5")
	})

	it("flags multiple unavailable roles", () => {
		const roles: ModelRoles = {
			orchestrator: "openai/gpt-4o",
			planner: "openai/gpt-4o",
			builder: "anthropic/claude-sonnet-4-5",
			reviewer: "kimchi-dev/minimax-m2.7",
			explorer: "google/gemini-pro",
			judge: "kimchi-dev/kimi-k2.6",
		}
		const result = validateModelRoles(roles, available)
		expect(result.unavailable).toHaveLength(4)
		const flaggedRoles = result.unavailable.map((u) => u.role)
		expect(flaggedRoles).toContain("orchestrator")
		expect(flaggedRoles).toContain("planner")
		expect(flaggedRoles).toContain("builder")
		expect(flaggedRoles).toContain("explorer")
		expect(flaggedRoles).not.toContain("reviewer")
	})

	it("strips provider prefix when checking availability", () => {
		const roles: ModelRoles = {
			...DEFAULT_MODEL_ROLES,
			builder: "custom-provider/minimax-m2.7",
		}
		// minimax-m2.7 is in the available set regardless of provider prefix
		const result = validateModelRoles(roles, available)
		expect(result.unavailable).toHaveLength(0)
	})

	it("handles empty available set", () => {
		const result = validateModelRoles(DEFAULT_MODEL_ROLES, new Set())
		expect(result.unavailable).toHaveLength(6)
	})
})
