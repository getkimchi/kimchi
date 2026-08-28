import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleRemoteCompletion } from "./post-completion.js"

// Mock all external dependencies — we only care about the steer message
// that gets injected into the local session via pi.sendMessage.
vi.mock("../../config.js", () => ({ loadConfig: vi.fn(() => ({ apiKey: "fake-key" })) }))
vi.mock("../../sandbox/cloud/auth.js", () => ({ authenticateWorkspace: vi.fn() }))
vi.mock("../../sandbox/cloud/workspaces.js", () => ({ listWorkspaces: vi.fn(() => []) }))
vi.mock("../ferment/prompt-ui.js", () => ({ withWorkingHidden: vi.fn((_ui, fn) => fn()) }))
vi.mock("../herdr-events.js", () => ({ withBlocked: vi.fn((_events, _label, fn) => fn()) }))
vi.mock("../steer-marker.js", () => ({ markHarnessSteer: (s: string) => s }))
vi.mock("../teleport/provisioning/constants.js", () => ({ SANDBOX_USER: "sandbox" }))
vi.mock("../teleport/provisioning/rsync-runner.js", () => ({ runRsync: vi.fn() }))

function makeCtx(hasUI = true): ExtensionContext {
	return {
		cwd: "/repo/kimchi",
		hasUI,
		ui: {
			select: vi.fn(),
			notify: vi.fn(),
			input: vi.fn(),
		},
	} as unknown as ExtensionContext
}

function makePi(): ExtensionAPI & { _sentMessages: { content: string }[] } {
	const sentMessages: { content: string }[] = []
	return {
		sendMessage: vi.fn((msg: { content: string }) => {
			sentMessages.push({ content: typeof msg.content === "string" ? msg.content : String(msg.content) })
		}),
		events: { emit: vi.fn() },
		_sentMessages: sentMessages,
	} as unknown as ExtensionAPI & { _sentMessages: { content: string }[] }
}

describe("handleRemoteCompletion", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("always injects transcript path into steer message when user picks Review", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Review the result and continue locally")

		await handleRemoteCompletion(pi, ctx, "remote result text", "plan", {
			transcriptPath: "/tmp/transcripts/agent-1.jsonl",
			agentId: "agent-1",
		})

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("/tmp/transcripts/agent-1.jsonl")
		expect(content).toContain("Agent ID: agent-1")
		expect(content).toContain("remote result text")
	})

	it("injects transcript path even when user picks Done", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/transcripts/agent-done.jsonl",
			agentId: "agent-done",
		})

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("/tmp/transcripts/agent-done.jsonl")
	})

	it("injects transcript path even when user picks Sync", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Sync remote changes")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/transcripts/agent-sync.jsonl",
			agentId: "agent-sync",
		})

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("/tmp/transcripts/agent-sync.jsonl")
		expect(content).toContain("synced the remote changes")
	})

	it("injects transcript path even when user dismisses (no selection)", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/transcripts/agent-dismiss.jsonl",
			agentId: "agent-dismiss",
		})

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("/tmp/transcripts/agent-dismiss.jsonl")
	})

	it("injects result even when transcriptPath is undefined", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Review the result and continue locally")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan")

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("remote result")
		// No transcript line should be present
		expect(content).not.toContain("Full transcript")
	})

	it("injects result without UI (non-interactive session)", async () => {
		const pi = makePi()
		const ctx = makeCtx(false)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/t.jsonl",
			agentId: "a1",
		})

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("/tmp/t.jsonl")
		expect(content).toContain("Agent ID: a1")
	})

	it("injects custom action text when user picks Custom", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Type your own action")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("write a summary")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/t.jsonl",
			agentId: "a1",
		})

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("The user wants you to: write a summary")
		expect(content).toContain("/tmp/t.jsonl")
	})

	it("does not inject when user picks Custom but cancels input", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Type your own action")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/t.jsonl",
		})

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})
})
