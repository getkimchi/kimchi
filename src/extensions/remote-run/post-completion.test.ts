import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { authenticateWorkspace } from "../../sandbox/cloud/auth.js"
import type { RemoteSessionMeta } from "../agents/manager/remote-agent-runner.js"
import { runRsync } from "../teleport/provisioning/rsync-runner.js"
import { handleRemoteCompletion, handleRemoteFailure } from "./post-completion.js"

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

// Mock the push/PR layer — consent gating is asserted on these call shapes.
const {
	mockPushBranchRemotely,
	mockPushViaLocalFallback,
	mockPullBranchLocally,
	mockIsPlannotatorReviewAvailable,
	mockRequestPlannotatorCodeReview,
} = vi.hoisted(() => ({
	mockPushBranchRemotely: vi.fn(),
	mockPushViaLocalFallback: vi.fn(),
	mockPullBranchLocally: vi.fn(),
	mockIsPlannotatorReviewAvailable: vi.fn(),
	mockRequestPlannotatorCodeReview: vi.fn(),
}))
vi.mock("./plannotator-review.js", () => ({
	// The channel/id plumbing is the real shared contract from
	// plannotator-review.ts; only the two callables are swapped out.
	PLANNOTATOR_REQUEST_CHANNEL: "plannotator:request",
	newPlannotatorRequestId: () => "kimchi-test-request",
	isPlannotatorReviewAvailable: mockIsPlannotatorReviewAvailable,
	requestPlannotatorCodeReview: mockRequestPlannotatorCodeReview,
}))
const { mockApplyAndPersist, mockSetActive } = vi.hoisted(() => ({
	mockApplyAndPersist: vi.fn(),
	mockSetActive: vi.fn(),
}))
vi.mock("../ferment/tool-helpers.js", () => ({
	createApplyAndPersist: vi.fn(() => mockApplyAndPersist),
}))
vi.mock("../ferment/runtime.js", () => ({
	defaultFermentRuntime: { setActive: mockSetActive, getActive: vi.fn(() => undefined) },
}))

// Mock the SSH diff layer — PR-intent tests never spawn real SSH/git.
const {
	mockResolveSandboxGitConnection,
	mockCollectCompletionDiff,
	mockStreamRemotePatch,
	mockContinueCloudAgent,
	mockDeleteRemoteSession,
	mockRecoverBaseShaFromMergeBase,
} = vi.hoisted(() => ({
	mockResolveSandboxGitConnection: vi.fn(),
	mockCollectCompletionDiff: vi.fn(),
	mockStreamRemotePatch: vi.fn(),
	mockContinueCloudAgent: vi.fn(),
	mockDeleteRemoteSession: vi.fn(),
	mockRecoverBaseShaFromMergeBase: vi.fn(),
}))

vi.mock("./sandbox-git.js", () => ({
	resolveSandboxGitConnection: mockResolveSandboxGitConnection,
	recoverBaseShaFromMergeBase: mockRecoverBaseShaFromMergeBase,
	pushBranchRemotely: mockPushBranchRemotely,
	pushViaLocalFallback: mockPushViaLocalFallback,
	pullBranchLocally: mockPullBranchLocally,
	classifyPushFailure: vi.fn(),
}))
vi.mock("./remote-diff.js", () => ({
	collectCompletionDiff: mockCollectCompletionDiff,
	streamRemotePatch: mockStreamRemotePatch,
}))
vi.mock("./runner.js", () => ({ continueCloudAgent: mockContinueCloudAgent }))
vi.mock("../agents/manager/remote-agent-runner.js", () => ({ deleteRemoteSession: mockDeleteRemoteSession }))

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
		appendEntry: vi.fn(),
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
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(
			"Review the remote agent's results in the local session",
		)

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

	it("injects transcript path even when user picks Sync", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")

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
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(
			"Review the remote agent's results in the local session",
		)

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
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Describe what to do next")
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
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Describe what to do next")
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
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")

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
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")

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
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")

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
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")
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
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", {
				fermentId,
				remoteSession: {
					workspaceId: "ws-1",
					sessionName: "s1",
					wsUrl: "wss://w",
					host: "w",
					cwd: "/home/sandbox/s1",
				},
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
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(
				"Review the remote agent's results in the local session",
			)
			;(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true)

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", { fermentId })

			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, { type: "resume" })
			expect(mockSetActive).toHaveBeenCalled()
		})

		it("does not resume the ferment when user picks Review but declines confirm", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(
				"Review the remote agent's results in the local session",
			)
			;(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", { fermentId })

			expect(mockApplyAndPersist).not.toHaveBeenCalledWith(fermentId, { type: "resume" })
		})

		it("resumes the ferment when user picks Custom and confirms", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Describe what to do next")
			;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("write tests")
			;(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true)

			await handleRemoteCompletion(pi, ctx, "remote result", "ferment plan", { fermentId })

			expect(mockApplyAndPersist).toHaveBeenCalledWith(fermentId, { type: "resume" })
		})

		it("does not call applyAndPersist when no fermentId is provided", async () => {
			const pi = makePi()
			const ctx = makeCtx()
			;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(
				"Review the remote agent's results in the local session",
			)

			await handleRemoteCompletion(pi, ctx, "remote result", "plan")

			expect(mockApplyAndPersist).not.toHaveBeenCalled()
		})
	})
})

