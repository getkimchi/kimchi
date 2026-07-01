import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the secret registry before importing the extension
const { mockCollectKnownSecrets, mockScrubSessionFile } = vi.hoisted(() => ({
	mockCollectKnownSecrets: vi.fn(() => new Set<string>()),
	mockScrubSessionFile: vi.fn(),
}))

vi.mock("./secret-registry.js", () => ({
	collectKnownSecrets: mockCollectKnownSecrets,
}))

vi.mock("./session-scrub.js", () => ({
	scrubSessionFile: mockScrubSessionFile,
}))

vi.mock("./engine.js", async (importActual) => {
	const actual = await importActual<typeof import("./engine.js")>()
	return {
		...actual,
		// Wrap redact so we can verify it was called, but use the real implementation
		redact: vi.fn(actual.redact),
	}
})

import { redact } from "./engine.js"
import createRedactionExtension from "./index.js"

function createMockPi() {
	const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {}
	return {
		on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			if (!handlers[event]) handlers[event] = []
			handlers[event].push(handler)
		}),
		emit: vi.fn((event: string, data: unknown, ctx?: unknown) => {
			const hs = handlers[event]
			if (!hs) return
			let current = data
			let modified = false
			for (const h of hs) {
				const result = h(current, ctx ?? {})
				if (result && typeof result === "object") {
					if ("content" in result || "messages" in result || "input" in result) {
						current = { ...(current as object), ...result }
						modified = true
					}
				}
			}
			return modified ? current : undefined
		}),
	}
}

