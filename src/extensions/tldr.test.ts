import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import tldrExtension, {
	buildActivitySection,
	cleanupAnswer,
	DEFAULT_TLDR_QUESTION,
	describeToolArgs,
	deterministicTldr,
	formatSessionTail,
	requestTldrAnswer,
	TLDR_MODEL,
} from "./tldr.js"

const { mockFetchWithRetry, mockLoadConfig } = vi.hoisted(() => ({
	mockFetchWithRetry: vi.fn(),
	mockLoadConfig: vi.fn(),
}))

vi.mock("../config.js", () => ({
	loadConfig: mockLoadConfig,
}))

vi.mock("../utils/http.js", () => ({
	fetchWithRetry: mockFetchWithRetry,
}))

function setup() {
	const harness = createExtensionApi()
	tldrExtension()(harness.api)
	const command = harness.getRegisteredCommand("tldr")
	return { harness, command }
}

function makeCommandCtx(entries: unknown[] = [], hasUI = true) {
	const notify = vi.fn()
	const base = createCommandContext()
	const ctx = {
		...base,
		hasUI,
		ui: { ...base.ui, notify },
		sessionManager: {
			...base.sessionManager,
			getBranch: vi.fn().mockReturnValue(entries),
		},
	}
	return { ctx, notify }
}

function lastRequestBody(): Record<string, unknown> {
	const init = mockFetchWithRetry.mock.calls[0][1] as { body: string }
	return JSON.parse(init.body) as Record<string, unknown>
}

