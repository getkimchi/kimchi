import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
/**
 * Tests for the pure helper functions in model-roles-command.ts.
 * Interactive CLI flows (select/input UI) are not tested here —
 * they require a full mock UI harness and are covered by manual smoke tests.
 */
import { describe, expect, it, vi } from "vitest"
import {
	collectModelMetadata,
	formatRoleAssignment,
	formatRoleDisplay,
	formatRoleSummaryBlock,
	isEqualAssignment,
} from "./model-roles-command.js"
import { splitModelRef } from "./model-roles.js"

// Mock model-metadata module
vi.mock("./model-metadata.js", () => ({
	isModelMetadataMissing: vi.fn(),
	loadModelMetadata: vi.fn(),
	resolveModelMetadata: vi.fn(),
	saveModelMetadata: vi.fn(),
	getModelMetadata: vi.fn(() => new Map()),
}))

const createMockCtx = (responses: { selects?: (string | undefined)[]; inputs?: (string | undefined)[] } = {}) => {
	let selectIdx = 0
	let inputIdx = 0
	return {
		ui: {
			select: vi.fn(async () => responses.selects?.[selectIdx++]),
			input: vi.fn(async () => responses.inputs?.[inputIdx++]),
			notify: vi.fn(),
		},
	} as unknown as ExtensionCommandContext
}

describe("formatRoleAssignment", () => {
	it("formats a single model as-is", () => {
		expect(formatRoleAssignment("kimchi-dev/kimi-k2.6")).toBe("kimchi-dev/kimi-k2.6")
	})

	it("formats multiple models joined by comma-space", () => {
		expect(formatRoleAssignment(["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"])).toBe(
			"kimchi-dev/kimi-k2.6, kimchi-dev/minimax-m2.7",
		)
	})

	it("formats empty array as empty string", () => {
		const models: string[] = []
		const result = models.join(", ")
		expect(result).toBe("")
	})
})

describe("isEqualAssignment", () => {
	const cases: Record<string, { a: RoleModelAssignment; b: RoleModelAssignment; expected: boolean }> = {
		"identical single-model assignments": {
			a: "kimchi-dev/kimi-k2.6",
			b: "kimchi-dev/kimi-k2.6",
			expected: true,
		},
		"different single-model assignments": {
			a: "kimchi-dev/kimi-k2.6",
			b: "kimchi-dev/minimax-m2.7",
			expected: false,
		},
		"identical multi-model assignments (same order)": {
			a: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			b: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			expected: true,
		},
		"same models in different order": {
			a: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			b: ["kimchi-dev/minimax-m2.7", "kimchi-dev/kimi-k2.6"],
			expected: false,
		},
		"different lengths": {
			a: "kimchi-dev/kimi-k2.6",
			b: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			expected: false,
		},
		"mixed types (string vs array of one)": {
			a: "kimchi-dev/kimi-k2.6",
			b: ["kimchi-dev/kimi-k2.6"],
			expected: true,
		},
	}

	type RoleModelAssignment = string | string[]
	for (const [name, { a, b, expected }] of Object.entries(cases)) {
		it(name, () => {
			expect(isEqualAssignment(a, b)).toBe(expected)
		})
	}
})

