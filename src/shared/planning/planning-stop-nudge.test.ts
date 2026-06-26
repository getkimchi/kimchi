import { describe, expect, it } from "vitest"
import {
	FERMENT_SCOPING_STOP_NUDGE,
	FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE,
	FERMENT_SCOPING_STOP_NUDGE_ONESHOT,
	MAX_PLANNING_STOP_NUDGES,
	PLAN_MODE_STOP_NUDGE,
	contentHasToolCall,
	extractTextFromContent,
	hasFermentScopingCompletionSignal,
	hasPlanCompletionSignal,
	isNudgeSuppressed,
	shouldNudge,
} from "./planning-stop-nudge.js"

describe("shouldNudge", () => {
	it("returns true when all conditions met: tool call, stop reason, no completion signal", () => {
		expect(shouldNudge({ hasToolCall: true, stopReason: "stop", completionSignalPresent: false })).toBe(true)
	})

	it("returns false when no tool calls were made", () => {
		expect(shouldNudge({ hasToolCall: false, stopReason: "stop", completionSignalPresent: false })).toBe(false)
	})

	it("returns false when stopReason is not 'stop'", () => {
		expect(shouldNudge({ hasToolCall: true, stopReason: "end_turn", completionSignalPresent: false })).toBe(false)
		expect(shouldNudge({ hasToolCall: true, stopReason: undefined, completionSignalPresent: false })).toBe(false)
		expect(shouldNudge({ hasToolCall: true, stopReason: "tool_use", completionSignalPresent: false })).toBe(false)
	})

	it("returns false when completion signal is present", () => {
		expect(shouldNudge({ hasToolCall: true, stopReason: "stop", completionSignalPresent: true })).toBe(false)
	})

	it("returns false when all conditions are false", () => {
		expect(shouldNudge({ hasToolCall: false, stopReason: "end_turn", completionSignalPresent: true })).toBe(false)
	})
})

describe("isNudgeSuppressed", () => {
	it("allows nudges up to the max count", () => {
		for (let i = 1; i <= MAX_PLANNING_STOP_NUDGES; i++) {
			expect(isNudgeSuppressed(i)).toBe(false)
		}
	})

	it("suppresses nudges after the max count", () => {
		expect(isNudgeSuppressed(MAX_PLANNING_STOP_NUDGES + 1)).toBe(true)
		expect(isNudgeSuppressed(MAX_PLANNING_STOP_NUDGES + 10)).toBe(true)
	})

	it("allows count 0", () => {
		expect(isNudgeSuppressed(0)).toBe(false)
	})
})

describe("hasPlanCompletionSignal", () => {
	it("detects <!-- PLAN_COMPLETE --> marker", () => {
		expect(hasPlanCompletionSignal("Here is the plan.\n\n<!-- PLAN_COMPLETE -->")).toBe(true)
	})

	it("detects <done> marker", () => {
		expect(hasPlanCompletionSignal("Plan complete.\n<done>")).toBe(true)
	})

	it("returns false for text without any marker", () => {
		expect(hasPlanCompletionSignal("Here is the plan but it is not done.")).toBe(false)
	})

	it("returns false for empty string", () => {
		expect(hasPlanCompletionSignal("")).toBe(false)
	})

	it("detects marker embedded in longer text", () => {
		expect(hasPlanCompletionSignal("Some text <!-- PLAN_COMPLETE --> more text")).toBe(true)
	})
})

describe("extractTextFromContent", () => {
	it("extracts text from text content blocks", () => {
		const content = [
			{ type: "text", text: "Hello" },
			{ type: "text", text: " World" },
		]
		expect(extractTextFromContent(content)).toBe("Hello\n World")
	})

	it("ignores non-text content blocks", () => {
		const content = [
			{ type: "text", text: "Hello" },
			{ type: "tool_use", id: "1", name: "read", input: {} },
			{ type: "text", text: "World" },
		]
		expect(extractTextFromContent(content)).toBe("Hello\nWorld")
	})

	it("returns empty string for empty content array", () => {
		expect(extractTextFromContent([])).toBe("")
	})

	it("returns empty string when no text blocks present", () => {
		const content = [{ type: "tool_use", id: "1", name: "read", input: {} }]
		expect(extractTextFromContent(content)).toBe("")
	})
})