describe("redaction extension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCollectKnownSecrets.mockReturnValue(new Set())
		mockScrubSessionFile.mockReset()
	})

	it("registers session_start, tool_result, context, and turn_end handlers", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function))
		expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function))
		expect(pi.on).toHaveBeenCalledWith("context", expect.any(Function))
		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function))
	})

	// ── tool_result hook ─────────────────────────────────────────────────────

	it("scrubs text content containing a known apiKey", () => {
		mockCollectKnownSecrets.mockReturnValue(new Set(["test-api-key-123456789"]))
		const pi = createMockPi()
		createRedactionExtension(pi as never)

		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc1",
			toolName: "bash",
			input: { command: "printenv" },
			content: [{ type: "text", text: "KIMCHI_API_KEY=test-api-key-123456789" }],
			isError: false,
			details: undefined,
		})

		expect(result).toBeDefined()
		const r = result as { content: { text: string }[] }
		expect(r.content[0].text).toBe("KIMCHI_API_KEY=[REDACTED]")
	})

	it("scrubs text content containing a GitHub token pattern", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc2",
			toolName: "bash",
			input: { command: "cat ~/.gitconfig" },
			content: [{ type: "text", text: "token = ghp_0123456789abcdefghij0123456789abcdefghij" }],
			isError: false,
			details: undefined,
		})

		const r2 = result as { content: { text: string }[] }
		expect(r2.content[0].text).toBe("token = [REDACTED]")
	})

	it("scrubs secrets in event.input in place (tool arguments echoed back)", () => {
		mockCollectKnownSecrets.mockReturnValue(new Set(["test-api-key-123456789"]))
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const input = { command: "curl -H 'Authorization: Bearer test-api-key-123456789' https://api.example.com" }
		pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc-input",
			toolName: "bash",
			input,
			content: [{ type: "text", text: "OK" }],
			isError: false,
			details: undefined,
		})

		// event.input is mutated in place — verify the original object was scrubbed
		expect(input.command).toContain("[REDACTED]")
		expect(input.command).not.toContain("test-api-key-123456789")
	})

	it("scrubs nested secrets in event.input in place", () => {
		mockCollectKnownSecrets.mockReturnValue(new Set(["test-api-key-123456789"]))
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const input = { options: { headers: { Authorization: "Bearer test-api-key-123456789" } } }
		pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc-nested",
			toolName: "bash",
			input,
			content: [{ type: "text", text: "OK" }],
			isError: false,
			details: undefined,
		})

		expect(input.options.headers.Authorization).toBe("Bearer [REDACTED]")
	})

	it("returns undefined when content has no secrets", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc3",
			toolName: "bash",
			input: { command: "ls" },
			content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
			isError: false,
			details: undefined,
		})

		expect(result).toBeUndefined()
	})

	it("passes through image content unchanged", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const imageBlock = { type: "image", source: { data: "base64data", mediaType: "image/png" } }
		const result = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc4",
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: "ghp_0123456789abcdefghij0123456789abcdefghij" }, imageBlock],
			isError: false,
			details: undefined,
		})

		const r3 = result as { content: unknown[] }
		expect((r3.content[0] as { text: string }).text).toBe("[REDACTED]")
		expect(r3.content[1]).toBe(imageBlock)
	})

	it("passes through when content is missing", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc5",
			toolName: "bash",
			input: {},
			content: undefined,
			isError: false,
			details: undefined,
		})

		expect(result).toBeUndefined()
	})

	it("passes through when content is not an array", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc6",
			toolName: "bash",
			input: {},
			content: "not an array",
			isError: false,
			details: undefined,
		})

		expect(result).toBeUndefined()
	})

	it("catches engine errors and returns original content", () => {
		vi.mocked(redact).mockImplementationOnce(() => {
			throw new Error("engine crash")
		})
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const originalText = "some output"
		const result = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc7",
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: originalText }],
			isError: false,
			details: undefined,
		})

		expect(result).toBeUndefined()
	})

	it("redacts error results (isError: true)", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc8",
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: "Error: Bearer sk-secret-token-12345678" }],
			isError: true,
			details: undefined,
		})

		const r4 = result as { content: { text: string }[] }
		expect(r4.content[0].text).toBe("Error: [REDACTED]")
	})

	it("session_start rebuilds the known-secrets set", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)

		mockCollectKnownSecrets.mockReturnValue(new Set(["secret-aaaa1111"]))
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result1 = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc9a",
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: "secret-aaaa1111" }],
			isError: false,
			details: undefined,
		})
		const r1 = result1 as { content: { text: string }[] }
		expect(r1.content[0].text).toBe("[REDACTED]")

		mockCollectKnownSecrets.mockReturnValue(new Set(["secret-bbbb2222"]))
		pi.emit("session_start", { type: "session_start", reason: "reload" })

		const result2 = pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc9b",
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: "secret-aaaa1111" }],
			isError: false,
			details: undefined,
		})

		expect(result2).toBeUndefined()
	})

	// ── context hook ────────────────────────────────────────────────────────

	it("context hook scrubs tool-call args in assistant messages", () => {
		mockCollectKnownSecrets.mockReturnValue(new Set(["secret-api-key-12345678"]))
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							toolCallId: "tc1",
							name: "bash",
							arguments: { command: "curl -H 'Authorization: Bearer secret-api-key-12345678' https://api.example.com" },
						},
					],
				},
			],
		})

		expect(result).toBeDefined()
		const messages = (result as { messages: { content: { arguments: { command: string } }[] }[] }).messages
		expect(messages[0].content[0].arguments.command).toContain("[REDACTED]")
		expect(messages[0].content[0].arguments.command).not.toContain("secret-api-key-12345678")
	})

	it("context hook returns undefined when no tool-call args contain secrets", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("context", {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "bash", arguments: { command: "ls -la" } }],
				},
			],
		})

		expect(result).toBeUndefined()
	})

	it("context hook passes through non-assistant messages unchanged", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("context", {
			type: "context",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		})

		expect(result).toBeUndefined()
	})

	it("context hook scrubs GitHub token patterns in tool-call args", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		const result = pi.emit("context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							toolCallId: "tc2",
							name: "bash",
							arguments: { command: "echo ghp_0123456789abcdefghij0123456789abcdefghij" },
						},
					],
				},
			],
		})

		expect(result).toBeDefined()
		const messages = (result as { messages: { content: { arguments: { command: string } }[] }[] }).messages
		expect(messages[0].content[0].arguments.command).toBe("echo [REDACTED]")
	})

	// ── turn_end hook ───────────────────────────────────────────────────────

	it("turn_end hook calls scrubSessionFile with the session file path", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		pi.emit(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, message: { role: "user", content: [] }, toolResults: [] },
			{ sessionManager: { getSessionFile: () => "/path/to/session.jsonl" } },
		)

		expect(mockScrubSessionFile).toHaveBeenCalledWith("/path/to/session.jsonl", expect.any(Set))
	})

	it("turn_end hook catches errors and does not block the turn", () => {
		mockScrubSessionFile.mockImplementation(() => {
			throw new Error("scrub failed")
		})
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		expect(() =>
			pi.emit(
				"turn_end",
				{ type: "turn_end", turnIndex: 0, message: { role: "user", content: [] }, toolResults: [] },
				{ sessionManager: { getSessionFile: () => "/path/to/session.jsonl" } },
			),
		).not.toThrow()
	})

	it("turn_end hook does nothing when session file is not available", () => {
		const pi = createMockPi()
		createRedactionExtension(pi as never)
		pi.emit("session_start", { type: "session_start", reason: "startup" })

		pi.emit(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, message: { role: "user", content: [] }, toolResults: [] },
			{ sessionManager: { getSessionFile: () => undefined } },
		)

		expect(mockScrubSessionFile).not.toHaveBeenCalled()
	})
})