beforeEach(() => {
	mockLoadConfig.mockReset()
	mockLoadConfig.mockReturnValue({ apiKey: "key-123", llmEndpoint: "https://llm.test/openai/v1" })
	mockFetchWithRetry.mockReset()
	vi.stubEnv("KIMCHI_API_KEY", "")
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("tldr command registration", () => {
	it("registers the command with a description", () => {
		const { command } = setup()
		expect(command.description).toBeTruthy()
	})

	it("subscribes to agent and tool execution events", () => {
		const { harness } = setup()
		expect(harness.getHandler("agent_start")).toBeTruthy()
		expect(harness.getHandler("agent_end")).toBeTruthy()
		expect(harness.getHandler("tool_execution_start")).toBeTruthy()
		expect(harness.getHandler("tool_execution_end")).toBeTruthy()
	})
})

describe("tldr command handler", () => {
	it("answers via the side model and displays the result via notify", async () => {
		const { command } = setup()
		const { ctx, notify } = makeCommandCtx([{ type: "message", message: { role: "user", content: "fix the bug" } }])
		mockFetchWithRetry.mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "  Running the test suite.  " } }] }),
		})

		await command.handler("what are you doing?", ctx)

		expect(mockFetchWithRetry).toHaveBeenCalledTimes(1)
		const [url, init] = mockFetchWithRetry.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; method: string },
		]
		expect(url).toBe("https://llm.test/openai/v1/chat/completions")
		expect(init.method).toBe("POST")
		expect(init.headers.Authorization).toBe("Bearer key-123")
		const body = lastRequestBody()
		expect(body.model).toBe(TLDR_MODEL)
		expect(body.temperature).toBe(0)
		expect(body.max_tokens).toBe(160)
		expect(body).not.toHaveProperty("tools")
		expect((body.messages as Array<{ role: string }>)[0].role).toBe("system")
		expect((body.messages as Array<{ content: string }>)[1].content).toContain("what are you doing?")
		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify).toHaveBeenCalledWith("tldr: Running the test suite.", "info")
	})

	it("uses the default question when no args are given", async () => {
		const { command } = setup()
		const { ctx } = makeCommandCtx()
		mockFetchWithRetry.mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "Idle." } }] }),
		})

		await command.handler("", ctx)

		const body = lastRequestBody()
		expect((body.messages as Array<{ content: string }>)[1].content).toContain(DEFAULT_TLDR_QUESTION)
	})

	it("sends session activity to the side model", async () => {
		const { command } = setup()
		const entries = [
			{ type: "message", message: { role: "user", content: "fix the bug" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: "all passed" }],
					isError: false,
				},
			},
		]
		const { ctx } = makeCommandCtx(entries)
		mockFetchWithRetry.mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "Testing." } }] }),
		})

		await command.handler("", ctx)

		const content = (lastRequestBody().messages as Array<{ content: string }>)[1].content
		expect(content).toContain("user: fix the bug")
		expect(content).toContain('assistant tool call: bash(command="npm test")')
		expect(content).toContain("tool result (bash): all passed")
		expect(content).toContain("The agent is idle.")
	})

	it("does not touch the agent session", async () => {
		const { harness, command } = setup()
		const { ctx } = makeCommandCtx()
		mockFetchWithRetry.mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "Idle." } }] }),
		})

		await command.handler("what?", ctx)

		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(harness.appendEntry).not.toHaveBeenCalled()
	})

	it("falls back deterministically when no API key is available", async () => {
		const { command } = setup()
		mockLoadConfig.mockReturnValue({ apiKey: "", llmEndpoint: "https://llm.test/openai/v1" })
		const { ctx, notify } = makeCommandCtx()

		await command.handler("what?", ctx)

		expect(mockFetchWithRetry).not.toHaveBeenCalled()
		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify).toHaveBeenCalledWith("tldr: No activity in this session yet.", "info")
	})

	it("uses the env API key when the config has none", async () => {
		const { command } = setup()
		mockLoadConfig.mockReturnValue({ apiKey: "", llmEndpoint: "https://llm.test/openai/v1" })
		vi.stubEnv("KIMCHI_API_KEY", "env-key")
		const { ctx } = makeCommandCtx()
		mockFetchWithRetry.mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "Idle." } }] }),
		})

		await command.handler("", ctx)

		const init = mockFetchWithRetry.mock.calls[0][1] as { headers: Record<string, string> }
		expect(init.headers.Authorization).toBe("Bearer env-key")
	})

	it("falls back deterministically when the side call fails", async () => {
		const { command } = setup()
		const { ctx, notify } = makeCommandCtx()
		mockFetchWithRetry.mockRejectedValue(new Error("boom"))

		await command.handler("", ctx)

		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify.mock.calls[0][0]).toMatch(/^tldr: /)
	})

	it("falls back deterministically when the side call returns a non-ok response", async () => {
		const { command } = setup()
		const { ctx, notify } = makeCommandCtx()
		mockFetchWithRetry.mockResolvedValue({ ok: false })

		await command.handler("", ctx)

		expect(notify).toHaveBeenCalledWith("tldr: No activity in this session yet.", "info")
	})

	it("reports in-flight tools in the deterministic fallback", async () => {
		const { harness, command } = setup()
		mockLoadConfig.mockReturnValue({ apiKey: "", llmEndpoint: "https://llm.test/openai/v1" })
		const { ctx, notify } = makeCommandCtx()

		await harness.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "npm test" },
		})
		await command.handler("", ctx)
		expect(notify.mock.calls[0][0]).toMatch(/Running bash\(command="npm test"\) for \d+s\./)

		await harness.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: "",
			isError: false,
		})
		await command.handler("", ctx)
		expect(notify.mock.calls[1][0]).not.toContain("Running bash")
	})

	it("reports the model streaming state in the deterministic fallback", async () => {
		const { harness, command } = setup()
		mockLoadConfig.mockReturnValue({ apiKey: "", llmEndpoint: "https://llm.test/openai/v1" })
		const { ctx, notify } = makeCommandCtx()

		await harness.emit("agent_start", { type: "agent_start" })
		await command.handler("", ctx)
		expect(notify.mock.calls[0][0]).toContain("Working on a response.")

		await harness.emit("agent_end", { type: "agent_end" })
		await command.handler("", ctx)
		expect(notify.mock.calls[1][0]).toContain("No activity in this session yet.")
	})

	it("does not notify when no UI is available", async () => {
		const { command } = setup()
		mockLoadConfig.mockReturnValue({ apiKey: "", llmEndpoint: "https://llm.test/openai/v1" })
		const { ctx, notify } = makeCommandCtx([], false)

		await command.handler("", ctx)

		expect(notify).not.toHaveBeenCalled()
	})
})

describe("requestTldrAnswer", () => {
	it("normalises the endpoint URL and returns null on empty choices", async () => {
		mockLoadConfig.mockReturnValue({ apiKey: "k", llmEndpoint: "https://llm.test/openai/v1/" })
		mockFetchWithRetry.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) })
		const ctx = createContext()

		expect(await requestTldrAnswer(ctx, "question", "activity")).toBeNull()
		expect(mockFetchWithRetry.mock.calls[0][0]).toBe("https://llm.test/openai/v1/chat/completions")
	})

	it("returns null without an API key", async () => {
		mockLoadConfig.mockReturnValue({ apiKey: "", llmEndpoint: "https://llm.test/openai/v1" })
		const ctx = createContext()

		expect(await requestTldrAnswer(ctx, "question", "activity")).toBeNull()
		expect(mockFetchWithRetry).not.toHaveBeenCalled()
	})
})

