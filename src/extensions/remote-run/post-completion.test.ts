import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { authenticateWorkspace } from "../../sandbox/cloud/auth.js"
import type { RemoteSessionMeta } from "../agents/manager/remote-agent-runner.js"
import { runRsync } from "../teleport/provisioning/rsync-runner.js"
import { handleRemoteCompletion } from "./post-completion.js"

// Mock all external dependencies — we only care about the steer message
// that gets injected into the local session via pi.sendMessage.
vi.mock("../../config.js", () => ({ loadConfig: vi.fn(() => ({ apiKey: "fake-key" })) }))
vi.mock("../../sandbox/cloud/auth.js", () => ({ authenticateWorkspace: vi.fn() }))
vi.mock("../ferment/prompt-ui.js", () => ({ withWorkingHidden: vi.fn((_ui, fn) => fn()) }))
vi.mock("../herdr-events.js", () => ({ withBlocked: vi.fn((_events, _label, fn) => fn()) }))
vi.mock("../steer-marker.js", () => ({ markHarnessSteer: (s: string) => s }))
vi.mock("../teleport/provisioning/constants.js", () => ({ SANDBOX_USER: "sandbox" }))
vi.mock("../teleport/provisioning/rsync-runner.js", () => ({ runRsync: vi.fn() }))
vi.mock("../teleport/provisioning/sync-local-changes.js", () => ({
	DIFF_RSYNC_EXCLUDES: [".git/", ".env", ".env.*", ".envrc", ".kimchi/"],
}))

// Mock the ferment runtime + applyAndPersist so we can assert pause/complete/resume calls
const { mockApplyAndPersist, mockSetActive } = vi.hoisted(() => ({
	mockApplyAndPersist: vi.fn(),
	mockSetActive: vi.fn(),
}))
vi.mock("../ferment/tool-helpers.js", () => ({
	createApplyAndPersist: vi.fn(() => mockApplyAndPersist),
}))
vi.mock("../ferment/runtime.js", () => ({
	defaultFermentRuntime: { setActive: mockSetActive },
}))

function makeCtx(hasUI = true): ExtensionContext {
	return {
		cwd: "/repo/kimchi",
		hasUI,
		ui: {
			select: vi.fn(),
			notify: vi.fn(),
			input: vi.fn(),
			confirm: vi.fn(),
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
		mockApplyAndPersist.mockReturnValue({ ok: false })
	})

	it("always injects transcript path into steer message when user picks Review", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Continue locally with the result")

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

	it("does not inject result when user picks Done", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/transcripts/agent-done.jsonl",
			agentId: "agent-done",
		})

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("injects transcript path even when user picks Sync", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Sync changes and finish")

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

	it("does not inject result when user dismisses (no selection)", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/transcripts/agent-dismiss.jsonl",
			agentId: "agent-dismiss",
		})

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("injects result even when transcriptPath is undefined", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Continue locally with the result")

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
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Give a custom instruction")
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
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Give a custom instruction")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: "/tmp/t.jsonl",
		})

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	describe("syncRemoteChanges", () => {
		const remoteSession: RemoteSessionMeta = {
			workspaceId: "ws-remote-1",
			sessionName: "acp-a1b2c3d4",
			wsUrl: "wss://worker.example.com",
			host: "worker.example.com",
			cwd: "/home/sandbox/kimchi-acp-a1b2c3d4",
		}

		beforeEach(() => {
			vi.mocked(authenticateWorkspace).mockResolvedValue({
				connectToken: "fresh-token",
				expiresAt: "",
				wsUrl: "wss://worker.example.com",
				host: "worker.example.com",
			})
			vi.mocked(runRsync).mockResolvedValue({
				fileCount: 5,
				totalBytes: 12_345,
				durationMs: 1500,
			})
		})

		it("uses remoteSession metadata directly — authenticates with known workspaceId", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Sync changes and finish")

			await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession })

			// Should authenticate with the remoteSession's workspaceId
			expect(authenticateWorkspace).toHaveBeenCalledWith(
				"ws-remote-1",
				"fake-key",
				"kimchi",
				expect.objectContaining({ endpoint: undefined }),
			)
		})

		it("rsyncs from the unique remoteSession.cwd with .git and secrets excluded", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Sync changes and finish")

			await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession })

			expect(runRsync).toHaveBeenCalledWith(
				expect.objectContaining({
					localPath: "/repo/kimchi",
					remotePath: "/home/sandbox/kimchi-acp-a1b2c3d4/",
					direction: "down",
					remoteHost: "worker.example.com",
					deleteExtraneous: false,
					excludeFilters: [".git/", ".env", ".env.*", ".envrc", ".kimchi/"],
				}),
			)
		})

		it("notifies error and does not sync when remoteSession is absent", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Sync changes and finish")

			await handleRemoteCompletion(pi, ctx, "remote result", "plan")

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("remote session metadata is missing"), "error")
			expect(authenticateWorkspace).not.toHaveBeenCalled()
			expect(runRsync).not.toHaveBeenCalled()
			// Result is still injected even after sync failure
			expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		})

		it("notifies error when sync fails", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Sync changes and finish")
			vi.mocked(runRsync).mockRejectedValue(new Error("rsync connection refused"))

			await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession })

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("rsync connection refused"), "error")
			// Result is still injected even after sync failure
			expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		})
	})

	describe("ferment lifecycle", () => {
		const fermentId = "ferment-cloud-1"

		beforeEach(() => {
			mockApplyAndPersist.mockReturnValue({
				ok: true,
				ferment: {
					id: fermentId,
					name: "Cloud Ferment",
					status: "paused",
					phases: [{ id: "phase-1", name: "Phase 1", status: "planned", steps: [] }],
				},
			})
		})

		it("completes the ferment when user picks Sync", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Sync changes and finish")

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", {
				fermentId,
				remoteSession: { workspaceId: "ws-1", sessionName: "s1", wsUrl: "wss://w", host: "w", cwd: "/home/sandbox/s1" },
			})

			// completeFerment resumes, skips non-terminal phases, then completes
			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, { type: "resume" })
			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, {
				type: "skip_phase",
				phaseId: "phase-1",
				reason: "Executed in cloud sandbox",
			})
			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, {
				type: "complete_ferment",
				finalSummary: "Executed in cloud sandbox",
			})
			expect(mockSetActive).toHaveBeenCalled()
		})

		it("resumes the ferment when user picks Review and confirms", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Continue locally with the result")
			;(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true)

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", { fermentId })

			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, { type: "resume" })
			expect(mockSetActive).toHaveBeenCalled()
		})

		it("does not resume the ferment when user picks Review but declines confirm", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Continue locally with the result")
			;(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", { fermentId })

			expect(mockApplyAndPersist).not.toHaveBeenCalledWith(fermentId, { type: "resume" })
		})

		it("completes the ferment when user picks Done", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Done")

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", { fermentId })

			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, { type: "resume" })
			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, {
				type: "complete_ferment",
				finalSummary: "Executed in cloud sandbox",
			})
		})

		it("resumes the ferment when user picks Custom and confirms", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Give a custom instruction")
			;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("write tests")
			;(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true)

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", { fermentId })

			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, { type: "resume" })
		})

		it("does not call applyAndPersist when no fermentId is provided", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Continue locally with the result")

			await handleRemoteCompletion(pi, ctx, "remote result", "plan")

			expect(mockApplyAndPersist).not.toHaveBeenCalled()
		})
	})
})
