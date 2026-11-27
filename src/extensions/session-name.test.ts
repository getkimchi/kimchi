/**
 * Unit tests for session-name extension
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backendFor } from "@getkimchi/kimchi-bridge/ledger"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildSkillCommandPrompt } from "../modes/acp/skill-commands.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import sessionNameExtension, {
	deterministicFallback,
	extractFirstUserMessage,
	SESSION_NAME_MODEL,
	suggestSessionName,
} from "./session-name.js"

import { flushWorkSummaries } from "./work-attribution/summary.js"
import { getWorkId, setWorkId } from "./work-attribution.js"

const { mockGetRetrySettings, mockLoadConfig, retryDefaults } = vi.hoisted(() => ({
	mockGetRetrySettings: vi.fn(),
	mockLoadConfig: vi.fn(),
	retryDefaults: {
		enabled: true,
		maxRetries: 1,
		baseDelayMs: 2000,
		provider: {
			timeoutMs: 600000,
			maxRetries: 0,
			maxRetryDelayMs: 60000,
		},
	},
}))

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
		"@earendil-works/pi-coding-agent",
	)
	return {
		...actual,
		SettingsManager: {
			create: vi.fn(() => ({
				getRetrySettings: mockGetRetrySettings,
			})),
		},
	}
})

vi.mock("../config.js", () => ({
	RETRY_DEFAULTS: retryDefaults,
	loadConfig: mockLoadConfig,
}))

vi.mock("node:path", async () => {
	const actual = await vi.importActual<typeof import("node:path")>("node:path")
	return { ...actual, basename: () => "my-project" }
})

let attributionDir: string
beforeEach(() => {
	attributionDir = mkdtempSync(join(tmpdir(), "name-attribution-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", attributionDir)
	// Isolate from the ambient Kimchi agent dir: keyless configs now fall back
	// to $KIMCHI_CODING_AGENT_DIR/auth.json, and a developer shell's real login
	// would make the fallback tests send live requests.
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", join(attributionDir, "agent"))
	mockGetRetrySettings.mockReset()
	mockGetRetrySettings.mockReturnValue({ enabled: true, maxRetries: 1, baseDelayMs: 2000 })
	mockLoadConfig.mockReset()
	mockLoadConfig.mockReturnValue({
		apiKey: "",
		llmEndpoint: "https://llm.test/openai/v1",
	})
})

afterEach(async () => {
	vi.useRealTimers()
	await flushWorkSummaries()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	rmSync(attributionDir, { recursive: true, force: true })
})

const createMockCtx = (entries: unknown[]) =>
	createContext({
		cwd: "/home/user/my-project",
		hasUI: false,
		sessionManager: {
			getBranch: vi.fn().mockReturnValue(entries),
			getEntries: vi.fn().mockReturnValue(entries),
		},
	})

describe("deterministicFallback", () => {
	it("should return input as-is when <= 50 chars", () => {
		expect(deterministicFallback("short-name")).toBe("short-name")
		expect(deterministicFallback("a".repeat(50))).toBe("a".repeat(50))
	})

	it("should truncate at last space before 50 chars", () => {
		const longName = "this is a very long session name that should be truncated"
		expect(deterministicFallback(longName)).toBe("this is a very long session name that should be")
	})

	it("should handle no spaces by truncating at 50", () => {
		const noSpaces = "a".repeat(70)
		expect(deterministicFallback(noSpaces)).toBe("a".repeat(50))
	})

	it("should trim whitespace", () => {
		expect(deterministicFallback("  short  ")).toBe("short")
	})

	it("should collapse multiline whitespace", () => {
		expect(deterministicFallback("review this\n\n```ts\nconst x = 1\n```")).toBe("review this ```ts const x = 1 ```")
	})
})

describe("extractFirstUserMessage", () => {
	it("skips greetings and keeps the first actual task", () => {
		const ctx = createMockCtx([
			{ type: "message", message: { role: "user", content: "Hello!" } },
			{ type: "message", message: { role: "user", content: "Fix the resume menu jumping" } },
		])
		expect(extractFirstUserMessage(ctx as never)).toBe("Fix the resume menu jumping")
	})
	it("should return null when no entries", () => {
		const ctx = createMockCtx([])
		expect(extractFirstUserMessage(ctx as never)).toBeNull()
	})

	it("should return null when no user message found", () => {
		const ctx = createMockCtx([{ type: "message", message: { role: "assistant", content: "Hello" } }])
		expect(extractFirstUserMessage(ctx as never)).toBeNull()
	})

	it("should extract string content from user message", () => {
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: "Hello, help me with code" } }])
		expect(extractFirstUserMessage(ctx as never)).toBe("Hello, help me with code")
	})

	it("should extract text from array content", () => {
		const ctx = createMockCtx([
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
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: longContent } }])
		expect(extractFirstUserMessage(ctx as never)).toBe(longContent)
	})

	it("should find first user message even if assistant messages come first", () => {
		const ctx = createMockCtx([
			{ type: "message", message: { role: "assistant", content: "How can I help?" } },
			{ type: "message", message: { role: "user", content: "I need help with testing" } },
		])
		expect(extractFirstUserMessage(ctx as never)).toBe("I need help with testing")
	})

	it("should bundle up to 3 user messages", () => {
		const ctx = createMockCtx([
			{ type: "message", message: { role: "user", content: "First task" } },
			{ type: "message", message: { role: "assistant", content: "Got it" } },
			{ type: "message", message: { role: "user", content: "Second detail" } },
			{ type: "message", message: { role: "user", content: "Third note" } },
			{ type: "message", message: { role: "user", content: "Fourth ignored" } },
		])
		expect(extractFirstUserMessage(ctx as never)).toBe("First task\n---\nSecond detail\n---\nThird note")
	})

	it("should skip non-message entries", () => {
		const ctx = createMockCtx([
			{ type: "tool_call", message: { role: "user", content: "tool" } },
			{ type: "message", message: { role: "user", content: "Real message" } },
		])
		expect(extractFirstUserMessage(ctx as never)).toBe("Real message")
	})

	it("should fallback from branch to entries when branch has no user messages", () => {
		const ctx = {
			sessionManager: {
				getBranch: vi.fn().mockReturnValue([{ type: "message", message: { role: "assistant", content: "hi" } }]),
				getEntries: vi.fn().mockReturnValue([{ type: "message", message: { role: "user", content: "from entries" } }]),
			},
		} as unknown as { sessionManager: { getBranch: () => unknown[]; getEntries: () => unknown[] } }
		expect(extractFirstUserMessage(ctx as never)).toBe("from entries")
	})
})

describe("skill invocation title input", () => {
	// Shaped like upstream _expandSkillCommand's output, including the
	// references line it always inserts inside the block.
	const nativeSkillBlock = (args?: string) => {
		const body = "Long skill instructions. ".repeat(80) // > 500 chars
		const block = `<skill name="gatekeeper" location="/skills/gatekeeper/SKILL.md">\nReferences are relative to /skills/gatekeeper.\n\n${body.trim()}\n</skill>`
		return args ? `${block}\n\n${args}` : block
	}

	it("uses only the user arguments from a native CLI skill block", () => {
		const args = "Explain what a closure is in JavaScript"
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: nativeSkillBlock(args) } }])
		const hint = extractFirstUserMessage(ctx as never)
		expect(hint).toBe(args)
	})

	it("falls back to the skill name when a native CLI skill block has no arguments", () => {
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: nativeSkillBlock() } }])
		expect(extractFirstUserMessage(ctx as never)).toBe("gatekeeper")
	})

	it("keeps the header and trailing arguments from a real ACP skill expansion", () => {
		const args = "Explain what a closure is in JavaScript"
		// Numbered so the body's head ("Instruction 0") cannot recur in the tail.
		const skillContent = Array.from({ length: 200 }, (_, i) => `Instruction ${i}.`).join(" ")
		const expanded = buildSkillCommandPrompt({
			skillName: "diagnosing-bugs",
			remainingText: args,
			skillContent,
		})
		expect(expanded.length).toBeGreaterThan(500)
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: expanded } }])
		const hint = extractFirstUserMessage(ctx as never) ?? ""
		expect(hint).toContain("Invoking skill: diagnosing-bugs")
		expect(hint).toContain(args)
		// The body's head is gone; only its tail can remain ahead of the args.
		expect(hint).not.toContain("Instruction 0.")
		expect(hint.length).toBeLessThanOrEqual(500)
	})

	it("names an ACP skill invocation that has no arguments", () => {
		const skillContent = "Skill instructions. ".repeat(200)
		const expanded = buildSkillCommandPrompt({
			skillName: "gatekeeper",
			remainingText: "",
			skillContent,
		})
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: expanded } }])
		const hint = extractFirstUserMessage(ctx as never) ?? ""
		expect(hint).toContain("Invoking skill: gatekeeper")
		// The hint stays within the cap: invocation header plus at most a
		// bounded tail — never the raw expansion.
		expect(hint.length).toBeLessThanOrEqual(500)
	})

	it("keeps an argument-less ACP invocation stand-alone even behind user context", () => {
		// The persisted ACP rewrite exposes no body/args boundary, so a no-args
		// expansion cannot be told apart from one carrying arguments at the end;
		// both must stand alone to keep that trailing text inside the cap.
		const expanded = buildSkillCommandPrompt({
			skillName: "gatekeeper",
			remainingText: "",
			skillContent: "Skill instructions. ".repeat(200),
		})
		const ctx = createMockCtx([
			{ type: "message", message: { role: "user", content: "Fix the resume menu jumping on scroll" } },
			{ type: "message", message: { role: "user", content: expanded } },
		])
		const hint = extractFirstUserMessage(ctx as never) ?? ""
		expect(hint).toContain("Invoking skill: gatekeeper")
		expect(hint).not.toContain("Fix the resume menu jumping on scroll")
		expect(hint.length).toBeLessThanOrEqual(500)
	})

	it("lets a skill invocation dominate the bundled hint so its arguments survive the cap", () => {
		const args = "Explain what a closure is in JavaScript"
		const expanded = buildSkillCommandPrompt({
			skillName: "diagnosing-bugs",
			remainingText: args,
			skillContent: "Skill instructions. ".repeat(200),
		})
		const ctx = createMockCtx([
			{ type: "message", message: { role: "user", content: "First task about refactoring the parser module" } },
			{ type: "message", message: { role: "user", content: expanded } },
		])
		const hint = extractFirstUserMessage(ctx as never) ?? ""
		// The bundled join would exceed the 500-char cap and cut the trailing
		// arguments, so the invocation must stand alone as the hint.
		expect(hint).toContain(args)
		expect(hint.length).toBeLessThanOrEqual(500)
	})

	it("bundles a name-only skill invocation with neighbouring user context", () => {
		// No args: the hint is the bare skill name, so a task stated in the
		// previous message must survive bundling instead of being discarded.
		const ctx = createMockCtx([
			{ type: "message", message: { role: "user", content: "Fix the resume menu jumping on scroll" } },
			{ type: "message", message: { role: "user", content: nativeSkillBlock() } },
		])
		const hint = extractFirstUserMessage(ctx as never) ?? ""
		expect(hint).toContain("Fix the resume menu jumping on scroll")
		expect(hint).toContain("gatekeeper")
	})

	it("leaves ordinary text byte-faithful, including CRLF line endings", () => {
		const ctx = createMockCtx([
			{ type: "message", message: { role: "user", content: "Fix the parser\r\nand also the lexer" } },
		])
		expect(extractFirstUserMessage(ctx as never)).toBe("Fix the parser\r\nand also the lexer")
	})

	it("sends no concrete example title in the naming system prompt", async () => {
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
			return new Response(JSON.stringify({ choices: [{ message: { content: "Some Title" } }] }), { status: 200 })
		})
		vi.stubGlobal("fetch", fetchMock)
		mockLoadConfig.mockReturnValue({ apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" })
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: "uai como voce ta" } }])
		await suggestSessionName(ctx as never, undefined, true)
		const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
			messages: Array<{ role: string; content: string }>
		}
		const systemPrompt = body.messages.find((m) => m.role === "system")?.content ?? ""
		expect(systemPrompt).not.toContain("Fix resume menu jumping")
		expect(systemPrompt).not.toContain("For example")
	})
})

describe("suggestSessionName", () => {
	it("persists each naming retry before dispatch and pins original work and session", async () => {
		vi.useFakeTimers()
		mockLoadConfig.mockReturnValue({ apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" })
		let sessionId = "original"
		const ctx = createContext({ cwd: attributionDir, sessionManager: { getSessionId: () => sessionId } })
		const workId = getWorkId(ctx)
		const requestIds: string[] = []
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const rows = backendFor(attributionDir)
				.readRecords({ sessionId: "original" })
				.map((row) => JSON.parse(row.body))
			const requestId = new Headers(init?.headers).get("X-Request-Id")
			expect(requestId).toBeTruthy()
			expect(rows.at(-1)).toMatchObject({
				type: "request",
				requestId,
				workId,
				sessionId: "original",
				model: SESSION_NAME_MODEL,
			})
			requestIds.push(String(requestId))
			if (requestIds.length === 1) {
				sessionId = "new-session"
				setWorkId(ctx)
				return new Response("retry", { status: 500 })
			}
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "Name retained" } }],
					id: "chat-title",
					model: "title-model",
					usage: { prompt_tokens: 10, completion_tokens: 2 },
				}),
				{ status: 200 },
			)
		})
		vi.stubGlobal("fetch", fetchMock)
		const pending = suggestSessionName(ctx, "Name this task", true)
		await vi.runAllTimersAsync()
		expect(await pending).toBe("Name retained")
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(new Set(requestIds).size).toBe(2)
		const usage = backendFor(attributionDir)
			.readRecords({})
			.map((row) => JSON.parse(row.body))
			.filter((row) => row.nativeUsage)
		expect(usage.map((row) => [row.requestId, row.workId, row.sessionId, row.nativeUsage.raw])).toEqual([
			[requestIds[0], workId, "original", {}],
			[requestIds[1], workId, "original", { inputTokens: 10, outputTokens: 2 }],
		])
		expect(usage[1].nativeUsage).toMatchObject({ responseId: "chat-title", actualModel: "title-model" })
	})

	it.each(["identity", "request"])("keeps naming available when %s persistence fails", async (stage) => {
		mockLoadConfig.mockReturnValue({ apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" })
		const ctx = createContext({ cwd: attributionDir })
		if (stage === "request") {
			getWorkId(ctx)
			await flushWorkSummaries()
		}
		vi.spyOn(backendFor(attributionDir), "insertRecord").mockImplementation(() => {
			throw new Error("attribution storage unavailable")
		})
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ choices: [{ message: { content: "Still named" } }] })),
		)
		vi.stubGlobal("fetch", fetchMock)
		expect(await suggestSessionName(ctx, "Task", true)).toBe("Still named")
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Work attribution unavailable"), "warning")
	})

	it("names via the SSO credential (bearer + org header) when no API key is configured", async () => {
		// mockLoadConfig returns apiKey "" — auth comes from auth.json.
		const agentDir = process.env.KIMCHI_CODING_AGENT_DIR as string
		mkdirSync(agentDir, { recursive: true })
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: "org-9" } }),
		)
		const ctx = createContext({ cwd: attributionDir })
		const seen: Array<{ headers: Headers }> = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				seen.push({ headers: new Headers(init?.headers) })
				return new Response(JSON.stringify({ choices: [{ message: { content: "SSO named" } }] }), { status: 200 })
			}),
		)
		expect(await suggestSessionName(ctx, "Task", true)).toBe("SSO named")
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer oauth-access")
		expect(seen[0]?.headers.get("x-castai-organization-id")).toBe("org-9")
	})

	it("should fall back to basename when no hint and no user messages", async () => {
		const ctx = createMockCtx([])
		const result = await suggestSessionName(ctx as never, undefined, true)
		expect(result).toBe("my-project")
	})

	it("should use the user message as the normal session name source", async () => {
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: "Hello world" } }])
		const result = await suggestSessionName(ctx as never, undefined, true)
		expect(result).toBe("Hello world")
	})

	it("should use Deepseek Flash v4 for LLM session names", async () => {
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
			return new Response(JSON.stringify({ choices: [{ message: { content: "Review Branch" } }] }), { status: 200 })
		})
		vi.stubGlobal("fetch", fetchMock)
		mockLoadConfig.mockReturnValue({
			apiKey: "test-key",
			llmEndpoint: "https://llm.test/openai/v1",
		})
		const ctx = createMockCtx([{ type: "message", message: { role: "user", content: "Please review this branch" } }])

		const result = await suggestSessionName(ctx as never, undefined, true)

		expect(result).toBe("Review Branch")
		expect(fetchMock).toHaveBeenCalledWith(
			"https://llm.test/openai/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.any(Headers),
			}),
		)
		const init = fetchMock.mock.calls[0]?.[1]
		expect(init).toBeDefined()
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key")
		const body = JSON.parse(init?.body as string) as { model: string }
		expect(body.model).toBe(SESSION_NAME_MODEL)
		expect(body.model).toBe("deepseek-v4-flash-0731")
	})

	it("uses default retries when retry settings omit maxRetries", async () => {
		mockGetRetrySettings.mockReturnValue({ enabled: true, baseDelayMs: 0 })
		mockLoadConfig.mockReturnValue({ apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" })
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Generated caption" } }] }))),
		)
		const ctx = createMockCtx([])

		await expect(suggestSessionName(ctx as never, "Task", true)).resolves.toBe("Generated caption")
	})

	it("should truncate long user messages", async () => {
		const ctx = createMockCtx([
			{
				type: "message",
				message: { role: "user", content: "this is a very long session name that should be truncated" },
			},
		])
		const result = await suggestSessionName(ctx as never, undefined, true)
		expect(result).toBe("this is a very long session name that should be")
	})

	it("should use provided hint instead of extracting from context", async () => {
		const ctx = createMockCtx([])
		const result = await suggestSessionName(ctx as never, "provided hint", true)
		expect(result).toBe("provided hint")
	})

	it("preserves the headless prefix and unchanged UI text for API errors", async () => {
		mockLoadConfig.mockReturnValue({ apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" })
		mockGetRetrySettings.mockReturnValue({ enabled: true, maxRetries: 0, baseDelayMs: 0 })
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("synthetic failure", { status: 500, statusText: "Server Error" })),
		)
		const errorMock = vi.fn()
		vi.stubGlobal("console", { ...console, error: errorMock })
		const headlessCtx = createContext({ cwd: attributionDir, hasUI: false })
		await suggestSessionName(headlessCtx, "Name this task")
		expect(errorMock).toHaveBeenCalledWith("[kimchi] Auto-naming: API error 500 Server Error - synthetic failure")

		const uiCtx = createContext({ cwd: attributionDir })
		await suggestSessionName(uiCtx, "Name this task")
		expect(uiCtx.ui.notify).toHaveBeenCalledWith("Auto-naming: API error 500 Server Error - synthetic failure", "error")
	})

	it("preserves the headless prefix when the naming request throws", async () => {
		mockLoadConfig.mockReturnValue({ apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" })
		mockGetRetrySettings.mockReturnValue({ enabled: true, maxRetries: 0, baseDelayMs: 0 })
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("synthetic network failure"))),
		)
		const errorMock = vi.fn()
		vi.stubGlobal("console", { ...console, error: errorMock })
		const ctx = createContext({ cwd: attributionDir, hasUI: false })
		await suggestSessionName(ctx, "Name this task")
		expect(errorMock).toHaveBeenCalledWith("[kimchi] Auto-naming: synthetic network failure")
	})
})

describe("sessionNameExtension turn_end handler", () => {
	const prompt = "How do I center a div?"
	const generatedTitle = "Center a div with flexbox"

	function generatedResponse(title = generatedTitle): Response {
		return new Response(JSON.stringify({ choices: [{ message: { content: title } }] }), { status: 200 })
	}

	function createTurnHarness(initialPrompt = prompt) {
		mockGetRetrySettings.mockReturnValue({ enabled: true, maxRetries: 0, baseDelayMs: 0 })
		mockLoadConfig.mockReturnValue({ apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" })
		const { api, getHandler } = createExtensionApi()
		const setSessionName = vi.fn()
		api.setSessionName = setSessionName
		const entries = [{ type: "message", message: { role: "user", content: initialPrompt } }]
		const name = vi.fn<() => string | undefined>(() => undefined)
		const ctx = createContext({
			cwd: attributionDir,
			hasUI: false,
			sessionManager: {
				getSessionName: name,
				getBranch: vi.fn().mockImplementation(() => entries),
				getEntries: vi.fn().mockImplementation(() => entries),
			},
		})
		sessionNameExtension()(api)
		return {
			api,
			ctx,
			entries,
			getHandler,
			name,
			setSessionName,
			async endTurn() {
				await getHandler("turn_end")({}, ctx)
				await getHandler("session_shutdown")({}, ctx)
			},
		}
	}

	it("keeps the successful generated-caption control", async () => {
		const fetchMock = vi.fn(async () => generatedResponse())
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()

		await harness.endTurn()

		expect(fetchMock).toHaveBeenCalledOnce()
		expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith(generatedTitle)
	})

	it("retries a non-2xx response without publishing the prompt as a completed caption", async () => {
		const warnMock = vi.fn()
		vi.stubGlobal("console", { ...console, warn: warnMock })
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("secret response body", { status: 503 }))
			.mockImplementation(async () => generatedResponse())
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()

		await harness.endTurn()
		expect(harness.setSessionName).not.toHaveBeenCalled()
		expect(warnMock).toHaveBeenCalledWith(
			"[session-name] auto-caption failed category=http_error status=503 attempt=1 credentials=present",
		)

		await harness.endTurn()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith(generatedTitle)
		const logs = warnMock.mock.calls.flat().join(" ")
		expect(logs).not.toContain(prompt)
		expect(logs).not.toContain("test-key")
		expect(logs).not.toContain("secret response body")
	})

	it("makes no request without credentials and can name after credentials become available", async () => {
		const warnMock = vi.fn()
		vi.stubGlobal("console", { ...console, warn: warnMock })
		let apiKey = ""
		const fetchMock = vi.fn(async () => generatedResponse())
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()
		mockLoadConfig.mockImplementation(() => ({ apiKey, llmEndpoint: "https://llm.test/openai/v1" }))

		for (let attempt = 0; attempt < 3; attempt++) await harness.endTurn()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(harness.setSessionName).not.toHaveBeenCalled()
		expect(warnMock).toHaveBeenCalledExactlyOnceWith(
			"[session-name] auto-caption failed category=missing_credentials attempt=1 credentials=absent",
		)

		apiKey = "credentials-now-available"
		await harness.endTurn()
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith(generatedTitle)
	})

	it.each([
		["transport failure", new Error("connection reset")],
		["empty model response", new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }))],
	])("does not publish prompt text after %s and retries on the next turn", async (_label, failure) => {
		vi.stubGlobal("console", { ...console, warn: vi.fn() })
		const fetchMock = vi.fn().mockImplementationOnce(async () => {
			if (failure instanceof Error) throw failure
			return failure
		})
		fetchMock.mockImplementation(async () => generatedResponse())
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()

		await harness.endTurn()
		expect(harness.setSessionName).not.toHaveBeenCalled()

		await harness.endTurn()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith(generatedTitle)
	})

	it("deduplicates overlapping turn_end events while a caption is in flight", async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const fetchMock = vi.fn(async () => {
			await gate
			return generatedResponse()
		})
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()

		await harness.getHandler("turn_end")({}, harness.ctx)
		await harness.getHandler("turn_end")({}, harness.ctx)
		expect(fetchMock).toHaveBeenCalledOnce()

		release()
		await harness.getHandler("session_shutdown")({}, harness.ctx)
		expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith(generatedTitle)
	})

	it("stops requesting captions after three failed model attempts", async () => {
		vi.stubGlobal("console", { ...console, warn: vi.fn() })
		const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }))
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()

		for (let attempt = 0; attempt < 4; attempt++) await harness.endTurn()

		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(harness.setSessionName).not.toHaveBeenCalled()
	})

	it("resets the retry budget for a new session", async () => {
		vi.stubGlobal("console", { ...console, warn: vi.fn() })
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockImplementation(async () => generatedResponse())
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()

		for (let attempt = 0; attempt < 3; attempt++) await harness.endTurn()
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(harness.setSessionName).not.toHaveBeenCalled()

		await harness.getHandler("session_start")({}, harness.ctx)
		await harness.endTurn()

		expect(fetchMock).toHaveBeenCalledTimes(4)
		expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith(generatedTitle)
	})

	it("counts configuration exceptions toward the retry cap and names after recovery", async () => {
		vi.stubGlobal("console", { ...console, warn: vi.fn() })
		const fetchMock = vi.fn(async () => generatedResponse())
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()
		let configAttempts = 0
		mockLoadConfig.mockImplementation(() => {
			configAttempts += 1
			if (configAttempts <= 2) throw new Error("configuration unavailable")
			return { apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" }
		})

		await harness.endTurn()
		await harness.endTurn()
		await harness.endTurn()

		expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith(generatedTitle)
		expect(fetchMock).toHaveBeenCalledOnce()

		await harness.endTurn()
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it("waits past a greeting and names the task on the next turn", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => generatedResponse("Fix resume menu jumping")),
		)
		const harness = createTurnHarness("Hi!")

		await harness.endTurn()
		expect(harness.setSessionName).not.toHaveBeenCalled()
		harness.entries.push({ type: "message", message: { role: "user", content: "Fix resume menu jumping" } })
		await harness.endTurn()

		expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith("Fix resume menu jumping")
	})

	it("does not apply a late title after switching sessions or overwrite a manual title", async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				await gate
				return generatedResponse("Old task")
			}),
		)
		const harness = createTurnHarness()

		await harness.getHandler("turn_end")({}, harness.ctx)
		await harness.getHandler("session_start")({}, harness.ctx)
		release()
		await harness.getHandler("session_shutdown")({}, harness.ctx)
		expect(harness.setSessionName).not.toHaveBeenCalled()

		harness.name.mockReturnValue("My title")
		await harness.endTurn()
		expect(harness.setSessionName).not.toHaveBeenCalled()
	})

	it("does not overwrite a manual rename made while a caption is in flight", async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const fetchMock = vi.fn(async () => {
			await gate
			return generatedResponse()
		})
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()

		await harness.getHandler("turn_end")({}, harness.ctx)
		harness.name.mockReturnValue("My title")
		release()
		await harness.getHandler("session_shutdown")({}, harness.ctx)

		expect(harness.setSessionName).not.toHaveBeenCalled()
	})

	it("skips auto-captioning when the session already has a name", async () => {
		const fetchMock = vi.fn(async () => generatedResponse())
		vi.stubGlobal("fetch", fetchMock)
		const harness = createTurnHarness()
		harness.name.mockReturnValue("My title")

		await harness.endTurn()

		expect(fetchMock).not.toHaveBeenCalled()
		expect(harness.setSessionName).not.toHaveBeenCalled()
	})
})

describe("sessionNameExtension shutdown", () => {
	function createHarness() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
		const setSessionName = vi.fn()
		const pi = {
			on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
				handlers.set(event, handler)
			},
			setSessionName,
		}
		sessionNameExtension()(pi as never)
		const entries = [{ type: "message", message: { role: "user", content: "Please review this branch" } }]
		const ctx = createContext({
			cwd: "/home/user/my-project",
			hasUI: false,
			sessionManager: {
				getSessionName: () => undefined,
				getBranch: vi.fn().mockReturnValue(entries),
				getEntries: vi.fn().mockReturnValue(entries),
			},
		})
		return { handlers, setSessionName, ctx }
	}

	// turn_end deliberately does not await (a slow listener starves the steering queue), so
	// shutdown is the only place left to keep a one-shot run from exiting mid-request.
	it("waits for an in-flight suggestion before shutting down", async () => {
		let releaseFetch: (() => void) | undefined
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve
		})
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				await fetchGate
				return new Response(JSON.stringify({ choices: [{ message: { content: "Review Branch" } }] }), {
					status: 200,
				})
			}),
		)
		mockLoadConfig.mockReturnValue({ apiKey: "test-key", llmEndpoint: "https://llm.test/openai/v1" })
		const { handlers, setSessionName, ctx } = createHarness()

		handlers.get("turn_end")?.({}, ctx)
		expect(setSessionName).not.toHaveBeenCalled()

		let shutdownSettled = false
		const shutdown = Promise.resolve(handlers.get("session_shutdown")?.({}, ctx)).then(() => {
			shutdownSettled = true
		})
		await Promise.resolve()
		expect(shutdownSettled).toBe(false)

		releaseFetch?.()
		await shutdown

		expect(shutdownSettled).toBe(true)
		expect(setSessionName).toHaveBeenCalledWith("Review Branch")
	})

	it("shuts down immediately when no suggestion is in flight", async () => {
		const { handlers, ctx } = createHarness()

		await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, ctx))).resolves.toBeUndefined()
	})
})
