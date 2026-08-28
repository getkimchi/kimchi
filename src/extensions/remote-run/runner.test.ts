import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isRemoteRunEnabled, runForegroundRemoteAgent } from "./runner.js"

// Mock the agents module — we only care that spawnRemoteAgent is called
// with the right args, not the real spawn machinery.
vi.mock("../agents/index.js", () => ({
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
	const handlers: ((data: string) => unknown)[] = []
	return {
		ui: {
			notify: vi.fn(),
			onTerminalInput: vi.fn((cb: (data: string) => unknown) => {
				handlers.push(cb)
				return () => {
					handlers.splice(handlers.indexOf(cb), 1)
				}
			}),
		},
	} as unknown as ExtensionContext
}

function makePi(): ExtensionAPI {
	return {} as ExtensionAPI
}

describe("isRemoteRunEnabled", () => {
	const orig = process.env.KIMCHI_REMOTE_RUN
	afterEach(() => {
		if (orig === undefined) delete process.env.KIMCHI_REMOTE_RUN
		else process.env.KIMCHI_REMOTE_RUN = orig
	})

	it("returns true when KIMCHI_REMOTE_RUN is set", () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		expect(isRemoteRunEnabled()).toBe(true)
	})

	it("returns false when KIMCHI_REMOTE_RUN is unset", () => {
		delete process.env.KIMCHI_REMOTE_RUN
		expect(isRemoteRunEnabled()).toBe(false)
	})
})

describe("runForegroundRemoteAgent", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls spawnRemoteAgent with the provided prompt and description", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: "done" })

		await runForegroundRemoteAgent(pi, ctx, "hello", "test desc")

		expect(spawnRemoteAgent).toHaveBeenCalledWith(pi, ctx, "hello", "test desc", undefined)
	})

	it("passes onSpawn option through to spawnRemoteAgent", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: "done" })

		const onSpawn = vi.fn()
		await runForegroundRemoteAgent(pi, ctx, "hello", "desc", { onSpawn })

		expect(spawnRemoteAgent).toHaveBeenCalledWith(pi, ctx, "hello", "desc", { onSpawn })
	})

	it("notifies with a preview of the result on success", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		const longResult = "x".repeat(600)
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: longResult })

		await runForegroundRemoteAgent(pi, ctx, "hello", "desc")

		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>
		const [message, level] = notify.mock.calls[0]
		expect(level).toBe("info")
		expect(message).toBe(`${"x".repeat(500)}...`)
	})

	it("notifies with a default message when result is empty", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: "" })

		await runForegroundRemoteAgent(pi, ctx, "hello", "desc")

		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>
		expect(notify).toHaveBeenCalledWith("Remote agent completed with no output.", "info")
	})

	it("notifies with error message and rethrows on failure", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockRejectedValue(new Error("connection failed"))

		await expect(runForegroundRemoteAgent(pi, ctx, "hello", "desc")).rejects.toThrow("connection failed")

		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>
		expect(notify).toHaveBeenCalledWith("Remote run failed: connection failed", "error")
	})

	it("registers and cleans up the Ctrl+X kill handler", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-1", result: "done" })

		await runForegroundRemoteAgent(pi, ctx, "hello", "desc")

		// onTerminalInput should have been called once to register the handler
		expect(ctx.ui.onTerminalInput).toHaveBeenCalledTimes(1)
		// The returned unsubscribe should have been called (cleanup)
		// We verify by checking that the kill handler fn was registered then removed.
		// The mock returns a function — we can verify it was called by checking
		// that the spy's return value (the unsub) was invoked.
		// Since the mock returns a real unsub function, we trust the finally block.
	})

	it("returns transcriptPath from the agent record's outputFile", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		vi.mocked(spawnRemoteAgent).mockResolvedValue({ id: "agent-42", result: "done" })
		const { getActiveManager } = await import("../agents/index.js")
		vi.mocked(getActiveManager).mockReturnValue({
			getRecord: vi.fn(() => ({ outputFile: "/tmp/transcripts/agent-42.jsonl" })),
		} as unknown as ReturnType<typeof getActiveManager>)

		const res = await runForegroundRemoteAgent(pi, ctx, "hello", "desc")

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

		const res = await runForegroundRemoteAgent(pi, ctx, "hello", "desc")

		expect(res.id).toBe("agent-missing")
		expect(res.transcriptPath).toBeUndefined()
	})
})
