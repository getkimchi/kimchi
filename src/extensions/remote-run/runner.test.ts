import os from "node:os"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isRemoteRunEnabled, runCloudAgent } from "./runner.js"

// Mock the agents module — we only care that spawnRemoteAgent is called
// with the right args, not the real spawn machinery.
vi.mock("../agents/index.js", () => ({
	buildRemoteExecutionStats: vi.fn(() => ({
		duration_ms: 0,
		tool_calls: 0,
		input_tokens: 0,
		output_tokens: 0,
	})),
	getActiveManager: vi.fn(),
	spawnRemoteAgent: vi.fn(),
}))

vi.mock("../shared-input.js", () => ({
	isRawInputCaptureActive: vi.fn(() => false),
}))

vi.mock("../agents/ui/agent-widget.js", () => ({
	getDisplayName: vi.fn(() => "Remote-Runner"),
}))

const { spawnRemoteAgent } = await import("../agents/index.js")

function makeCtx(): ExtensionContext {
	return {
		ui: {
			notify: vi.fn(),
			onTerminalInput: vi.fn(),
		},
	} as unknown as ExtensionContext
}

function makePi(): ExtensionAPI {
	return { sendMessage: vi.fn() } as unknown as ExtensionAPI
}

describe("isRemoteRunEnabled", () => {
	const orig = process.env.KIMCHI_REMOTE_RUN
	afterEach(() => {
		if (orig === undefined) delete process.env.KIMCHI_REMOTE_RUN
		else process.env.KIMCHI_REMOTE_RUN = orig
		vi.unstubAllEnvs()
	})

	it("returns true when KIMCHI_REMOTE_RUN is unset (enabled by default)", () => {
		delete process.env.KIMCHI_REMOTE_RUN
		expect(isRemoteRunEnabled()).toBe(true)
	})

	it("returns true for legacy opt-in values", () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		expect(isRemoteRunEnabled()).toBe(true)
		process.env.KIMCHI_REMOTE_RUN = "true"
		expect(isRemoteRunEnabled()).toBe(true)
		process.env.KIMCHI_REMOTE_RUN = " true "
		expect(isRemoteRunEnabled()).toBe(true)
	})

	it("treats empty string as unset", () => {
		process.env.KIMCHI_REMOTE_RUN = ""
		expect(isRemoteRunEnabled()).toBe(true)
	})

	it("returns false when KIMCHI_REMOTE_RUN explicitly disables it", () => {
		process.env.KIMCHI_REMOTE_RUN = "0"
		expect(isRemoteRunEnabled()).toBe(false)
		process.env.KIMCHI_REMOTE_RUN = "false"
		expect(isRemoteRunEnabled()).toBe(false)
		process.env.KIMCHI_REMOTE_RUN = "FALSE"
		expect(isRemoteRunEnabled()).toBe(false)
		process.env.KIMCHI_REMOTE_RUN = "False"
		expect(isRemoteRunEnabled()).toBe(false)
		process.env.KIMCHI_REMOTE_RUN = " false "
		expect(isRemoteRunEnabled()).toBe(false)
	})

	it("returns false inside the sandbox cluster", () => {
		delete process.env.KIMCHI_REMOTE_RUN
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		expect(isRemoteRunEnabled()).toBe(false)
	})

	it("returns false on Windows", () => {
		delete process.env.KIMCHI_REMOTE_RUN
		const osTypeMock = vi.spyOn(os, "type").mockReturnValue("Windows_NT")
		try {
			expect(isRemoteRunEnabled()).toBe(false)
		} finally {
			osTypeMock.mockRestore()
		}
	})
})

describe("runCloudAgent", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls spawnRemoteAgent with the provided prompt and description", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: "done" })

		await runCloudAgent(pi, ctx, "hello", "test desc")

		expect(spawnRemoteAgent).toHaveBeenCalledWith(pi, ctx, "hello", "test desc", undefined)
	})

	it("passes options through to spawnRemoteAgent", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: "done" })

		const opts = { background: true }
		await runCloudAgent(pi, ctx, "hello", "desc", opts)

		expect(spawnRemoteAgent).toHaveBeenCalledWith(pi, ctx, "hello", "desc", opts)
	})

	it("notifies with a preview of the result on foreground success", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		const longResult = "x".repeat(600)
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: longResult })

		await runCloudAgent(pi, ctx, "hello", "desc")

		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>
		const [message, level] = notify.mock.calls[0]
		expect(level).toBe("info")
		expect(message).toBe(`${"x".repeat(500)}...`)
	})

	it("notifies with a default message when result is empty", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: "" })

		await runCloudAgent(pi, ctx, "hello", "desc")

		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>
		expect(notify).toHaveBeenCalledWith("Remote agent completed with no output.", "info")
	})

	it("does not register a Ctrl+X handler (handled by agents extension)", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: "done" })

		await runCloudAgent(pi, ctx, "hello", "desc")

		// runCloudAgent no longer registers its own onTerminalInput handler
		expect(ctx.ui.onTerminalInput).not.toHaveBeenCalled()
	})

	it("returns transcriptPath from the agent record's outputFile", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-42", result: "done" })
		const { getActiveManager } = await import("../agents/index.js")
		vi.mocked(getActiveManager).mockReturnValue({
			getRecord: vi.fn(() => ({ outputFile: "/tmp/transcripts/agent-42.jsonl" })),
		} as unknown as ReturnType<typeof getActiveManager>)

		const res = await runCloudAgent(pi, ctx, "hello", "desc")

		expect(res.id).toBe("agent-42")
		expect(res.transcriptPath).toBe("/tmp/transcripts/agent-42.jsonl")
	})

	it("returns undefined transcriptPath when record is not found", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-missing", result: "done" })
		const { getActiveManager } = await import("../agents/index.js")
		vi.mocked(getActiveManager).mockReturnValue({
			getRecord: vi.fn(() => undefined),
		} as unknown as ReturnType<typeof getActiveManager>)

		const res = await runCloudAgent(pi, ctx, "hello", "desc")

		expect(res.id).toBe("agent-missing")
		expect(res.transcriptPath).toBeUndefined()
	})

	it("returns backgrounded=true and skips notification when spawnRemoteAgent returns backgrounded", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({
			id: "agent-bg",
			result: "backgrounded",
			backgrounded: true,
		})

		const res = await runCloudAgent(pi, ctx, "hello", "desc")

		expect(res.backgrounded).toBe(true)
		expect(res.id).toBe("agent-bg")
		// Should show a 'started in background' notification
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cloud agent started in background. You'll be notified when it completes.",
			"info",
		)
		// Should trigger a new turn so the LLM can acknowledge
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "cloud_agent_started" }), {
			triggerTurn: true,
		})
	})
})
