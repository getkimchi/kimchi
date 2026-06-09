import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	FERMENT_TOOLS,
	FERMENT_TOOL_NAMES,
	isClassifiedFermentToolName,
	isFermentToolName,
	isUserFacingFermentToolName,
} from "./tool-names.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerLifecycleTools } from "./tools/lifecycle.js"
import { registerPhaseTools } from "./tools/phases.js"
import { registerStepTools } from "./tools/steps.js"

function collectRegisteredToolNames(): string[] {
	const names: string[] = []
	const pi = {
		registerTool: (tool: { name: string }) => {
			names.push(tool.name)
		},
	} as unknown as ExtensionAPI

	registerLifecycleTools(pi)
	registerPhaseTools(pi)
	registerStepTools(pi)
	registerKnowledgeTools(pi)
	return names
}

describe("ferment tool name constants", () => {
	it("derives the public tool-name list from the constant object", () => {
		expect(FERMENT_TOOL_NAMES).toEqual(Object.values(FERMENT_TOOLS))
	})

	it("contains every registered Ferment tool", () => {
		expect(collectRegisteredToolNames().sort()).toEqual([...FERMENT_TOOL_NAMES].sort())
	})

	it("recognizes ferment tool names", () => {
		expect(isFermentToolName(FERMENT_TOOLS.PROPOSE_SCOPING)).toBe(true)
		expect(isFermentToolName("Agent")).toBe(false)
	})

	it("classifies every ferment tool as planner-only or non-planner", () => {
		expect(FERMENT_TOOL_NAMES.filter((name) => !isClassifiedFermentToolName(name))).toEqual([])
	})

	it("classifies criteria confirmation as user-facing", () => {
		expect(isUserFacingFermentToolName(FERMENT_TOOLS.CONFIRM_COMPLETION_CRITERIA)).toBe(true)
	})
})
