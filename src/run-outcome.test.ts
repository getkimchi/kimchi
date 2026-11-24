import type { Args, SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { KIMCHI_NO_PROMPT_EXIT_CODE, KIMCHI_NO_RESULT_EXIT_CODE } from "./infrastructure-error.js"
import {
	classifyRunOutcome,
	formatRunOutcomeDiagnostic,
	type MessageLikeSessionEntry,
	type RunOutcomeSnapshot,
} from "./run-outcome.js"

const now = Date.now().toString()

// Derive real pi types from SessionEntry
type MessageSessionEntry = Extract<SessionEntry, { type: "message" }>
type AssistantMessage = Extract<MessageSessionEntry["message"], { role: "assistant" }>
type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>

// Typed fixture helpers
function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): MessageLikeSessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: stopReason,
		timestamp: Date.now(),
	}
	return {
		type: "message" as const,
		id: "msg-2",
		parentId: "msg-1",
		timestamp: now,
		message,
	}
}

function createToolResultMessage(): MessageLikeSessionEntry {
	return {
		type: "message" as const,
		id: "msg-3",
		parentId: "msg-2",
		timestamp: now,
		message: {
			role: "toolResult" as const,
			content: [{ type: "text", text: "result" }],
			toolCallId: "tool-1",
			toolName: "read",
			isError: false,
			timestamp: Date.now(),
		},
	}
}

function createCustomMessage(content: string): CustomMessageEntry {
	const entry: CustomMessageEntry = {
		type: "custom_message",
		id: "msg-custom",
		parentId: "msg-2",
		customType: "test",
		content: [{ type: "text", text: content }],
		display: true,
		timestamp: now,
	}
	return entry
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
		expect(result).toMatchObject({ kind: "no-result" })
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
		expect(result).toMatchObject({ kind: "no-result" })
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
		expect(result).toMatchObject({ kind: "no-result" })
	})

	it("rejects an assistant message with only a tool call", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toMatchObject({ kind: "no-result" })
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
			finalEntry: createToolResultMessage(),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toMatchObject({
			kind: "no-result",
			lastEvent: { kind: "final-message", role: "toolResult" },
		})
	})

	it("rejects a custom message after a real answer", () => {
		// The custom message is the final entry after an earlier answer.
		// Because the snapshot interface only carries finalEntry, the custom message
		// is modeled as the final entry, representing the final outcome of a run.
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createCustomMessage("output"),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toMatchObject({
			kind: "no-result",
			lastEvent: { kind: "final-message", role: "custom" },
		})
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
			finalEntry: createAssistantMessage([]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toMatchObject({
			kind: "no-result",
			lastEvent: { kind: "denied-tool", toolName: "write", reason: "Denied by rule: write" },
		})
		if (result.kind !== "no-result") throw new Error("Expected no-result")
		const diagnostic = formatRunOutcomeDiagnostic(result)
		expect(diagnostic).toContain("write")
		expect(diagnostic).toContain("Denied by rule: write")
	})

	it("accepts denial plus text answer (ok)", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			deniedTool: { toolName: "write", reason: "Denied" },
			finalEntry: createAssistantMessage([{ type: "text", text: "Here is the answer" }]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toEqual({ kind: "ok" })
	})

	it("accepts denial plus empty final assistant (no-result with denied-tool)", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			deniedTool: { toolName: "write", reason: "Denied" },
			finalEntry: createAssistantMessage([]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)
		expect(result).toMatchObject({
			kind: "no-result",
			lastEvent: { kind: "denied-tool" },
		})
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
		expect(result).toMatchObject({
			kind: "no-result",
			lastEvent: { kind: "final-message", role: "assistant", stopReason: "stop" },
		})
		if (result.kind !== "no-result") throw new Error("Expected no-result")
		const diagnostic = formatRunOutcomeDiagnostic(result)
		expect(diagnostic).toContain("assistant")
		expect(diagnostic).toContain("(stop reason: stop)")
	})

	it("never includes model text in diagnostic details", () => {
		const secretInFinal = "FINAL_SECRET_ABC123"

		// Snapshot with an assistant message that has the secret in a thinking block
		// and a final empty assistant message with a thinking block containing a different secret
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: false,
			runSeen: true,
			aborted: false,
			finalEntry: createAssistantMessage([{ type: "thinking", thinking: secretInFinal }]),
		}
		const args: Pick<Args, "messages" | "fileArgs"> = { messages: [], fileArgs: [] }
		const result = classifyRunOutcome(snapshot, args)

		// Should be no-result due to empty text
		expect(result).toMatchObject({ kind: "no-result" })

		if (result.kind !== "no-result") throw new Error("Expected no-result")
		const diagnostic = formatRunOutcomeDiagnostic(result)
		// Secret in final entry's thinking block should not appear in diagnostics
		expect(diagnostic).not.toContain(secretInFinal)
	})
})

describe("classifyRunOutcome with Ferment V2", () => {
	it("accepts a settled Ferment V2 run that ends without an answer", () => {
		const snapshot: RunOutcomeSnapshot = {
			active: true,
			inputSeen: true,
			runSeen: true,
			aborted: false,
			fermentV2Owned: true,
			sessionPath: "/tmp/s.jsonl",
		}
		expect(classifyRunOutcome(snapshot, { messages: ["p"], fileArgs: [] })).toEqual({ kind: "ok" })
	})
})

describe("formatRunOutcomeDiagnostic", () => {
	it("formats no-prompt with correct first line and Bug A advice", () => {
		const outcome = { kind: "no-prompt" as const }
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		const lines = diagnostic.split("\n")
		expect(lines[0]).toBe(
			`KIMCHI_NO_PROMPT: no prompt reached the agent; exiting with code ${KIMCHI_NO_PROMPT_EXIT_CODE}.`,
		)
		expect(lines[1]).toBe("A flag such as --auto may have taken the prompt as its value.")
		expect(lines[2]).toBe("Put the prompt before the flags, or write the flag as --auto=true.")
		expect(lines.length).toBeLessThanOrEqual(5)
	})

	it("formats no-result with correct first line and Bug A advice context", () => {
		const outcome = {
			kind: "no-result" as const,
			lastEvent: { kind: "final-message" as const, role: "assistant" },
		}
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		const lines = diagnostic.split("\n")
		expect(lines[0]).toBe(
			`KIMCHI_NO_RESULT: the agent finished without a final answer; exiting with code ${KIMCHI_NO_RESULT_EXIT_CODE}.`,
		)
		expect(lines.length).toBeLessThanOrEqual(5)
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
		expect(diagnostic).toContain("No session was saved (--no-session).")
	})

	it("includes json mode hint when session exists", () => {
		const outcome = {
			kind: "no-result" as const,
			lastEvent: { kind: "final-message" as const, role: "assistant" },
			sessionPath: "/path/to/session",
		}
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		expect(diagnostic).toContain("Rerun with --mode json to see every step, or open the session file.")
	})

	it("includes json mode hint without file reference when no session", () => {
		const outcome = {
			kind: "no-result" as const,
			lastEvent: { kind: "final-message" as const, role: "assistant" },
		}
		const diagnostic = formatRunOutcomeDiagnostic(outcome)
		expect(diagnostic).toContain("Rerun with --mode json to see every step.")
	})
})