describe("formatSessionTail", () => {
	it("formats user text, assistant text, tool calls, and tool results", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "fix the login bug" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "let me look" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: "all passed" }],
					isError: false,
				},
			},
			{ type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } },
		]

		expect(formatSessionTail(entries)).toEqual([
			"user: fix the login bug",
			"assistant: let me look",
			'assistant tool call: bash(command="npm test")',
			"tool result (bash): all passed",
		])
	})

	it("marks error tool results", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: "file not found",
					isError: true,
				},
			},
		]

		expect(formatSessionTail(entries)).toEqual(["error (read): file not found"])
	})

	it("caps the tail at 14 entries", () => {
		const entries = Array.from({ length: 20 }, (_, i) => ({
			type: "message",
			message: { role: "user", content: `message ${i}` },
		}))

		const tail = formatSessionTail(entries)
		expect(tail).toHaveLength(14)
		expect(tail[0]).toBe("user: message 6")
		expect(tail[13]).toBe("user: message 19")
	})

	it("ignores malformed entries", () => {
		expect(formatSessionTail([null, {}, { type: "message" }, { type: "message", message: {} }])).toEqual([])
	})

	it("truncates long user text", () => {
		const entries = [{ type: "message", message: { role: "user", content: "a".repeat(400) } }]
		const [line] = formatSessionTail(entries)
		expect(line?.length).toBeLessThanOrEqual(210)
		expect(line?.endsWith("…")).toBe(true)
	})
})

describe("describeToolArgs", () => {
	it("prefers command-like keys and caps at two parts", () => {
		expect(describeToolArgs({ command: "npm test", path: "/tmp/x", pattern: "foo" })).toBe(
			'command="npm test" path="/tmp/x"',
		)
	})

	it("ignores non-string values and unknown shapes", () => {
		expect(describeToolArgs({ timeout: 5000, retries: 2 })).toBe("")
		expect(describeToolArgs(null)).toBe("")
		expect(describeToolArgs("bash")).toBe("")
	})

	it("truncates long values", () => {
		expect(describeToolArgs({ command: "a".repeat(200) })).toBe(`command="${"a".repeat(80)}…"`)
	})
})

describe("cleanupAnswer", () => {
	it("collapses whitespace and strips wrapping quotes", () => {
		expect(cleanupAnswer('  "Running\n\ntests."  ')).toBe("Running tests.")
	})

	it("caps the answer length", () => {
		const long = "word ".repeat(200)
		expect(cleanupAnswer(long).length).toBeLessThanOrEqual(401)
	})
})

describe("buildActivitySection", () => {
	it("lists in-flight tools with elapsed seconds and recent activity", () => {
		const section = buildActivitySection(
			["user: hi"],
			[{ toolName: "bash", argsSummary: 'command="npm test"', elapsedMs: 46000 }],
			true,
		)

		expect(section).toContain("Currently executing tools:")
		expect(section).toContain('- bash(command="npm test") — running for 46s')
		expect(section).toContain("Recent activity (oldest first):")
		expect(section).toContain("user: hi")
	})

	it("reports model streaming when the turn is active without tools", () => {
		expect(buildActivitySection([], [], true)).toContain("generating a response")
	})

	it("reports idle otherwise", () => {
		expect(buildActivitySection([], [], false)).toContain("The agent is idle.")
	})
})

describe("deterministicTldr", () => {
	it("describes the latest in-flight tool with the preceding activity", () => {
		const text = deterministicTldr(
			["user: fix bug", "tool result (bash): ok"],
			[{ toolName: "read", argsSummary: 'path="/a.ts"', elapsedMs: 3000 }],
			true,
		)

		expect(text).toMatch(/^Running read\(path="\/a\.ts"\) for 3s\./)
		expect(text).toContain("Before that: tool result (bash): ok")
	})

	it("counts additional in-flight tools", () => {
		const tools = [
			{ toolName: "bash", argsSummary: 'command="npm test"', elapsedMs: 3000 },
			{ toolName: "read", argsSummary: 'path="/b.ts"', elapsedMs: 1000 },
		]
		expect(deterministicTldr([], tools, true)).toBe('Running read(path="/b.ts") for 1s, plus 1 more tool.')
	})

	it("says idle with the last activity", () => {
		expect(deterministicTldr(["user: hi"], [], false)).toBe("Idle. Last activity: user: hi")
	})

	it("reports waiting on the model mid-turn without tools", () => {
		expect(deterministicTldr(["user: hi"], [], true)).toContain("Waiting on the model's response.")
	})

	it("handles the empty session", () => {
		expect(deterministicTldr([], [], false)).toBe("No activity in this session yet.")
	})
})
