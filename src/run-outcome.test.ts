import type { Args } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	classifyRunOutcome,
	formatRunOutcomeDiagnostic,
	type MessageLikeSessionEntry,
	type RunOutcomeSnapshot,
} from "./run-outcome.js"

// Helpers to build session entries
function createAssistantMessage(
	content: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string }>,
	stopReason = "stop",
	errorMessage?: string,
): MessageLikeSessionEntry {
	return {
		type: "message",
		id: "msg-2",
		parentId: "msg-1",
		message: {
			role: "assistant",
			content: content as any,
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4",
			usage: { inputTokens: 10, outputTokens: 5 },
			stopReason: stopReason,
			...(errorMessage ? { errorMessage } : {}),
		} as any,
	}
}

function createCustomMessage(content: string): MessageLikeSessionEntry {
	return {
		type: "custom_message",
		id: "msg-3",
		parentId: "msg-2",
		customType: "test",
		content,
		display: true,
	}
}

function createToolResultMessage(content: string): MessageLikeSessionEntry {
	return {
		type: "message",
		id: "msg-4",
		parentId: "msg-3",
		message: {
			role: "tool",
			content,
			toolUseId: "tool-1",
		},
	}
}

describe("classifyRunOutcome", () => {
	it("classifies an inactive tracker as ok", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: false,
			inputSeen: false,
			runSeen: false,
			aborted: false,
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("classifies no parsed prompt, no input, and no run as no-prompt", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: false,
			aborted: false,
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "no-prompt" })
	})

	it("classifies a parsed extension command with no input or run as ok", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: false,
			aborted: false,
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: ["/cmd"], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("classifies a parsed at-file with no input or run as ok", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: false,
			aborted: false,
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: ["prompt.txt"] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("classifies observed piped input with no run as ok", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: true,
			runSeen: false,
			aborted: false,
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("accepts assistant text done", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([{ type: "text", text: "done" }]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("rejects assistant text that is only whitespace", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([{ type: "text", text: "   \n" }]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result.kind).toBe("no-result")
	})

	it("rejects an assistant message with empty content", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result.kind).toBe("no-result")
	})

	it("rejects an assistant message with only a thinking block", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([{ type: "thinking", thinking: "hmm..." }]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result.kind).toBe("no-result")
	})

	it("rejects an assistant message with only a tool call", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([{ type: "toolCall", id: "1", name: "read" }]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result.kind).toBe("no-result")
	})

	it("accepts thinking plus non-whitespace text", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([
				{ type: "thinking", thinking: "hmm..." },
				{ type: "text", text: "done" },
			]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("accepts stopReason error because pi already exits 1", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([], "error"),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("accepts stopReason aborted because pi already exits 1", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([], "aborted"),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("accepts stopReason length with text because pi already exits 1", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([{ type: "text", text: "partial" }], "length"),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("rejects a final tool result message", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createToolResultMessage("result"),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result.kind).toBe("no-result")
	})

	it("rejects a custom message after a real answer", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createCustomMessage("output"),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result.kind).toBe("no-result")
	})

	it("classifies an aborted settled run as ok", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: true,
			finalEntry: createAssistantMessage([]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("reports a denied tool name and reason", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			deniedTool: { toolName: "write", reason: "Denied by rule: write" },
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result.kind).toBe("no-result")
		if (result.kind === "no-result" && result.lastEvent.kind === "denied-tool") {
			expect(result.lastEvent.toolName).toBe("write")
			expect(result.lastEvent.reason).toBe("Denied by rule: write")
		}
		const diagnostic = formatRunOutcomeDiagnostic(result)
		expect(diagnostic).toContain("write")
		expect(diagnostic).toContain("Denied by rule: write")
	})

	it("reports the last role and stop reason when there is no denial", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([], "stop"),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result.kind).toBe("no-result")
		if (result.kind === "no-result" && result.lastEvent.kind === "final-message") {
			expect(result.lastEvent.role).toBe("assistant")
			expect(result.lastEvent.stopReason).toBe("stop")
		}
		const diagnostic = formatRunOutcomeDiagnostic(result)
		expect(diagnostic).toContain("assistant")
		expect(diagnostic).toContain("stop")
	})

	it("never includes model text in diagnostic details", () => {
		const secretString = "SUPER_SECRET_MODEL_OUTPUT_12345"
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		const diagnostic = formatRunOutcomeDiagnostic(result as any)
		expect(diagnostic).not.toContain(secretString)
	})
})

describe("formatRunOutcomeDiagnostic", () => {
	it("formats no-prompt with correct first line", () => {
		const outcome = { kind: "no-prompt" as const }
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		expect(diagnostic).toMatch(/^KIMCHI_NO_PROMPT: no prompt reached the agent; exiting with code \d+\./)
	})

	it("formats no-result with correct first line", () => {
		const outcome = {
			kind: "no-result" as const,
			lastEvent: { kind: "final-message" as const, role: "assistant" },
		}
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		expect(diagnostic).toMatch(/^KIMCHI_NO_RESULT: the agent finished without a final answer; exiting with code \d+\./)
	})

	it("includes session path when provided", () => {
		const outcome = {
			kind: "no-result" as const,
			lastEvent: { kind: "final-message" as const, role: "assistant" },
			sessionPath: "/path/to/session",
		}
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		expect(diagnostic).toContain("Session: /path/to/session")
	})

	it("includes no-session message when path is not provided", () => {
		const outcome = {
			kind: "no-result" as const,
			lastEvent: { kind: "final-message" as const, role: "assistant" },
		}
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		expect(diagnostic).toContain("No session was saved (--no-session)")
	})

	it("includes json mode hint when session exists", () => {
		const outcome = {
			kind: "no-result" as const,
			lastEvent: { kind: "final-message" as const, role: "assistant" },
			sessionPath: "/path/to/session",
		}
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		expect(diagnostic).toContain("Rerun with --mode json to see every step, or open the session file")
	})

	it("includes json mode hint without file reference when no session", () => {
		const outcome = {
			kind: "no-result" as const,
			lastEvent: { kind: "final-message" as const, role: "assistant" },
		}
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		expect(diagnostic).toContain("Rerun with --mode json to see every step")
	})
})
