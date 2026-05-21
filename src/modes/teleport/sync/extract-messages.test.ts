import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	type ExtractResult,
	PORTABLE_MESSAGE_LIST_SIZE_CAP_BYTES,
	PortableMessageListSchema,
	extractPortableMessages,
} from "./extract-messages.js"

interface FakeSessionOptions {
	messages: unknown[]
	sessionId?: string
	steering?: string[]
	followUp?: string[]
}

function makeSession(opts: FakeSessionOptions): AgentSession {
	const session = {
		sessionId: opts.sessionId ?? "fake-session",
		messages: opts.messages,
		getSteeringMessages: () => opts.steering ?? [],
		getFollowUpMessages: () => opts.followUp ?? [],
	}
	return session as unknown as AgentSession
}

function loadFixture(name: string): unknown[] {
	const url = new URL(`./__fixtures__/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(fileURLToPath(url), "utf-8"))
}

function expectOk<T extends ExtractResult>(result: T): Extract<T, { ok: true }> {
	if (!result.ok) {
		throw new Error(`Expected ok result, got error: ${JSON.stringify(result.error)}`)
	}
	return result as Extract<T, { ok: true }>
}

describe("extractPortableMessages", () => {
	it("returns 'empty' error for sessions with zero user messages", () => {
		const session = makeSession({ messages: loadFixture("empty") })
		const result = extractPortableMessages(session)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("unreachable")
		expect(result.error.code).toBe("empty")
		expect(result.error.message).toMatch(/Nothing to teleport/)
	})

	it("returns 'empty' error when only non-user messages are present", () => {
		// e.g. a corrupt history with assistant messages but no user input
		const session = makeSession({
			messages: [{ role: "assistant", content: [], usage: {}, stopReason: "stop", timestamp: 1 }],
		})
		const result = extractPortableMessages(session)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("unreachable")
		expect(result.error.code).toBe("empty")
	})

	it("extracts a user-only conversation cleanly", () => {
		const messages = loadFixture("user-only")
		const session = makeSession({ messages, sessionId: "user-only-session" })
		const ok = expectOk(extractPortableMessages(session))
		expect(ok.value.messages).toEqual(messages)
		expect(ok.value.steering).toEqual([])
		expect(ok.value.followUp).toEqual([])
		expect(ok.value.metadata.sourceSessionId).toBe("user-only-session")
		expect(ok.value.metadata.wireProtocol).toBe("pi-rpc-v1")
		expect(ok.value.metadata.originalPlatform).toMatch(/.+-.+/)
		expect(ok.value.metadata.clientVersion).toBeTypeOf("string")
	})

	it("preserves user / assistant / toolCall / toolResult structure", () => {
		const messages = loadFixture("full-with-tools")
		const session = makeSession({ messages })
		const ok = expectOk(extractPortableMessages(session))
		// Round-trip: messages array equals the input (no mutation, no reordering)
		expect(ok.value.messages).toEqual(messages)

		// Spot-check: tool call id flows through both the assistant content and the tool result
		const assistant = ok.value.messages[1] as { content: Array<Record<string, unknown>> }
		const toolCall = assistant.content.find((c) => c.type === "toolCall") as Record<string, unknown>
		expect(toolCall.id).toBe("tool_call_1")
		const toolResult = ok.value.messages[2] as { toolCallId: string; toolName: string }
		expect(toolResult.toolCallId).toBe("tool_call_1")
		expect(toolResult.toolName).toBe("read")
	})

	it("preserves compaction boundaries as opaque metadata", () => {
		const messages = loadFixture("with-compaction")
		const session = makeSession({ messages })
		const ok = expectOk(extractPortableMessages(session))
		const compaction = ok.value.messages.find((m) => m.role === "compactionSummary") as Record<string, unknown>
		expect(compaction).toBeDefined()
		expect(compaction.summary).toMatch(/Earlier discussion/)
		expect(compaction.tokensBefore).toBe(38400)
	})

	it("preserves assistant turns with stopReason 'error' (auto-retry fallout)", () => {
		const messages = loadFixture("with-auto-retry")
		const session = makeSession({ messages })
		const ok = expectOk(extractPortableMessages(session))
		const errored = ok.value.messages.find(
			(m) => m.role === "assistant" && (m as { stopReason?: string }).stopReason === "error",
		) as Record<string, unknown>
		expect(errored).toBeDefined()
		expect(errored.errorMessage).toMatch(/Upstream 529/)
		// And the retried-success message is still there too.
		const succeeded = ok.value.messages.filter(
			(m) => m.role === "assistant" && (m as { stopReason?: string }).stopReason === "stop",
		)
		expect(succeeded).toHaveLength(1)
	})

	it("drops branchSummary.fromId (local-only branch UUID)", () => {
		const messages = loadFixture("with-branches")
		// Sanity check that the fixture actually has a fromId to drop
		const inputBranch = messages.find((m) => (m as Record<string, unknown>).role === "branchSummary") as Record<
			string,
			unknown
		>
		expect(inputBranch.fromId).toBeTruthy()

		const session = makeSession({ messages })
		const ok = expectOk(extractPortableMessages(session))
		const outputBranch = ok.value.messages.find((m) => m.role === "branchSummary") as Record<string, unknown>
		expect(outputBranch).toBeDefined()
		expect("fromId" in outputBranch).toBe(false)
		// Other fields are preserved
		expect(outputBranch.summary).toBe(inputBranch.summary)
		expect(outputBranch.timestamp).toBe(inputBranch.timestamp)
	})

	it("does not mutate the source messages when stripping branch UUIDs", () => {
		const messages = loadFixture("with-branches")
		const branchIn = messages.find((m) => (m as Record<string, unknown>).role === "branchSummary") as Record<
			string,
			unknown
		>
		const originalFromId = branchIn.fromId

		const session = makeSession({ messages })
		extractPortableMessages(session)

		// The session's own messages array is unchanged after extraction.
		expect(branchIn.fromId).toBe(originalFromId)
	})

	it("includes pending steering and follow-up queues", () => {
		const messages = loadFixture("user-only")
		const session = makeSession({
			messages,
			steering: ["steer-1", "steer-2"],
			followUp: ["follow-up-1"],
		})
		const ok = expectOk(extractPortableMessages(session))
		expect(ok.value.steering).toEqual(["steer-1", "steer-2"])
		expect(ok.value.followUp).toEqual(["follow-up-1"])
	})

	it("returns 'too_large' error and names the largest entry when over the size cap", () => {
		const base = loadFixture("full-with-tools") as Record<string, unknown>[]
		// Pad the existing toolResult content to ~60MB so it blows the 50MB cap.
		const padded = base.map((m) => {
			if (m.role !== "toolResult") return m
			return {
				...m,
				content: [{ type: "text", text: "x".repeat(60 * 1024 * 1024) }],
			}
		})
		const session = makeSession({ messages: padded })
		const result = extractPortableMessages(session)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("unreachable")
		expect(result.error.code).toBe("too_large")
		if (result.error.code !== "too_large") throw new Error("unreachable")
		expect(result.error.sizeBytes).toBeGreaterThan(PORTABLE_MESSAGE_LIST_SIZE_CAP_BYTES)
		expect(result.error.capBytes).toBe(PORTABLE_MESSAGE_LIST_SIZE_CAP_BYTES)
		// The padded toolResult is index 2 in full-with-tools.json
		expect(result.error.largestEntryIndex).toBe(2)
		expect(result.error.largestEntryBytes).toBeGreaterThan(50 * 1024 * 1024)
		expect(result.error.message).toMatch(/Largest single message/)
	})

	describe("schema round-trip", () => {
		for (const fixture of ["user-only", "full-with-tools", "with-compaction", "with-auto-retry", "with-branches"]) {
			it(`extracted output for "${fixture}" validates against PortableMessageListSchema`, () => {
				const session = makeSession({
					messages: loadFixture(fixture),
					steering: ["steer-q"],
					followUp: ["follow-q"],
				})
				const ok = expectOk(extractPortableMessages(session))
				const parsed = PortableMessageListSchema.safeParse(ok.value)
				expect(parsed.success).toBe(true)
				if (!parsed.success) console.error(parsed.error.issues)
			})
		}
	})
})
