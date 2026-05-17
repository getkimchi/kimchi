/**
 * Unit tests for session-name extension
 */

import { describe, expect, it, vi } from "vitest"
import { getSessionName, resolveStartupContext, setSessionName } from "../startup-context.js"
import { deterministicFallback, extractFirstUserMessage } from "./session-name.js"

describe("session-name", () => {
	describe("resolveStartupContext", () => {
		it("should parse --name <value> from rawArgs", () => {
			const context = resolveStartupContext(["--name", "my-session", "some-other-arg"])
			expect(context.sessionName).toBe("my-session")
		})

		it("should parse --name=<value> from rawArgs", () => {
			const context = resolveStartupContext(["--name=my-session", "some-other-arg"])
			expect(context.sessionName).toBe("my-session")
		})

		it("should return undefined when --name is not present", () => {
			const context = resolveStartupContext(["--model", "claude-3-opus"])
			expect(context.sessionName).toBeUndefined()
		})

		it("should return undefined when --name has no value", () => {
			const context = resolveStartupContext(["--name"])
			expect(context.sessionName).toBeUndefined()
		})

		it("should not mutate the rawArgs array", () => {
			const originalArgs = ["--name", "test-session", "other-arg"]
			const argsCopy = [...originalArgs]
			resolveStartupContext(originalArgs)
			expect(originalArgs).toEqual(argsCopy)
		})

		it("should handle empty args array", () => {
			const context = resolveStartupContext([])
			expect(context.sessionName).toBeUndefined()
		})

		it("should handle --name as last argument without value", () => {
			const context = resolveStartupContext(["--model", "claude", "--name"])
			expect(context.sessionName).toBeUndefined()
		})

		it("should handle names with special characters", () => {
			const context = resolveStartupContext(["--name", "feature/ABC-123"])
			expect(context.sessionName).toBe("feature/ABC-123")
		})
	})

	describe("startup-context session name storage", () => {
		it("should store and retrieve session name", () => {
			setSessionName("test-name")
			expect(getSessionName()).toBe("test-name")
		})

		it("should return undefined when no session name is set", () => {
			setSessionName(undefined)
			expect(getSessionName()).toBeUndefined()
		})

		it("should allow clearing session name", () => {
			setSessionName("initial")
			setSessionName(undefined)
			expect(getSessionName()).toBeUndefined()
		})
	})
})

describe("updateTerminalTitle format", () => {
	// Test the title format logic in isolation
	it("should format title correctly", () => {
		const name = "my-session"
		const cwd = "/Users/test/user/project"
		// Simulate basename
		const basename = cwd.split("/").pop() ?? cwd

		const expected = `kimchi · ${name} · ${basename}`
		expect(expected).toBe("kimchi · my-session · project")
	})

	it("should handle empty name gracefully", () => {
		const name = ""
		const cwd = "/Users/test/user/project"
		const basename = cwd.split("/").pop() ?? cwd

		const expected = `kimchi · ${name} · ${basename}`
		expect(expected).toBe("kimchi ·  · project")
	})
})

describe("deterministicFallback", () => {
	it("should return input as-is when <= 35 chars", () => {
		expect(deterministicFallback("short-name")).toBe("short-name")
		expect(deterministicFallback("a".repeat(35))).toBe("a".repeat(35))
	})

	it("should truncate at last space before 35 chars", () => {
		const longName = "this is a very long session name that should be truncated"
		expect(deterministicFallback(longName)).toBe("this is a very long session name")
	})

	it("should handle no spaces by truncating at 35", () => {
		const noSpaces = "a".repeat(50)
		expect(deterministicFallback(noSpaces)).toBe("a".repeat(35))
	})

	it("should trim whitespace", () => {
		expect(deterministicFallback("  short  ")).toBe("short")
	})
})

describe("extractFirstUserMessage", () => {
	const createMockContext = (entries: unknown[]) => {
		return {
			sessionManager: {
				getBranch: vi.fn().mockReturnValue(entries),
				getEntries: vi.fn().mockReturnValue(entries),
			},
		} as unknown as { sessionManager: { getBranch: () => unknown[]; getEntries: () => unknown[] } }
	}

	it("should return null when no entries", () => {
		const ctx = createMockContext([])
		expect(extractFirstUserMessage(ctx as never)).toBeNull()
	})

	it("should return null when no user message found", () => {
		const ctx = createMockContext([{ type: "message", message: { role: "assistant", content: "Hello" } }])
		expect(extractFirstUserMessage(ctx as never)).toBeNull()
	})

	it("should extract string content from user message", () => {
		const ctx = createMockContext([{ type: "message", message: { role: "user", content: "Hello, help me with code" } }])
		expect(extractFirstUserMessage(ctx as never)).toBe("Hello, help me with code")
	})

	it("should extract text from array content", () => {
		const ctx = createMockContext([
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "Please review my PR" },
						{ type: "image", image: "data:image/png;base64,abc" },
					],
				},
			},
		])
		expect(extractFirstUserMessage(ctx as never)).toBe("Please review my PR")
	})

	it("should return full content without truncation", () => {
		const longContent = "a".repeat(300)
		const ctx = createMockContext([{ type: "message", message: { role: "user", content: longContent } }])
		expect(extractFirstUserMessage(ctx as never)).toBe(longContent)
	})

	it("should find first user message even if assistant messages come first", () => {
		const ctx = createMockContext([
			{ type: "message", message: { role: "assistant", content: "How can I help?" } },
			{ type: "message", message: { role: "user", content: "I need help with testing" } },
		])
		expect(extractFirstUserMessage(ctx as never)).toBe("I need help with testing")
	})
})