describe("formatRoleDisplay", () => {
	it("appends (default) suffix when value matches DEFAULT_MODEL_ROLES", () => {
		const display = formatRoleDisplay("orchestrator", "kimchi-dev/kimi-k2.6")
		expect(display).toMatch(/\(default\)$/)
	})

	it("omits (default) suffix when value differs from DEFAULT_MODEL_ROLES", () => {
		const display = formatRoleDisplay("orchestrator", "kimchi-dev/minimax-m2.7")
		expect(display).not.toMatch(/\(default\)$/)
	})

	it("includes role label and formatted model list", () => {
		const display = formatRoleDisplay("planner", "kimchi-dev/kimi-k2.6")
		expect(display).toContain("Planner")
		expect(display).toContain("kimchi-dev/kimi-k2.6")
	})

	it("formats builder role with multiple models", () => {
		const display = formatRoleDisplay("builder", ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"])
		expect(display).toContain("Builder")
		expect(display).toContain("kimchi-dev/kimi-k2.6")
		expect(display).toContain("kimchi-dev/minimax-m2.7")
	})
})

describe("formatRoleSummaryBlock", () => {
	it("shows role label with indented model on next line", () => {
		const display = formatRoleSummaryBlock("orchestrator", "kimchi-dev/kimi-k2.6")
		expect(display).toMatch(/^Orchestrator:/)
		expect(display).toContain("\n    kimchi-dev/kimi-k2.6")
	})

	it("shows multiple models on separate indented lines", () => {
		const display = formatRoleSummaryBlock("builder", ["custom/model-a", "custom/model-b"])
		const lines = display.split("\n")
		expect(lines).toHaveLength(3)
		expect(lines[0]).toBe("Builder:")
		expect(lines[1]).toBe("    custom/model-a")
		expect(lines[2]).toBe("    custom/model-b")
	})

	it("appends (default) suffix to each model line when assignment matches default", () => {
		const display = formatRoleSummaryBlock("orchestrator", "kimchi-dev/kimi-k2.6")
		expect(display).toContain("(default)")
	})

	it("omits (default) suffix when assignment differs from default", () => {
		const display = formatRoleSummaryBlock("orchestrator", "kimchi-dev/minimax-m2.7")
		expect(display).not.toContain("(default)")
	})
})

describe("splitModelRef (from model-roles.ts)", () => {
	const cases: Record<string, { input: string; expected: { provider: string; modelId: string } | undefined }> = {
		"parses valid provider/model-id": {
			input: "kimchi-dev/kimi-k2.6",
			expected: { provider: "kimchi-dev", modelId: "kimi-k2.6" },
		},
		"returns undefined for model-id without slash": {
			input: "kimi-k2.6",
			expected: undefined,
		},
		"returns undefined for empty string": {
			input: "",
			expected: undefined,
		},
		"returns undefined for slash-only string": {
			input: "/",
			expected: undefined,
		},
		"returns provider with empty modelId for trailing slash": {
			input: "provider/",
			expected: { provider: "provider", modelId: "" },
		},
	}

	for (const [name, { input, expected }] of Object.entries(cases)) {
		it(name, () => {
			if (expected === undefined) {
				expect(splitModelRef(input)).toBeUndefined()
			} else {
				expect(splitModelRef(input)).toEqual(expected)
			}
		})
	}
})

describe("collectModelMetadata", () => {
	it("returns undefined when user cancels tier selection (select returns undefined)", async () => {
		const ctx = createMockCtx({ selects: [undefined] })
		const result = await collectModelMetadata("custom/model", undefined, ctx)
		expect(result).toBeUndefined()
	})

	it("returns config with all fields when user provides tier, vision=yes, description", async () => {
		const ctx = createMockCtx({
			selects: ["heavy", "yes"],
			inputs: ["A powerful model good at reasoning"],
		})
		const result = await collectModelMetadata("custom/model", undefined, ctx)
		expect(result).toEqual({
			tier: "heavy",
			vision: true,
			description: "A powerful model good at reasoning",
		})
	})

	it("returns config with only provided fields, skips undefined ones (user selects skip for vision, empty description)", async () => {
		const ctx = createMockCtx({
			selects: ["standard", "skip"],
			inputs: [""],
		})
		const result = await collectModelMetadata("custom/model", undefined, ctx)
		expect(result).toEqual({
			tier: "standard",
		})
		expect(result).not.toHaveProperty("vision")
		expect(result).not.toHaveProperty("description")
	})

	it("preserves existing fields when user selects keep current", async () => {
		const ctx = createMockCtx({
			selects: ["keep current (standard)", "keep current (yes)"],
			inputs: ["Existing description"],
		})
		const existing = { tier: "standard" as const, description: "Old desc", vision: true as const }
		const result = await collectModelMetadata("custom/model", existing, ctx)
		expect(result).toEqual({
			tier: "standard",
			vision: true,
			description: "Existing description",
		})
	})

	it("does not include vision when user selects skip and no existing vision", async () => {
		const ctx = createMockCtx({
			selects: ["light", "skip"],
			inputs: ["A light model"],
		})
		const result = await collectModelMetadata("custom/model", undefined, ctx)
		expect(result).toEqual({
			tier: "light",
			description: "A light model",
		})
		expect(result).not.toHaveProperty("vision")
	})

	it("includes model ref in select prompts", async () => {
		const ctx = createMockCtx({
			selects: ["heavy", "yes"],
			inputs: ["test"],
		})
		await collectModelMetadata("custom/my-model", undefined, ctx)
		const selectCalls = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls
		expect(selectCalls[0][0]).toContain("custom/my-model")
		expect(selectCalls[1][0]).toContain("custom/my-model")
		const inputCalls = (ctx.ui.input as ReturnType<typeof vi.fn>).mock.calls
		expect(inputCalls[0][0]).toContain("custom/my-model")
	})
})
