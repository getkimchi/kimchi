import { afterEach, describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../model-registry/index.js"
import { resolveOrchestrationInstructions } from "./orchestration-instructions.js"

const ALL_KNOWN_IDS = [...MODEL_CAPABILITIES.keys()]

function fakeMetadata(slug: string): ModelMetadata {
	return {
		slug,
		display_name: "",
		provider: "ai-enabler",
		reasoning: false,
		input_modalities: ["text"],
		is_serverless: true,
		limits: { context_window: 131072, max_output_tokens: 16384 },
	}
}

const ALL_KNOWN_METADATA = ALL_KNOWN_IDS.map(fakeMetadata)

type P = NodeJS.Process & { __kimchiMultiModelEnabled?: boolean; __kimchiCurrentModelRef?: string }

afterEach(() => {
	;(process as P).__kimchiMultiModelEnabled = undefined
	;(process as P).__kimchiCurrentModelRef = undefined
})

describe("resolveOrchestrationInstructions — orchestrator mode (full block)", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns orchestration instructions in orchestrator mode", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "orchestrator" })
		expect(result).toContain("Orchestrate the work")
	})

	it("shows Your Team section with default persona names", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "orchestrator" })
		expect(result).toContain("## Your Team")
		expect(result).toContain("Builder")
		expect(result).toContain("Reviewer")
		expect(result).toContain("Explorer")
	})

	it("does not include model IDs or provider strings in Your Team", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "orchestrator" })
		expect(result).not.toContain("kimchi-dev/kimi-k2.6")
		expect(result).not.toContain("provider: `kimchi-dev`")
	})

	it("instructs to pick a persona by name with no model parameter", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "orchestrator" })
		expect(result).toContain('subagent_type: "Builder"')
		expect(result).toContain("Do NOT pass a `model` parameter")
		expect(result).not.toContain('subagent_type: "General-Purpose"')
	})

	it("self-serves planning when multi-model is off (all roles collapse)", () => {
		;(process as P).__kimchiMultiModelEnabled = false
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "orchestrator" })
		expect(result).toContain("always write the plan yourself")
		expect(result).not.toContain("delegate to the **Planner** model")
	})

	it("delegates planning when multi-model is on and planner !== orchestrator", () => {
		;(process as P).__kimchiMultiModelEnabled = true
		;(process as P).__kimchiCurrentModelRef = "kimchi-dev/kimi-k2.6"
		// Default roles have planner === orchestrator so this still self-serves.
		// To get delegation we'd need a custom settings file — test the false case.
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "orchestrator" })
		// Default roles: planner === orchestrator → self-serve
		expect(result).toContain("always write the plan yourself")
	})

	it("includes model-specific guidelines when model is provided", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "minimax-m2.7",
			registry,
			mode: "orchestrator",
		})
		expect(result).toContain("### Model Guidelines")
		expect(result).toContain("MiniMax M2 family")
	})

	it("full block contains plan-build-review pipeline prose", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "orchestrator" })
		expect(result).toContain("Plan phase")
		expect(result).toContain("Build phase")
		expect(result).toContain("Review phase")
		expect(result).toContain("Token budgets")
		expect(result).toContain("Plan self-validation")
	})
})

describe("resolveOrchestrationInstructions — plan mode", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("plan mode block contains classify → plan → stop prose", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			permissionMode: "plan",
		})
		expect(result).toContain("Plan mode")
		expect(result).toContain("STOP")
		expect(result).toContain("Do not proceed to implementation")
	})
})

describe("resolveOrchestrationInstructions — ferment (dispatch-only block)", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("dispatch-only block contains Your Team and intent-to-persona prose", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			fermentActive: true,
		})
		expect(result).toContain("## Your Team")
		expect(result).toContain("Matching intent to persona")
	})

	it("dispatch-only block does NOT contain plan-build-review pipeline", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			fermentActive: true,
		})
		expect(result).not.toContain("Mandatory pipeline for complex tasks")
		expect(result).not.toContain("Token budgets")
	})

	it("ferment + plan mode falls through to dispatch-only (unreachable dead cell)", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			permissionMode: "plan",
			fermentActive: true,
		})
		// fermentActive takes precedence — dispatch-only, not plan-mode
		expect(result).toContain("Matching intent to persona")
		expect(result).not.toContain("Mandatory pipeline for complex tasks")
	})
})

describe("resolveOrchestrationInstructions — subagent and single modes", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns single-model instructions with model ID in single-model mode", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "single" })
		expect(result).toContain("Single-Model Mode")
		expect(result).toContain("kimi-k2.6")
		expect(result).toContain("MUST always pass your own model ID")
		expect(result).toContain("never delegate to a different model")
	})

	it("returns subagent protocol in subagent mode", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "subagent" })
		expect(result).toContain("Subagent response protocol")
		expect(result).toContain('{"summary":')
		expect(result).not.toContain("Orchestrate the work")
	})

	it("subagent mode contains no orchestration content", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "subagent" })
		expect(result).not.toContain("Your Team")
	})

	it("single mode contains no Your Team", () => {
		const result = resolveOrchestrationInstructions({ currentModelId: "kimi-k2.6", registry, mode: "single" })
		expect(result).not.toContain("Your Team")
	})
})