describe("contentHasToolCall", () => {
	// Regression: contentHasToolCall previously checked for type "tool_use" (raw provider shape)
	// but turn_end assistant messages use pi-mono's normalized shape type "toolCall".
	// This caused shouldNudge() to miss real tool calls and fire stall-recovery nudges incorrectly.
	it("returns true for the pi-mono normalized 'toolCall' shape used in turn_end", () => {
		const content = [
			{ type: "text", text: "thinking..." },
			{ type: "toolCall", id: "1", name: "read", input: {} },
		]
		expect(contentHasToolCall(content)).toBe(true)
	})

	it("also returns true for the raw provider 'tool_use' shape", () => {
		const content = [
			{ type: "text", text: "thinking..." },
			{ type: "tool_use", id: "1", name: "read", input: {} },
		]
		expect(contentHasToolCall(content)).toBe(true)
	})

	it("returns false when only text blocks are present", () => {
		const content = [{ type: "text", text: "just text" }]
		expect(contentHasToolCall(content)).toBe(false)
	})

	it("returns false for empty array", () => {
		expect(contentHasToolCall([])).toBe(false)
	})

	it("does not match tool_result blocks (those appear in user messages, not assistant)", () => {
		const content = [{ type: "tool_result", tool_use_id: "1", content: "result" }]
		expect(contentHasToolCall(content)).toBe(false)
	})
})

describe("PLAN_MODE_STOP_NUDGE", () => {
	it("references the completion marker", () => {
		expect(PLAN_MODE_STOP_NUDGE).toContain("<!-- PLAN_COMPLETE -->")
	})

	it("references the questionnaire tool", () => {
		expect(PLAN_MODE_STOP_NUDGE).toContain("questionnaire")
	})

	it("references the plan structure", () => {
		expect(PLAN_MODE_STOP_NUDGE).toContain("Goal")
		expect(PLAN_MODE_STOP_NUDGE).toContain("Chunks")
		expect(PLAN_MODE_STOP_NUDGE).toContain("Verification Strategy")
	})
})

describe("FERMENT_SCOPING_STOP_NUDGE (deprecated alias)", () => {
	it("equals the interactive variant for backwards compatibility", () => {
		expect(FERMENT_SCOPING_STOP_NUDGE).toBe(FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE)
	})
})

describe("FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE", () => {
	it("references propose_ferment_scoping (the interactive scoping tool)", () => {
		expect(FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE).toContain("propose_ferment_scoping")
	})

	it("does not reference scope_ferment (that is for one-shot)", () => {
		expect(FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE).not.toContain("scope_ferment")
	})

	it("references the P1/P2/P3 gates array required by the scoping schema", () => {
		expect(FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE).toContain("P1/P2/P3")
	})
})

describe("FERMENT_SCOPING_STOP_NUDGE_ONESHOT", () => {
	it("references scope_ferment (the one-shot scoping tool)", () => {
		expect(FERMENT_SCOPING_STOP_NUDGE_ONESHOT).toContain("scope_ferment")
	})

	it("does not reference propose_ferment_scoping (that is for interactive)", () => {
		expect(FERMENT_SCOPING_STOP_NUDGE_ONESHOT).not.toContain("propose_ferment_scoping")
	})

	it("mentions ask_user routing to the judge", () => {
		expect(FERMENT_SCOPING_STOP_NUDGE_ONESHOT).toContain("ask_user")
		expect(FERMENT_SCOPING_STOP_NUDGE_ONESHOT).toContain("judge")
	})

	it("references the P1/P2/P3 gates array required by the scoping schema", () => {
		expect(FERMENT_SCOPING_STOP_NUDGE_ONESHOT).toContain("P1/P2/P3")
	})
})

describe("hasFermentScopingCompletionSignal", () => {
	it("returns true when scope_ferment is in the tool call list", () => {
		expect(hasFermentScopingCompletionSignal(["read", "scope_ferment"])).toBe(true)
	})

	it("returns true when propose_ferment_scoping is in the tool call list", () => {
		expect(hasFermentScopingCompletionSignal(["propose_ferment_scoping"])).toBe(true)
	})

	it("returns true when confirm_ferment_completion_criteria is in the tool call list", () => {
		expect(hasFermentScopingCompletionSignal(["confirm_ferment_completion_criteria"])).toBe(true)
	})

	it("returns false when only exploration tools are present", () => {
		expect(hasFermentScopingCompletionSignal(["read", "grep", "ls", "bash"])).toBe(false)
	})

	it("returns false for an empty list", () => {
		expect(hasFermentScopingCompletionSignal([])).toBe(false)
	})
})