describe("handleRemoteFailure", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockApplyAndPersist.mockReturnValue({ ok: false })
	})

	it("shows an error notification instead of the completion dropdown (interactive)", () => {
		const pi = makePi()
		const ctx = makeCtx()

		handleRemoteFailure(pi, ctx, "plan", { error: "workspace unreachable" })

		expect(ctx.ui.select).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith("Remote agent failed: workspace unreachable", "error")
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("includes the recovery note's reason in the interactive notification", () => {
		const pi = makePi()
		const ctx = makeCtx()

		handleRemoteFailure(pi, ctx, "plan", {
			error: "the remote run finished while kimchi was closed and its result could not be recovered — outcome unknown",
			recoveryNote:
				"Recovery failed: the replayed session contained no final assistant message. The result of the remote run is unknown — before re-running or re-dispatching anything, ask the user how to proceed.",
		})

		// Without the reason, this failure mode is undiagnosable from the UI.
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Remote agent failed: the remote run finished while kimchi was closed and its result could not be recovered — outcome unknown — Recovery failed: the replayed session contained no final assistant message",
			"error",
		)
	})

	it("resumes the paused ferment — a failed cloud run must not leave it paused", () => {
		const pi = makePi()
		const ctx = makeCtx()

		handleRemoteFailure(pi, ctx, "ferment plan", { error: "boom", fermentId: "ferment-1" })

		expect(mockApplyAndPersist).toHaveBeenCalledWith("ferment-1", { type: "resume" })
		expect(ctx.ui.notify).toHaveBeenCalledWith("Remote agent failed: boom", "error")
	})

	it("steers the local agent in headless sessions (a notification would be invisible)", () => {
		const pi = makePi()
		const ctx = makeCtx(false)

		handleRemoteFailure(pi, ctx, "plan", {
			error: "result unknown",
			recoveryNote: "Recovery failed: no final assistant message.",
		})

		expect(ctx.ui.notify).not.toHaveBeenCalled()
		const sendMock = pi.sendMessage as ReturnType<typeof vi.fn>
		expect(sendMock).toHaveBeenCalledTimes(1)
		const msg = sendMock.mock.calls[0][0]
		expect(msg.customType).toBe("remote_plan_failed")
		expect(sendMock.mock.calls[0][1]).toEqual({ triggerTurn: true })
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("FAILED")
		expect(content).toContain("result unknown")
		expect(content).toContain("Recovery failed: no final assistant message.")
		expect(content).toContain("Ask the user how to proceed")
	})

	it("still resumes the ferment when no spawn context was captured", () => {
		const pi = makePi()

		handleRemoteFailure(pi, undefined, "ferment plan", { fermentId: "ferment-2" })

		expect(mockApplyAndPersist).toHaveBeenCalledWith("ferment-2", { type: "resume" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("falls back to 'unknown error' when the record has no error message", () => {
		const pi = makePi()
		const ctx = makeCtx()

		handleRemoteFailure(pi, ctx, "plan")

		expect(ctx.ui.notify).toHaveBeenCalledWith("Remote agent failed: unknown error", "error")
	})

	it("skips the interactive notification for user-initiated stops (the kill handler already announced it)", () => {
		const pi = makePi()
		const ctx = makeCtx()

		handleRemoteFailure(pi, ctx, "plan", { stoppedByUser: true })

		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("steers headless agents with stopped-by-user wording instead of failure blame", () => {
		const pi = makePi()
		const ctx = makeCtx(false)

		handleRemoteFailure(pi, ctx, "ferment plan", { stoppedByUser: true, fermentId: "f-1" })

		const sendMock = pi.sendMessage as ReturnType<typeof vi.fn>
		expect(sendMock).toHaveBeenCalledTimes(1)
		const msg = sendMock.mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("stopped by the user")
		expect(content).not.toContain("FAILED")
		expect(content).not.toContain("Error:")
		// The paused ferment is still resumed.
		expect(mockApplyAndPersist).toHaveBeenCalledWith("f-1", { type: "resume" })
	})
})

describe("handleRemoteCompletion — PR intent", () => {
	const tmp = mkdtempSync(join(osTmpdir(), "pr-completion-test-"))
	const CONNECTION = { host: "worker.example.com", remoteUser: "sandbox", authToken: "tok", cwd: "/home/sandbox/acp-x" }
	const GIT = { branch: "kimchi/fix-login", baseBranch: "main", baseSha: "a".repeat(40), dirtyFiles: [] as string[] }
	const REMOTE: RemoteSessionMeta = {
		workspaceId: "ws-1",
		sessionName: "acp-x",
		wsUrl: "wss://worker.example.com",
		host: "worker.example.com",
		cwd: "/home/sandbox/acp-x",
	}
	const STAT = {
		files: 2,
		additions: 8,
		deletions: 3,
		filesList: ["src/a.ts", "src/b.ts"],
		leftoverFiles: [] as string[],
		touchedBaselineFiles: [] as string[],
	}

	type StreamCapture = { onChunk: (v: 1, c: string) => void; patchPath: string | undefined }
	type StreamOutcome = { bytesAppended: number; cancelled: boolean }
	const streams: Array<StreamCapture & { resolve: (v: StreamOutcome) => void }> = []

	beforeEach(() => {
		vi.clearAllMocks()
		streams.length = 0
		mockApplyAndPersist.mockReturnValue({ ok: false })
		mockResolveSandboxGitConnection.mockResolvedValue(CONNECTION)
		mockCollectCompletionDiff.mockResolvedValue({ ...STAT })
		mockPullBranchLocally.mockReturnValue({ kind: "pulled", action: "created" })
		mockIsPlannotatorReviewAvailable.mockReturnValue(true)
		// Default: the reviewer walks away — the plannotator request stays
		// pending and the menu loop blocks (parallel to the old pending server).
		mockRequestPlannotatorCodeReview.mockImplementation(() => new Promise(() => {}))
		mockRecoverBaseShaFromMergeBase.mockResolvedValue(undefined)
		// Mimics the real stream: chunks flow to onChunk AND append to the patch file.
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				const capture: StreamCapture & { resolve: (v: StreamOutcome) => void } = {
					patchPath,
					onChunk: (v, c) => {
						if (patchPath) {
							mkdirSync(dirname(patchPath), { recursive: true })
							appendFileSync(patchPath, c)
						}
						onChunk(v, c)
					},
					resolve: () => {},
				}
				streams.push(capture)
				return {
					cancel: vi.fn(),
					promise: new Promise<StreamOutcome>((resolve) => {
						capture.resolve = resolve
					}),
				}
			},
		)
	})

	it("shows the stat in the dropdown title with Show/Pull/Done entries; Done deletes the session (terminal)", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: join(tmp, "t1", "a.jsonl"),
			remoteSession: REMOTE,
			gitWorkflow: GIT,
		})

		expect(mockResolveSandboxGitConnection).toHaveBeenCalledWith(
			REMOTE,
			"fake-key",
			expect.objectContaining({ endpoint: undefined }),
		)
		expect(mockCollectCompletionDiff).toHaveBeenCalledWith(
			expect.objectContaining({ connection: CONNECTION, baseSha: GIT.baseSha, baselineDirtyFiles: [] }),
		)
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		expect(select).toHaveBeenCalledTimes(1)
		const [title, options] = select.mock.calls[0] as [string, string[]]
		expect(title).toContain("kimchi/fix-login")
		expect(title).toContain("2 files changed, 8 insertions(+), 3 deletions(-)")
		expect(options).toEqual([
			"Review the diff in browser (comment & decide)",
			"Request changes (steer the remote agent)",
			"Push remote changes, pull and continue locally",
			"Pull the changes to my machine and finish",
			"Done",
		])
		// Done is terminal: the session is retired — but no sync, no ferment
		// completion, no result injection (the user accepted nothing).
		expect(runRsync).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.appendEntry).not.toHaveBeenCalled()
		expect(mockDeleteRemoteSession).toHaveBeenCalledWith(
			REMOTE,
			"fake-key",
			expect.objectContaining({ endpoint: undefined }),
		)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("the remote session was deleted"), "info")
	})

	it("renders warning lines for leftover uncommitted files and touched baseline files", async () => {
		mockCollectCompletionDiff.mockResolvedValue({
			...STAT,
			leftoverFiles: ["scratch.txt"],
			touchedBaselineFiles: ["src/user-dirty.ts"],
		})
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession: REMOTE, gitWorkflow: GIT })

		const [title] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
		expect(title).toContain("uncommitted file(s) left on the sandbox: scratch.txt")
		expect(title).toContain("touched file(s) that were already dirty before it started: src/user-dirty.ts")
	})

	it("degrades to today's Sync/Review/Custom menu when the agent committed nothing", async () => {
		mockCollectCompletionDiff.mockResolvedValue(undefined)
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(
			"Review the remote agent's results in the local session",
		)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession: REMOTE, gitWorkflow: GIT })

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("did not commit anything on kimchi/fix-login"),
			"info",
		)
		const [, options] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
		expect(options).toEqual([
			"Pull the changes to my machine and finish",
			"Review the remote agent's results in the local session",
			"Describe what to do next",
		])
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("retries diff collection once when the credential exchange stalls", async () => {
		const abort = new Error("The operation was aborted")
		abort.name = "AbortError"
		mockCollectCompletionDiff.mockRejectedValueOnce(abort).mockResolvedValueOnce({ ...STAT })
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession: REMOTE, gitWorkflow: GIT })

		// Retry surfaced as an info line with the honest timeout wording --
		// never Node's raw "The operation was aborted".
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Diff collection stalled (connection timed out) — retrying once…",
			"info",
		)
		// The retry landed in the PR dropdown, not the degraded menu.
		const [, options] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
		expect(options).toContain("Push remote changes, pull and continue locally")
		expect(mockCollectCompletionDiff).toHaveBeenCalledTimes(2)
	})

	it("degrades to the standard menu when diff collection fails over SSH", async () => {
		mockCollectCompletionDiff.mockRejectedValue(new Error("ssh unreachable"))
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(
			"Review the remote agent's results in the local session",
		)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession: REMOTE, gitWorkflow: GIT })

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Could not collect the remote diff: ssh unreachable"),
			"warning",
		)
		const [, options] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
		expect(options).toContain("Describe what to do next")
	})

	it("degrades honestly when no baseline was captured", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(
			"Review the remote agent's results in the local session",
		)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			gitWorkflow: { branch: "kimchi/fix-login", baseBranch: "main" },
		})

		expect(mockCollectCompletionDiff).not.toHaveBeenCalled()
		expect(mockRecoverBaseShaFromMergeBase).toHaveBeenCalledWith(CONNECTION, "main")
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("no review baseline could be determined"),
			"warning",
		)
	})

	it("recovers the review baseline via merge-base when the pre-run baseline was never captured", async () => {
		mockRecoverBaseShaFromMergeBase.mockResolvedValue("c".repeat(40))
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			gitWorkflow: { branch: "kimchi/fix-login", baseBranch: "main" },
		})

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Review baseline recovered via merge-base with main (the pre-run baseline was never captured).",
			"info",
		)
		expect(mockCollectCompletionDiff).toHaveBeenCalledWith(
			expect.objectContaining({ connection: CONNECTION, baseSha: "c".repeat(40) }),
		)
		// Recovery landed in the PR dropdown, not the degraded menu.
		const [, options] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
		expect(options).toContain("Push remote changes, pull and continue locally")
	})

	it("syncs from the PR menu: rsync + ferment completion + PR-flavoured inject", async () => {
		vi.mocked(authenticateWorkspace).mockResolvedValue({
			connectToken: "fresh-token",
			expiresAt: "",
			wsUrl: "wss://worker.example.com",
			host: "worker.example.com",
		})
		vi.mocked(runRsync).mockResolvedValue({ fileCount: 1, totalBytes: 10, durationMs: 5 })
		mockApplyAndPersist.mockReturnValue({ ok: true, ferment: { id: "f-1", phases: [] } })
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			gitWorkflow: GIT,
			fermentId: "f-1",
		})

		expect(runRsync).toHaveBeenCalledWith(expect.objectContaining({ localPath: "/repo/kimchi", direction: "down" }))
		expect(mockApplyAndPersist).toHaveBeenCalledWith("f-1", { type: "resume" })
		expect(mockApplyAndPersist).toHaveBeenCalledWith("f-1", {
			type: "complete_ferment",
			finalSummary: "Executed in cloud sandbox",
		})
		const msg = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const content = typeof msg.content === "string" ? msg.content : String(msg.content)
		expect(content).toContain("reviewed the remote PR diff and then synced")
	})

	it("dismiss (escape) from the PR menu leaves everything untouched", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			gitWorkflow: GIT,
			fermentId: "f-1",
		})

		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.appendEntry).not.toHaveBeenCalled()
		expect(runRsync).not.toHaveBeenCalled()
		expect(mockApplyAndPersist).not.toHaveBeenCalled()
	})

	it("Request changes dispatches a same-session continuation with the feedback; the session is not deleted", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Request changes (steer the remote agent)")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("Rename the button to Save")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		expect(mockContinueCloudAgent).toHaveBeenCalledTimes(1)
		expect(mockContinueCloudAgent).toHaveBeenCalledWith(pi, ctx, "Rename the button to Save", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
			origin: "plan",
			fermentId: undefined,
		})
		expect(mockDeleteRemoteSession).not.toHaveBeenCalled()
		expect(runRsync).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("empty feedback re-shows the menu instead of steering", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select.mockResolvedValueOnce("Request changes (steer the remote agent)").mockResolvedValueOnce("Done")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("   ")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		expect(select).toHaveBeenCalledTimes(2)
		expect(mockContinueCloudAgent).not.toHaveBeenCalled()
	})

	it("steer degrades honestly when the run's ACP session id is missing", async () => {
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select.mockResolvedValueOnce("Request changes (steer the remote agent)").mockResolvedValueOnce("Done")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("fix something")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			gitWorkflow: GIT,
		})

		expect(mockContinueCloudAgent).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ACP session id was not captured"), "error")
	})

	it("a successful pull deletes the kept session; a failed pull keeps it", async () => {
		vi.mocked(authenticateWorkspace).mockResolvedValue({
			connectToken: "fresh-token",
			expiresAt: "",
			wsUrl: "wss://worker.example.com",
			host: "worker.example.com",
		})
		vi.mocked(runRsync).mockResolvedValue({ fileCount: 1, totalBytes: 10, durationMs: 5 })
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession: REMOTE, gitWorkflow: GIT })
		expect(mockDeleteRemoteSession).toHaveBeenCalledWith(
			REMOTE,
			"fake-key",
			expect.objectContaining({ endpoint: undefined }),
		)

		// Failed pull: the session must survive for a retry/steer.
		mockDeleteRemoteSession.mockClear()
		vi.mocked(runRsync).mockRejectedValue(new Error("rsync connection refused"))
		const pi2 = makePi()
		const ctx2 = makeCtx()
		;(ctx2.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Pull the changes to my machine and finish")

		await handleRemoteCompletion(pi2, ctx2, "remote result", "plan", { remoteSession: REMOTE, gitWorkflow: GIT })
		expect(mockDeleteRemoteSession).not.toHaveBeenCalled()
	})

	it("declining push consent invokes neither the sandbox push nor the local fallback", async () => {
		mockStreamRemotePatch.mockImplementation((opts: { onChunk: (v: 1, chunk: string) => void }) => {
			opts.onChunk(1, "diff --git a/a.ts b/a.ts\n+x\n")
			return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 25, cancelled: false }) }
		})
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Cancel")
			// Dismissed — the consent decline itself terminates nothing.
			.mockResolvedValueOnce(undefined)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
		expect(mockPushViaLocalFallback).not.toHaveBeenCalled()
		expect(mockPullBranchLocally).not.toHaveBeenCalled()
		expect(mockDeleteRemoteSession).not.toHaveBeenCalled()
		expect(select).toHaveBeenCalledTimes(3)
	})

	it("Push remote changes, pull and continue locally: consent, sandbox push, local pull, terminal cleanup", async () => {
		const patch = "diff --git a/a.ts b/a.ts\n+x\n"
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, patch)
				if (patchPath) appendFileSync(patchPath, patch)
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: patch.length, cancelled: false }) }
			},
		)
		mockPushBranchRemotely.mockResolvedValue({ ok: true })
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Push kimchi/fix-login to origin and pull it locally")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		expect(mockPushBranchRemotely).toHaveBeenCalledWith(
			expect.objectContaining({ connection: CONNECTION, branch: "kimchi/fix-login" }),
		)
		expect(mockPullBranchLocally).toHaveBeenCalledWith(expect.objectContaining({ branch: "kimchi/fix-login" }))
		// Plannotator code-review is fired fire-and-forget on the pulled branch.
		expect(pi.events.emit).toHaveBeenCalledWith(
			"plannotator:request",
			expect.objectContaining({
				action: "code-review",
				payload: { cwd: ctx.cwd, defaultBranch: "main" },
			}),
		)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Pushed and pulled — on kimchi/fix-login (created from origin/kimchi/fix-login).",
			"info",
		)
		// Terminal: kept session retires + result is injected into the turn.
		expect(mockDeleteRemoteSession).toHaveBeenCalledWith(
			REMOTE,
			"fake-key",
			expect.objectContaining({ endpoint: undefined }),
		)
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("Push remote changes, pull and continue locally: local-pull failure is honest, manual commands shown, nothing terminated", async () => {
		const patch = "diff --git a/a.ts b/a.ts\n+x\n"
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, patch)
				if (patchPath) appendFileSync(patchPath, patch)
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: patch.length, cancelled: false }) }
			},
		)
		mockPushBranchRemotely.mockResolvedValue({ ok: true })
		mockPullBranchLocally.mockReturnValue({
			kind: "failed",
			reason: "error: untracked working tree files would be overwritten",
			command:
				"git fetch origin kimchi/fix-login && git switch kimchi/fix-login && git merge --ff-only origin/kimchi/fix-login",
		})
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Push kimchi/fix-login to origin and pull it locally")
			// Dismissed — the pull failure itself terminates nothing.
			.mockResolvedValueOnce(undefined)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("the local pull failed: error: untracked working tree files would be overwritten"),
			"error",
		)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("git fetch origin kimchi/fix-login && git switch"),
			"error",
		)
		// The push happened (branch is on origin) but NOTHING was terminated:
		// menu relooped, session still alive after the dismissal.
		expect(mockDeleteRemoteSession).not.toHaveBeenCalled()
	})

	it("Review in browser: approval maps onto the consent-gated push & pull path", async () => {
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, "diff --git a/a b/a\n")
				if (patchPath) appendFileSync(patchPath, "diff --git a/a b/a\n")
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 20, cancelled: false }) }
			},
		)
		mockRequestPlannotatorCodeReview.mockResolvedValue({
			outcome: "decision",
			decision: { kind: "approve" },
		})
		mockPushBranchRemotely.mockResolvedValue({ ok: true })
		mockPullBranchLocally.mockReturnValue({ kind: "pulled", action: "created" })
		mockApplyAndPersist.mockReturnValue({ ok: true, ferment: { id: "f-1", phases: [] } })
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce("Review the diff in browser (comment & decide)")
			.mockResolvedValueOnce("Push kimchi/fix-login to origin and pull it locally")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: join(tmp, "t-review-approve", "agent.jsonl"),
			remoteSession: REMOTE,
			acpSessionId: "acp-X",
			gitWorkflow: GIT,
			fermentId: "f-1",
		})

		// The persisted patch is handed to plannotator's static-patch review.
		expect(mockRequestPlannotatorCodeReview).toHaveBeenCalledWith(
			pi,
			expect.objectContaining({ cwd: ctx.cwd, patchFile: expect.stringContaining("remote-diff.diff") }),
		)
		// Approval does NOT skip consent: the three-way pull gate appeared.
		const consentCall = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string[]]
		expect(consentCall[0]).toBe("Push kimchi/fix-login to origin and pull it locally?")
		expect(consentCall[1]).toEqual([
			"Push kimchi/fix-login to origin and pull it locally",
			"Custom instructions (steer the remote agent)",
			"Cancel",
		])
		expect(mockPushBranchRemotely).toHaveBeenCalled()
		expect(mockPullBranchLocally).toHaveBeenCalledWith(expect.objectContaining({ branch: "kimchi/fix-login" }))
		// Terminal cleanup: kept session deleted, ferment completed, result injected.
		expect(mockDeleteRemoteSession).toHaveBeenCalledWith(
			REMOTE,
			"fake-key",
			expect.objectContaining({ endpoint: undefined }),
		)
		expect(mockApplyAndPersist).toHaveBeenCalledWith("f-1", expect.objectContaining({ type: "complete_ferment" }))
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("Review in browser: request-changes steers the remote agent with the anchored comments", async () => {
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, "diff --git a/a b/a\n")
				if (patchPath) appendFileSync(patchPath, "diff --git a/a b/a\n")
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 20, cancelled: false }) }
			},
		)
		mockRequestPlannotatorCodeReview.mockResolvedValue({
			outcome: "decision",
			decision: {
				kind: "request-changes",
				summary: "almost there",
				comments: [{ file: "src/login.ts", line: 42, side: "new", text: "add a delay here" }],
			},
		})
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Review the diff in browser (comment & decide)")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: join(tmp, "t-review-changes", "agent.jsonl"),
			remoteSession: REMOTE,
			acpSessionId: "acp-X",
			gitWorkflow: GIT,
		})

		const text = mockContinueCloudAgent.mock.calls[0]?.[2] as string
		expect(text).toContain("almost there")
		expect(text).toContain("[src/login.ts:42] add a delay here")
		expect(text).toContain("Address every comment above")
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
	})

	it("Review in browser: cancel returns to the dropdown without side effects", async () => {
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, "diff --git a/a b/a\n")
				if (patchPath) appendFileSync(patchPath, "diff --git a/a b/a\n")
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 20, cancelled: false }) }
			},
		)
		mockRequestPlannotatorCodeReview.mockResolvedValue({
			outcome: "decision",
			decision: { kind: "closed" },
		})
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce("Review the diff in browser (comment & decide)")
			.mockResolvedValueOnce("Done")

		const turned = await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: join(tmp, "t-review-closed", "agent.jsonl"),
			remoteSession: REMOTE,
			gitWorkflow: GIT,
		})

		// Cancel → menu re-showed; Done closed it with NO push/steer side effects.
		expect(ctx.ui.select).toHaveBeenCalledTimes(2)
		expect(mockContinueCloudAgent).not.toHaveBeenCalled()
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
		void turned
	})

	it("Review in browser: without plannotator the menu refuses honestly instead of hanging", async () => {
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, "diff --git a/a b/a\n")
				if (patchPath) appendFileSync(patchPath, "diff --git a/a b/a\n")
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 20, cancelled: false }) }
			},
		)
		mockIsPlannotatorReviewAvailable.mockReturnValue(false)
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce("Review the diff in browser (comment & decide)")
			.mockResolvedValueOnce("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: join(tmp, "t-review-uninstalled", "agent.jsonl"),
			remoteSession: REMOTE,
			gitWorkflow: GIT,
		})

		expect(mockRequestPlannotatorCodeReview).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("@plannotator/pi-extension"), "warning")
		// The refusal happens BEFORE the patch is streamed over SSH.
		expect(mockStreamRemotePatch).not.toHaveBeenCalled()
		// The entry is also hidden from the menu itself (visibility gate) —
		// the mocked select bypassed that by returning the label verbatim,
		// exercising the defensive re-check inside runBrowserReview.
		const [, offered] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
		expect(offered).not.toContain("Review the diff in browser (comment & decide)")
		// Non-terminal: the menu re-showed and Done closed it (terminal).
		expect(ctx.ui.select).toHaveBeenCalledTimes(2)
		expect(mockContinueCloudAgent).not.toHaveBeenCalled()
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
	})

	it("hides the browser-review entry entirely when plannotator is unavailable", async () => {
		mockIsPlannotatorReviewAvailable.mockReturnValue(false)
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", { remoteSession: REMOTE, gitWorkflow: GIT })

		const [, options] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
		expect(options).toEqual([
			"Request changes (steer the remote agent)",
			"Push remote changes, pull and continue locally",
			"Pull the changes to my machine and finish",
			"Done",
		])
	})

	it("Review in browser: a plannotator-side startup error returns to the menu with a warning", async () => {
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, "diff --git a/a b/a\n")
				if (patchPath) appendFileSync(patchPath, "diff --git a/a b/a\n")
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 20, cancelled: false }) }
			},
		)
		mockRequestPlannotatorCodeReview.mockResolvedValue({
			outcome: "error",
			message: "Static patch review requires non-empty unified-diff content.",
		})
		const pi = makePi()
		const ctx = makeCtx()
		;(ctx.ui.select as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce("Review the diff in browser (comment & decide)")
			.mockResolvedValueOnce("Done")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: join(tmp, "t-review-error", "agent.jsonl"),
			remoteSession: REMOTE,
			gitWorkflow: GIT,
		})

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Static patch review requires non-empty unified-diff content"),
			"warning",
		)
		expect(ctx.ui.select).toHaveBeenCalledTimes(2)
		expect(mockContinueCloudAgent).not.toHaveBeenCalled()
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
	})

	it("Review in browser: closing the browser tab settles nothing — the menu stays usable", async () => {
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, "diff --git a/a b/a\n")
				if (patchPath) appendFileSync(patchPath, "diff --git a/a b/a\n")
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 20, cancelled: false }) }
			},
		)
		// plannotator's code-review gate never answers a bare tab close: the
		// request promise stays pending forever (the beforeEach default).
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select.mockResolvedValueOnce("Review the diff in browser (comment & decide)").mockResolvedValueOnce("Done")

		// The menu re-opens only after the review grace (3s) — fake the clock.
		vi.useFakeTimers()
		let finished: Promise<unknown>
		try {
			finished = handleRemoteCompletion(pi, ctx, "remote result", "plan", {
				transcriptPath: join(tmp, "t-review-tab-close", "agent.jsonl"),
				remoteSession: REMOTE,
				acpSessionId: "acp-X",
				gitWorkflow: GIT,
			})
			await vi.advanceTimersByTimeAsync(3_000)
			await finished
		} finally {
			vi.useRealTimers()
		}

		expect(mockRequestPlannotatorCodeReview).toHaveBeenCalledTimes(1)
		// The menu re-offered ALL options while the review stayed pending…
		expect(select).toHaveBeenCalledTimes(2)
		const [, options] = select.mock.calls[1] as [string, string[]]
		expect(options).toEqual([
			"Review the diff in browser (comment & decide)",
			"Request changes (steer the remote agent)",
			"Push remote changes, pull and continue locally",
			"Pull the changes to my machine and finish",
			"Done",
		])
		// …and Done finished the flow (terminal) — never blocked on the dead review.
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("the remote session was deleted"), "info")
		expect(mockDeleteRemoteSession).toHaveBeenCalledTimes(1)
		expect(mockContinueCloudAgent).not.toHaveBeenCalled()
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
	})

	it("Review in browser: a late approval dismisses the open menu and enters the push consent gate", async () => {
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, "diff --git a/a b/a\n")
				if (patchPath) appendFileSync(patchPath, "diff --git a/a b/a\n")
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 20, cancelled: false }) }
			},
		)
		let resolveReview: (value: unknown) => void = () => {}
		mockRequestPlannotatorCodeReview.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveReview = resolve
				}),
		)
		mockPushBranchRemotely.mockResolvedValue({ ok: true })
		mockApplyAndPersist.mockReturnValue({ ok: true, ferment: { id: "f-1", phases: [] } })
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Review the diff in browser (comment & decide)")
			// The real TUI resolves the aborted (dismissed) dialog with undefined.
			.mockImplementationOnce(
				(_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
					new Promise<string | undefined>((resolve) => {
						opts?.signal?.addEventListener("abort", () => resolve(undefined))
					}),
			)
			.mockResolvedValueOnce("Push kimchi/fix-login to origin and pull it locally")

		const finished = handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			transcriptPath: join(tmp, "t-review-late-approve", "agent.jsonl"),
			remoteSession: REMOTE,
			acpSessionId: "acp-X",
			gitWorkflow: GIT,
			fermentId: "f-1",
		})
		// The menu re-opened once the review grace elapsed (real 3s: the
		// grace → open menu → abort sequence is exactly what this test
		// exercises)…
		await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2), { timeout: 10_000 })
		// …then the human approved in the browser.
		resolveReview({ outcome: "decision", decision: { kind: "approve" } })
		await finished

		const consentCall = select.mock.calls[2] as [string, string[]]
		expect(consentCall[0]).toBe("Push kimchi/fix-login to origin and pull it locally?")
		expect(mockPushBranchRemotely).toHaveBeenCalled()
		expect(mockPullBranchLocally).toHaveBeenCalledWith(expect.objectContaining({ branch: "kimchi/fix-login" }))
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("Review in browser: picking the review option twice keeps a single browser session", async () => {
		mockStreamRemotePatch.mockImplementation(
			({ patchPath, onChunk }: { patchPath?: string; onChunk: (v: 1, c: string) => void }) => {
				onChunk(1, "diff --git a/a b/a\n")
				if (patchPath) appendFileSync(patchPath, "diff --git a/a b/a\n")
				return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 20, cancelled: false }) }
			},
		)
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Review the diff in browser (comment & decide)")
			.mockResolvedValueOnce("Review the diff in browser (comment & decide)")
			.mockResolvedValueOnce("Done")

		// The menu re-opens only after the review grace (3s) — fake the clock.
		vi.useFakeTimers()
		try {
			const finished = handleRemoteCompletion(pi, ctx, "remote result", "plan", {
				transcriptPath: join(tmp, "t-review-twice", "agent.jsonl"),
				remoteSession: REMOTE,
				acpSessionId: "acp-X",
				gitWorkflow: GIT,
			})
			await vi.advanceTimersByTimeAsync(3_000)
			await finished
		} finally {
			vi.useRealTimers()
		}

		expect(mockRequestPlannotatorCodeReview).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already open"), "info")
		expect(select).toHaveBeenCalledTimes(3)
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
	})

	it("consent 'Custom instructions' steers the kept-alive remote session instead of pushing", async () => {
		mockStreamRemotePatch.mockImplementation((opts: { onChunk: (v: 1, chunk: string) => void }) => {
			opts.onChunk(1, "diff --git a/a.ts b/a.ts\n+x\n")
			return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 25, cancelled: false }) }
		})
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Custom instructions (steer the remote agent)")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("Add a retry delay before redirecting")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
			fermentId: "f-1",
		})

		// Three-way consent gate: push, custom steer, or Cancel.
		const consentCall = select.mock.calls[1] as [string, string[]]
		expect(consentCall[0]).toBe("Push kimchi/fix-login to origin and pull it locally?")
		expect(consentCall[1]).toEqual([
			"Push kimchi/fix-login to origin and pull it locally",
			"Custom instructions (steer the remote agent)",
			"Cancel",
		])
		// The kept-alive session is steered with the exact input text; NOTHING
		// was pushed and the ferment was NOT completed (the background
		// continuation owns the next completion menu).
		expect(mockContinueCloudAgent).toHaveBeenCalledTimes(1)
		expect(mockContinueCloudAgent).toHaveBeenCalledWith(pi, ctx, "Add a retry delay before redirecting", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
			origin: "plan",
			fermentId: "f-1",
		})
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
		expect(mockPullBranchLocally).not.toHaveBeenCalled()
		expect(mockApplyAndPersist).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("empty input on the custom-instructions path declines without steering", async () => {
		mockStreamRemotePatch.mockImplementation((opts: { onChunk: (v: 1, chunk: string) => void }) => {
			opts.onChunk(1, "diff --git a/a.ts b/a.ts\n+x\n")
			return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 25, cancelled: false }) }
		})
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Custom instructions (steer the remote agent)")
			.mockResolvedValueOnce("Done")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("   ")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		expect(mockContinueCloudAgent).not.toHaveBeenCalled()
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
		// Back to the menu — Done closed it (retires the session); nothing steered.
		expect(select).toHaveBeenCalledTimes(3)
	})

	it("a failed steer from the custom-instructions path returns to the menu without pushing", async () => {
		mockStreamRemotePatch.mockImplementation((opts: { onChunk: (v: 1, chunk: string) => void }) => {
			opts.onChunk(1, "diff --git a/a.ts b/a.ts\n+x\n")
			return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 25, cancelled: false }) }
		})
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Custom instructions (steer the remote agent)")
			.mockResolvedValueOnce("Done")
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("fix something")

		// No acpSessionId → doRequestChanges refuses (steer returns false).
		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			gitWorkflow: GIT,
		})

		expect(mockContinueCloudAgent).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ACP session id was not captured"), "error")
		expect(mockPushBranchRemotely).not.toHaveBeenCalled()
		// Back to the menu — Done closed it (retires the session); nothing pushed.
		expect(select).toHaveBeenCalledTimes(3)
	})

	it("the push & pull consent is a three-way gate: push, custom steer, or Cancel", async () => {
		mockStreamRemotePatch.mockImplementation((opts: { onChunk: (v: 1, chunk: string) => void }) => {
			opts.onChunk(1, "diff --git a/a.ts b/a.ts\n+x\n")
			return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 25, cancelled: false }) }
		})
		mockPushBranchRemotely.mockResolvedValue({ ok: true })
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Push kimchi/fix-login to origin and pull it locally")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		const consentCall = select.mock.calls[1] as [string, string[]]
		expect(consentCall[1]).toEqual([
			"Push kimchi/fix-login to origin and pull it locally",
			"Custom instructions (steer the remote agent)",
			"Cancel",
		])
		expect(mockPushBranchRemotely).toHaveBeenCalledTimes(1)
	})

	it("sandbox push failure offers the local fallback only as an explicit choice", async () => {
		mockStreamRemotePatch.mockImplementation((opts: { onChunk: (v: 1, chunk: string) => void }) => {
			opts.onChunk(1, "diff --git a/a.ts b/a.ts\n+x\n")
			return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 25, cancelled: false }) }
		})
		mockPushBranchRemotely.mockResolvedValue({
			ok: false,
			failure: { kind: "auth", reason: "The sandbox's git credential could not push (read-only or missing)." },
		})
		mockPushViaLocalFallback.mockResolvedValue({ ok: true })
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Push kimchi/fix-login to origin and pull it locally")
			.mockResolvedValueOnce("Push with my local credentials instead")

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		const fallbackCall = select.mock.calls[2] as [string, string[]]
		expect(fallbackCall[0]).toContain("Sandbox push failed (auth)")
		expect(fallbackCall[1]).toEqual(["Push with my local credentials instead", "Cancel"])
		expect(mockPushViaLocalFallback).toHaveBeenCalledTimes(1)
		expect(mockPushViaLocalFallback).toHaveBeenCalledWith(
			expect.objectContaining({
				connection: CONNECTION,
				branch: "kimchi/fix-login",
				localRepo: ctx.cwd,
				apiKey: "fake-key",
			}),
		)
		// Fallback push succeeded → local pull (default mock) → terminal.
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Pushed and pulled — on kimchi/fix-login (created from origin/kimchi/fix-login).",
			"info",
		)
		expect(mockDeleteRemoteSession).toHaveBeenCalledTimes(1)
	})

	it("declining the fallback offer pushes nothing and keeps the branch on the sandbox", async () => {
		mockStreamRemotePatch.mockImplementation((opts: { onChunk: (v: 1, chunk: string) => void }) => {
			opts.onChunk(1, "diff --git a/a.ts b/a.ts\n+x\n")
			return { cancel: vi.fn(), promise: Promise.resolve({ bytesAppended: 25, cancelled: false }) }
		})
		mockPushBranchRemotely.mockResolvedValue({ ok: false, failure: { kind: "transport", reason: "network" } })
		const pi = makePi()
		const ctx = makeCtx()
		const select = ctx.ui.select as ReturnType<typeof vi.fn>
		select
			.mockResolvedValueOnce("Push remote changes, pull and continue locally")
			.mockResolvedValueOnce("Push kimchi/fix-login to origin and pull it locally")
			.mockResolvedValueOnce("Cancel")
			// Dismissed — declining the fallback terminates nothing.
			.mockResolvedValueOnce(undefined)

		await handleRemoteCompletion(pi, ctx, "remote result", "plan", {
			remoteSession: REMOTE,
			acpSessionId: "acp-9",
			gitWorkflow: GIT,
		})

		expect(mockPushViaLocalFallback).not.toHaveBeenCalled()
		expect(mockPullBranchLocally).not.toHaveBeenCalled()
		expect(mockDeleteRemoteSession).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Push declined — nothing was pushed"), "info")
	})
})
