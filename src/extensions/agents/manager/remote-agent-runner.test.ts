import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// All external dependencies are mocked at the module level.
vi.mock("../../../sandbox/cloud/auth.js", () => ({
	authenticateWorkspace: vi.fn().mockResolvedValue({
		connectToken: "test-token",
		expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		wsUrl: "wss://worker.example.com",
		host: "worker.example.com",
	}),
}))

vi.mock("../../../sandbox/cloud/readiness.js", () => ({
	waitForWorkspaceReady: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../sandbox/worker/client.js", () => ({
	WorkerClient: vi.fn().mockImplementation(() => ({
		close: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("../../../sandbox/worker/sessions.js", () => ({
	createSession: vi.fn().mockResolvedValue(undefined),
	deleteSession: vi.fn().mockResolvedValue(undefined),
	getSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../teleport/provisioning/git-provision.js", () => ({
	provisionGitCredential: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../teleport/provisioning/sync-local-changes.js", () => ({
	syncLocalChangesAfterClone: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../remote-run/session-recovery.js", () => ({
	appendTranscriptGapMarker: vi.fn().mockResolvedValue(undefined),
}))

// Mock AcpSessionClient so we don't need a real WebSocket.
// We capture the options passed to the constructor so tests can inspect callbacks.
const mockInitialize = vi.fn().mockResolvedValue(undefined)
const mockPrompt = vi.fn().mockResolvedValue({
	stopReason: "end_turn",
	usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
})
const mockClose = vi.fn()
const mockCancel = vi.fn().mockResolvedValue(undefined)
const mockForceDisconnect = vi.fn()

let capturedOptions: Record<string, unknown> | undefined
/** Load-replay notifications served by mocked AcpSessionClient instances. */
let mockLoadReplay: Array<{ update: Record<string, unknown> }> = []

// RemoteConnectionError is defined inside the mock factory below so that the
// `instanceof RemoteConnectionError` check in the module under test resolves to
// the SAME class the test throws. (vi.mock factories cannot reference top-level
// imports — they are hoisted above them.)
vi.mock("../../../sandbox/worker/acp-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../sandbox/worker/acp-client.js")>()
	class RemoteConnectionError extends Error {
		constructor(message: string, options?: { cause?: unknown }) {
			super(message, options)
			this.name = "RemoteConnectionError"
		}
	}
	return {
		AcpSessionClient: vi.fn().mockImplementation((options: Record<string, unknown>) => {
			capturedOptions = options
			return {
				// The replay-recovery client (captureLoadReplay) gets its own
				// always-resolving initialize so per-test mockInitialize chains
				// (built for the reattach flow) don't break the replay.
				initialize: options.captureLoadReplay ? vi.fn().mockResolvedValue(undefined) : mockInitialize,
				prompt: mockPrompt,
				close: mockClose,
				cancel: mockCancel,
				forceDisconnect: mockForceDisconnect,
			}
		}),
		RemoteConnectionError,
		// Pure helper — use the real implementation (unit-tested in acp-client.test.ts).
		extractFinalAssistantText: actual.extractFinalAssistantText,
	}
})

// Import after mocks are set up
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { waitForWorkspaceReady } from "../../../sandbox/cloud/readiness.js"
import {
	AcpSessionClient,
	type AcpSessionClientOptions,
	RemoteConnectionError,
} from "../../../sandbox/worker/acp-client.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { createSession, deleteSession, getSession } from "../../../sandbox/worker/sessions.js"
import { WorkerError } from "../../../sandbox/worker/types.js"
import { appendTranscriptGapMarker } from "../../remote-run/session-recovery.js"
import { provisionGitCredential } from "../../teleport/provisioning/git-provision.js"
import { syncLocalChangesAfterClone } from "../../teleport/provisioning/sync-local-changes.js"
import {
	type AttachRemoteAgentOptions,
	attachRemoteAgent,
	isRemoteSessionConnected,
	type RemoteRunOptions,
	type RemoteSessionMeta,
	runRemoteAgent,
} from "./remote-agent-runner.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-123"
const PROMPT = "Fix the bug in auth.ts"

function makeOptions(overrides: Partial<RemoteRunOptions> = {}): RemoteRunOptions {
	return {
		apiKey: "test-api-key",
		signal: undefined,
		callbacks: {
			onTextDelta: vi.fn(),
			onToolActivity: vi.fn(),
			onTurnEnd: vi.fn(),
			onAssistantUsage: vi.fn(),
		},
		...overrides,
	}
}

/** getSession impl: turn "running" for the first `runningFor` polls, then
 *  quiet — quiesce-grace recovery then finishes the run instead of polling
 *  a live turn forever. */
function quietRunningFor(runningFor: number) {
	let polls = 0
	return async () => ({
		name: "s",
		agentMode: "ACP" as const,
		yolo: true,
		alive: true,
		agentRunning: ++polls <= runningFor,
		clientConnected: false,
		connectedThroughBridge: false,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	capturedOptions = undefined
	// Re-establish mock implementations after clearAllMocks resets them
	vi.mocked(authenticateWorkspace).mockResolvedValue({
		connectToken: "test-token",
		expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		wsUrl: "wss://worker.example.com",
		host: "worker.example.com",
	})
	vi.mocked(waitForWorkspaceReady).mockResolvedValue(undefined)
	vi.mocked(createSession).mockResolvedValue({
		name: "test-session",
		agentMode: "ACP",
		yolo: true,
		cwd: "/home/sandbox",
		alive: true,
		agentRunning: false,
		clientConnected: false,
		connectedThroughBridge: false,
		freshClone: true,
	})
	vi.mocked(deleteSession).mockResolvedValue(undefined)
	vi.mocked(syncLocalChangesAfterClone).mockResolvedValue(undefined)
	// Default: a healthy, still-running session — poll loop keeps going, recovery isn't triggered.
	vi.mocked(getSession).mockResolvedValue({
		name: "test-session",
		agentMode: "ACP",
		yolo: true,
		alive: true,
		agentRunning: true,
		clientConnected: true,
		connectedThroughBridge: false,
		freshClone: false,
	})
	vi.mocked(appendTranscriptGapMarker).mockResolvedValue(undefined)
	// Re-establish the AcpSessionClient constructor mock — clearAllMocks
	// resets the mockImplementation, so new AcpSessionClient() would return undefined.
	vi.mocked(AcpSessionClient).mockImplementation((options: AcpSessionClientOptions) => {
		capturedOptions = options as unknown as Record<string, unknown>
		return {
			// The replay-recovery client (captureLoadReplay) gets its own
			// always-resolving initialize so per-test mockInitialize chains
			// (built for the reattach flow) don't break the replay.
			initialize: options.captureLoadReplay ? vi.fn().mockResolvedValue(undefined) : mockInitialize,
			prompt: mockPrompt,
			close: mockClose,
			cancel: mockCancel,
			forceDisconnect: mockForceDisconnect,
			get loadReplay() {
				return mockLoadReplay
			},
			sessionId: "remote-acp-1",
		} as unknown as AcpSessionClient
	})
	vi.mocked(WorkerClient).mockImplementation(
		() =>
			({
				close: vi.fn().mockResolvedValue(undefined),
				// biome-ignore lint/suspicious/noExplicitAny: mock
			}) as any,
	)
	mockInitialize.mockResolvedValue(undefined)
	mockPrompt.mockResolvedValue({
		stopReason: "end_turn",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
	})
	mockClose.mockReset()
	mockCancel.mockReset().mockResolvedValue(undefined)
	// Default replay content so recovery tests get the standard result text
	// via the real extractFinalAssistantText over the mocked loadReplay.
	mockLoadReplay = [
		{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Recovered result text" } } },
	]
})

afterEach(() => {
	vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRemoteAgent", () => {
	it("authenticates, creates session, initializes ACP client, sends prompt, and returns result", async () => {
		const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())

		// 1. Authentication
		expect(authenticateWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, "test-api-key", "kimchi", { endpoint: undefined })

		// 2. Readiness check
		expect(waitForWorkspaceReady).toHaveBeenCalledWith(
			expect.objectContaining({
				wsUrl: "wss://worker.example.com",
				connectToken: "test-token",
			}),
		)

		// 3. Session creation — cwd is NOT sent; the worker assigns /home/sandbox/<sessionName>
		const sessionNameMatch = expect.stringMatching(/^acp-[0-9a-f]{8}$/)
		expect(createSession).toHaveBeenCalledWith(
			expect.anything(),
			sessionNameMatch,
			expect.objectContaining({
				agentMode: "ACP",
				yolo: true,
			}),
			expect.objectContaining({ timeoutMs: 10 * 60_000 }),
		)

		// 4. ACP client — cwd matches the unique session directory
		expect(AcpSessionClient).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionName: sessionNameMatch,
				credentials: expect.objectContaining({ wsUrl: "wss://worker.example.com" }),
				cwd: expect.stringMatching(/^\/home\/sandbox\/acp-[0-9a-f]{8}$/),
			}),
		)
		expect(mockInitialize).toHaveBeenCalledOnce()
		expect(mockPrompt).toHaveBeenCalledWith(PROMPT)

		// 5. Result — remoteSession includes the unique cwd
		expect(result.stopReason).toBe("end_turn")
		expect(result.usage).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 })
		expect(result.remoteSession.workspaceId).toBe(WORKSPACE_ID)
		expect(result.remoteSession.wsUrl).toBe("wss://worker.example.com")
		expect(result.remoteSession.host).toBe("worker.example.com")
		expect(result.remoteSession.sessionName).toMatch(/^acp-[0-9a-f]{8}$/)
		expect(result.remoteSession.cwd).toMatch(/^\/home\/sandbox\/acp-[0-9a-f]{8}$/)
	})

	it("forwards callbacks to AcpSessionClient with onTextDelta wrapping", async () => {
		const onTextDelta = vi.fn()
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ callbacks: { onTextDelta } }))

		expect(capturedOptions).toBeDefined()
		const callbacks = capturedOptions?.callbacks as
			| { onTextDelta: (delta: string, fullText: string) => void }
			| undefined
		expect(callbacks).toBeDefined()
		if (!callbacks) return
		expect(typeof callbacks.onTextDelta).toBe("function")

		// Simulate a text delta — the wrapper should update responseText and forward to inner callback
		callbacks.onTextDelta("Hello", "Hello")
		expect(onTextDelta).toHaveBeenCalledWith("Hello", "Hello")
	})

	it("captures accumulated response text via wrapped onTextDelta", async () => {
		const onTextDelta = vi.fn()
		// Make mock prompt simulate streaming by invoking the captured onTextDelta
		// callback before resolving — mirrors real ACP behavior.
		mockPrompt.mockImplementation(async () => {
			const cb = capturedOptions?.callbacks as { onTextDelta: (delta: string, fullText: string) => void } | undefined
			if (!cb) return
			cb.onTextDelta("Hello ", "Hello ")
			cb.onTextDelta("world", "Hello world")
			return { stopReason: "end_turn", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } }
		})

		const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ callbacks: { onTextDelta } }))

		expect(result.responseText).toBe("Hello world")
	})

	it("captures responseText even when no callbacks are provided", async () => {
		// Make mock prompt simulate streaming by invoking the captured onTextDelta
		// callback before resolving — mirrors real ACP behavior.
		mockPrompt.mockImplementation(async () => {
			const cb = capturedOptions?.callbacks as { onTextDelta: (delta: string, fullText: string) => void } | undefined
			if (!cb) return
			cb.onTextDelta("no callback text", "no callback text")
			return { stopReason: "end_turn", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } }
		})

		const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ callbacks: undefined }))

		expect(result.responseText).toBe("no callback text")
	})

	it("closes AcpSessionClient and deletes session on success", async () => {
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())

		expect(mockClose).toHaveBeenCalledOnce()
		expect(deleteSession).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^acp-/))
	})

	it("closes AcpSessionClient but does NOT delete session on error (deferred deletion)", async () => {
		mockPrompt.mockRejectedValue(new Error("prompt failed"))

		await expect(runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())).rejects.toThrow("prompt failed")

		// AcpSessionClient must still be closed
		expect(mockClose).toHaveBeenCalled()
		// Deletion is deferred — error paths never delete so the session survives for inspection/recovery
		expect(deleteSession).not.toHaveBeenCalled()
	})

	it("closes WorkerClient when createSession throws", async () => {
		vi.mocked(createSession).mockRejectedValue(new Error("create failed"))
		const mockClientClose = vi.fn().mockResolvedValue(undefined)
		vi.mocked(WorkerClient).mockImplementation(
			() =>
				({
					close: mockClientClose,
					// biome-ignore lint/suspicious/noExplicitAny: mock
				}) as any,
		)

		await expect(runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())).rejects.toThrow("create failed")

		// WorkerClient must still be closed even though createSession threw
		expect(mockClientClose).toHaveBeenCalledOnce()
	})

	it("closes WorkerClient in the finally block", async () => {
		const mockClientClose = vi.fn().mockResolvedValue(undefined)
		vi.mocked(WorkerClient).mockImplementation(
			() =>
				({
					close: mockClientClose,
					// biome-ignore lint/suspicious/noExplicitAny: mock
				}) as any,
		)

		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())

		expect(mockClientClose).toHaveBeenCalledOnce()
	})

	it("does not throw if session deletion fails during cleanup", async () => {
		vi.mocked(deleteSession).mockRejectedValue(new Error("delete failed"))

		// Should not throw — deleteSession error is swallowed
		const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())
		expect(result.stopReason).toBe("end_turn")
	})

	it("passes endpoint option to authenticateWorkspace", async () => {
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ endpoint: "https://custom.endpoint" }))

		expect(authenticateWorkspace).toHaveBeenCalledWith(
			WORKSPACE_ID,
			"test-api-key",
			"kimchi",
			expect.objectContaining({ endpoint: "https://custom.endpoint" }),
		)
	})

	it("forwards resources to authenticateWorkspace when provided", async () => {
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ resources: { cpu: "250m", memory: "1Gi" } }))

		expect(authenticateWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, "test-api-key", "kimchi", {
			endpoint: undefined,
			resources: { cpu: "250m", memory: "1Gi" },
		})
	})

	it("omits the resources key when not provided", async () => {
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())

		expect(authenticateWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, "test-api-key", "kimchi", {
			endpoint: undefined,
		})
	})

	it("passes signal through to createSession and AcpSessionClient", async () => {
		const controller = new AbortController()
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ signal: controller.signal }))

		expect(createSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ signal: controller.signal }),
		)
		expect(capturedOptions).toBeDefined()
		expect(capturedOptions?.signal).toBe(controller.signal)
	})

	it("forwards onToolActivity, onTurnEnd, onAssistantUsage, onRawNotification, onContextUsage callbacks", async () => {
		const callbacks = {
			onToolActivity: vi.fn(),
			onTurnEnd: vi.fn(),
			onAssistantUsage: vi.fn(),
			onRawNotification: vi.fn(),
			onContextUsage: vi.fn(),
		}
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ callbacks }))

		const captured = capturedOptions?.callbacks as Record<string, (...args: unknown[]) => void> | undefined
		expect(captured).toBeDefined()
		if (!captured) return
		expect(typeof captured.onToolActivity).toBe("function")
		expect(typeof captured.onTurnEnd).toBe("function")
		expect(typeof captured.onAssistantUsage).toBe("function")
		expect(typeof captured.onRawNotification).toBe("function")
		expect(typeof captured.onContextUsage).toBe("function")

		// Verify forwarding
		captured.onToolActivity({ status: "completed", toolName: "Read" })
		expect(callbacks.onToolActivity).toHaveBeenCalledWith({ status: "completed", toolName: "Read" })

		captured.onTurnEnd(1)
		expect(callbacks.onTurnEnd).toHaveBeenCalledWith(1)

		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
		captured.onAssistantUsage(usage)
		expect(callbacks.onAssistantUsage).toHaveBeenCalledWith(usage)

		const rawNotif = { update: { sessionUpdate: "tool_call" } }
		captured.onRawNotification(rawNotif)
		expect(callbacks.onRawNotification).toHaveBeenCalledWith(rawNotif)

		captured.onContextUsage(5000, 128000)
		expect(callbacks.onContextUsage).toHaveBeenCalledWith(5000, 128000)
	})

	it("forwards gitDetails to createSession with targetDirectory cleared so clone goes into session cwd", async () => {
		const gitDetails = {
			repo: "https://github.com/getkimchi/kimchi.git",
			branch: "main",
			targetDirectory: "kimchi",
			noHistory: true,
		}
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ gitDetails }))

		expect(createSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringMatching(/^acp-/),
			expect.objectContaining({
				agentMode: "ACP",
				yolo: true,
				details: {
					git: {
						repo: gitDetails.repo,
						branch: gitDetails.branch,
						targetDirectory: "",
						noHistory: true,
					},
				},
			}),
			expect.anything(),
		)

		// AcpSessionClient receives the unique session cwd
		expect(capturedOptions).toBeDefined()
		expect(capturedOptions?.cwd).toMatch(/^\/home\/sandbox\/acp-[0-9a-f]{8}$/)
	})

	it("omits details.git when no gitDetails are provided", async () => {
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())

		const sessionReq = vi.mocked(createSession).mock.calls[0]?.[2] as unknown as Record<string, unknown>
		expect(sessionReq.details).toBeUndefined()
	})

	it("syncs local changes after createSession with unique remotePath when gitDetails + localPath are provided", async () => {
		const gitDetails = {
			repo: "https://github.com/getkimchi/kimchi.git",
			branch: "main",
			targetDirectory: "kimchi",
			noHistory: true,
		}
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ gitDetails, localPath: "/work/kimchi" }))

		expect(syncLocalChangesAfterClone).toHaveBeenCalledWith(
			expect.objectContaining({
				localPath: "/work/kimchi",
				remotePath: expect.stringMatching(/^\/home\/sandbox\/acp-[0-9a-f]{8}$/),
				remoteHost: "worker.example.com",
				freshClone: true,
			}),
		)
	})

	it("does not sync local changes when gitDetails is not provided", async () => {
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ localPath: "/work/kimchi" }))

		expect(syncLocalChangesAfterClone).not.toHaveBeenCalled()
	})

	it("does not sync local changes when localPath is not provided", async () => {
		const gitDetails = {
			repo: "https://github.com/getkimchi/kimchi.git",
			branch: "main",
			targetDirectory: "kimchi",
			noHistory: true,
		}
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ gitDetails }))

		expect(syncLocalChangesAfterClone).not.toHaveBeenCalled()
	})

	describe("git credential provisioning", () => {
		beforeEach(() => {
			vi.mocked(provisionGitCredential).mockResolvedValue(undefined)
		})

		it("provisions git credential before createSession when gitCredential is provided", async () => {
			const gitCredential = { host: "gitlab.com", token: "glpat-xyz123" }
			const gitDetails = {
				repo: "https://gitlab.com/team/repo.git",
				branch: "main",
				targetDirectory: "repo",
				noHistory: true,
			}
			await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ gitDetails, gitCredential }))

			expect(provisionGitCredential).toHaveBeenCalledWith(
				expect.anything(),
				{ gitHost: "gitlab.com", gitToken: "glpat-xyz123" },
				undefined,
			)

			// provisionGitCredential must be called BEFORE createSession
			const provisionOrder = vi.mocked(provisionGitCredential).mock.invocationCallOrder[0]
			const createOrder = vi.mocked(createSession).mock.invocationCallOrder[0]
			expect(provisionOrder).toBeLessThan(createOrder)
		})

		it("does not provision git credential when gitCredential is not provided", async () => {
			await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())

			expect(provisionGitCredential).not.toHaveBeenCalled()
		})

		it("does not abort the run when credential provisioning fails", async () => {
			vi.mocked(provisionGitCredential).mockRejectedValue(new Error("provisioning failed"))
			const gitCredential = { host: "gitlab.com", token: "bad-token" }
			const gitDetails = {
				repo: "https://gitlab.com/team/repo.git",
				branch: "main",
				targetDirectory: "repo",
				noHistory: true,
			}

			// Should not throw — provisioning failure is non-fatal
			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ gitDetails, gitCredential }))

			expect(result.stopReason).toBe("end_turn")
			// createSession was still called
			expect(createSession).toHaveBeenCalledOnce()
		})

		it("re-throws AbortError when signal is aborted during provisioning", async () => {
			const abortErr = new Error("aborted")
			abortErr.name = "AbortError"
			vi.mocked(provisionGitCredential).mockRejectedValue(abortErr)
			const gitCredential = { host: "gitlab.com", token: "tok" }

			await expect(runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ gitCredential }))).rejects.toThrow("aborted")

			// createSession must NOT have been called — abort should stop the run
			expect(createSession).not.toHaveBeenCalled()
		})
	})

	describe("onReady callback", () => {
		it("is called after initialize() and before prompt()", async () => {
			const callOrder: string[] = []
			mockInitialize.mockImplementation(async () => {
				callOrder.push("initialize")
			})
			mockPrompt.mockImplementation(async () => {
				callOrder.push("prompt")
				return { stopReason: "end_turn", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } }
			})
			const onReady = vi.fn(() => {
				callOrder.push("onReady")
			})

			await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ onReady }))

			expect(callOrder).toEqual(["initialize", "onReady", "prompt"])
		})

		it("passes the AcpSessionClient and session metadata", async () => {
			const onReady = vi.fn()
			await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ onReady }))

			expect(onReady).toHaveBeenCalledTimes(1)
			const [client, meta] = onReady.mock.calls[0]
			// client should have prompt/close/cancel methods (the mock instance)
			expect(typeof client.prompt).toBe("function")
			expect(typeof client.close).toBe("function")
			expect(meta).toEqual({
				workspaceId: WORKSPACE_ID,
				sessionName: expect.stringMatching(/^acp-[0-9a-f]{8}$/),
				wsUrl: "wss://worker.example.com",
				host: "worker.example.com",
				cwd: expect.stringMatching(/^\/home\/sandbox\/acp-[0-9a-f]{8}$/),
			})
		})

		it("is not called when omitted", async () => {
			// Should not throw — onReady is optional
			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())
			expect(result.stopReason).toBe("end_turn")
		})
	})

	// -----------------------------------------------------------------
	// Resilience / recovery state machine
	// -----------------------------------------------------------------

	describe("disconnect recovery", () => {
		// Use fast backoffs so tests don't wait real seconds.
		const FAST_BACKOFFS = [10, 20, 40]
		// Small quiesce window so the settle-grace path recovers quickly.
		const GRACE = 30
		// Fast status-poll cadence. Watch-only polling sleeps at the poll
		// interval (not the backoff schedule), so recovery tests MUST override
		// the 15s default or they'd wait real seconds per watch tick.
		const FAST_POLL = 10

		function makeRecoveryOptions(overrides: Partial<RemoteRunOptions> = {}): RemoteRunOptions {
			return makeOptions({
				reconnectBackoffsMs: FAST_BACKOFFS,
				turnSettleGraceMs: GRACE,
				pollIntervalMs: FAST_POLL,
				...overrides,
			})
		}

		/** Runs the agent and fires the turn-end signal once the reattached
		 *  client (constructed with the onForeignResponse hook) exists — the
		 *  realistic exit for recovery tests that reattach, since the quiesce
		 *  no longer fires while attached. */
		async function runUntilTurnEnd(options: RemoteRunOptions) {
			const runPromise = runRemoteAgent(WORKSPACE_ID, PROMPT, options)
			await vi.waitFor(() => expect(capturedOptions?.onForeignResponse).toBeTypeOf("function"))
			;(capturedOptions as { onForeignResponse: (response: unknown) => void }).onForeignResponse({ id: 4, result: {} })
			return runPromise
		}

		it("reattaches to the EXISTING session via load (never new, never re-prompts)", async () => {
			// The remote agent is still running the original turn when the
			// connection drops. On reattach the runner must attach to the same
			// ACP session (session/load) and watch the live turn — re-sending
			// the prompt would restart the task from scratch and duplicate
			// effects. Recovery fires once the turn goes quiet.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WebSocket closed"))
			vi.mocked(getSession).mockImplementation(quietRunningFor(1))

			const result = await runUntilTurnEnd(makeRecoveryOptions())

			// Attached session's turn is owned by the dead connection; the
			// result comes from the remote session transcript instead.
			expect(result.stopReason).toBe("recovered")
			expect(result.responseText).toBe("Recovered result text")
			// The prompt was sent exactly once — never re-sent after reattach.
			expect(mockPrompt).toHaveBeenCalledOnce()
			// The reattach client was constructed to resume the same ACP session.
			expect(capturedOptions?.sessionId).toBe("remote-acp-1")
			// Re-auth happened for the reattach and once more before the recovery
			// fetch (stale connect tokens make rsync fail mid-recovery).
			expect(authenticateWorkspace).toHaveBeenCalledTimes(3)
			// Session was deleted after the successful recovery completion.
			expect(deleteSession).toHaveBeenCalledOnce()
			// Attached exactly once (original new-session init + one load), then
			// watched the turn — no repeated attach attempts.
			expect(mockInitialize).toHaveBeenCalledTimes(2)
		})

		it("waits without burning reconnect attempts when session/load reports a turn in progress", async () => {
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			// The original turn is STILL in flight when the first reattach
			// happens — load rejects with "turn in progress". The runner must
			// wait (getSession continues to report the session alive) and retry,
			// not treat this as a failed reattach attempt.
			mockInitialize.mockReset()
			mockInitialize
				.mockResolvedValueOnce(undefined) // initial newSession init
				.mockRejectedValueOnce(new Error("session remote-acp-1 has a turn in progress; cancel it first"))
				.mockResolvedValue(undefined) // second reattach init succeeds
			vi.mocked(getSession).mockImplementation(quietRunningFor(2))

			const result = await runUntilTurnEnd(makeRecoveryOptions())

			expect(result.stopReason).toBe("recovered")
			// Two reattach initializations happened (retry after the in-flight
			// rejection), plus the original new-session initialize.
			expect(mockInitialize).toHaveBeenCalledTimes(3)
			// Turn-in-progress did not consume the 3-attempt budget — the run
			// still recovered successfully.
			expect(mockPrompt).toHaveBeenCalledOnce()
		})

		it("recovers the partial transcript when reattach attempts exhaust with the session still alive", async () => {
			// Real-world repro: the remote process died mid-turn (or its stdio
			// bridge wedged) — load attempts time out as RemoteConnectionError.
			// Instead of failing with "result unknown", the runner must recover
			// whatever the remote transcript holds (marked with a recovery note).
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			mockInitialize.mockReset()
			mockInitialize
				.mockResolvedValueOnce(undefined) // initial newSession init
				.mockRejectedValue(new RemoteConnectionError("loadSession timed out after 30000ms"))
			vi.mocked(getSession).mockResolvedValue({
				name: "s",
				agentMode: "ACP",
				yolo: true,
				alive: true,
				agentRunning: false,
				clientConnected: false,
				connectedThroughBridge: false,
			})

			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ reconnectBackoffsMs: [10, 20, 40] }))

			expect(result.stopReason).toBe("recovered")
			expect(result.responseText).toBe("Recovered result text")
			// Attach was retried across the full budget (3 reattach inits + 1
			// original new-session init) before giving up on the live session.
			expect(mockInitialize).toHaveBeenCalledTimes(4)
			expect(mockPrompt).toHaveBeenCalledOnce()
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("keeps watching without recovering or deleting when reattach exhausts while the agent is still running", async () => {
			// The other side of the exhaustion boundary: the load attempts time out
			// but the worker still reports the agent running. The turn may still be
			// doing real work — the runner must NOT recover (or delete) a live
			// session; it switches to watch-only polling until the turn finishes or
			// quiesces, and only then recovers.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			mockInitialize.mockReset()
			mockInitialize
				.mockResolvedValueOnce(undefined) // initial newSession init
				.mockRejectedValue(new RemoteConnectionError("loadSession timed out after 30000ms"))
			// Running for the first 6 polls (the 3 failed attach attempts plus a
			// few watch ticks), then the turn finishes server-side.
			let polls = 0
			let servedFinished = false
			vi.mocked(getSession).mockImplementation(async () => {
				polls++
				const running = polls <= 6
				if (!running) servedFinished = true
				return {
					name: "s",
					agentMode: "ACP" as const,
					yolo: true,
					alive: true,
					agentRunning: running,
					clientConnected: false,
					connectedThroughBridge: false,
					finishedAt: running ? undefined : new Date().toISOString(),
				}
			})

			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions())

			// Watch-only kept polling until the finished status was actually
			// served — no premature recovery while the turn was live.
			expect(servedFinished).toBe(true)
			expect(result.stopReason).toBe("recovered")
			// The attach budget stayed exhausted (1 original + 3 failed reattach
			// inits) — watch-only never re-attaches.
			expect(mockInitialize).toHaveBeenCalledTimes(4)
			// Nothing was deleted while watching; deletion happens with the recovery.
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("keeps waiting for a genuinely in-flight turn instead of cancelling it", async () => {
			// Same load rejection, but the worker still reports the agent
			// running → the turn may legitimately finish server-side. The runner
			// must NOT cancel it — wait and retry the load as before.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			mockInitialize.mockReset()
			mockInitialize
				.mockResolvedValueOnce(undefined) // initial newSession init
				.mockRejectedValueOnce(new Error("session remote-acp-1 has a turn in progress; cancel it first"))
				.mockResolvedValue(undefined) // next reattach succeeds
			vi.mocked(getSession).mockImplementation(quietRunningFor(2))

			const result = await runUntilTurnEnd(makeRecoveryOptions())

			expect(result.stopReason).toBe("recovered")
			// Recovery NEVER cancels a turn — it might still be doing real work
			// (agentRunning flickers false between pi-mono chained prompt calls).
			expect(mockCancel).not.toHaveBeenCalled()
		})

		it("recovers via transcript when the turn stays quiet past the settle grace (ACP bookkeeping never unwinds)", async () => {
			// Real-world repro (20:54 run): after a laptop-side disconnect the
			// remote pi agent turn ENDED (worker: agentRunning=false, stable for
			// minutes) but session/load kept rejecting with "turn in progress"
			// forever — the ACP turn bookkeeping wedges without its owning client.
			// Waiting for load to succeed is a dead end; recovery must fire once
			// the turn has been continuously quiet past turnSettleGraceMs.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			mockInitialize.mockReset()
			mockInitialize
				.mockResolvedValueOnce(undefined) // initial newSession init
				.mockRejectedValue(new Error("session remote-acp-1 has a turn in progress; cancel it first"))
			const quietStatus = {
				name: "s",
				agentMode: "ACP" as const,
				yolo: true,
				alive: true,
				agentRunning: false,
				clientConnected: false,
				connectedThroughBridge: false,
			}
			vi.mocked(getSession).mockResolvedValue(quietStatus)

			const result = await runRemoteAgent(
				WORKSPACE_ID,
				PROMPT,
				makeOptions({ reconnectBackoffsMs: [10, 20, 40], turnSettleGraceMs: 30 }),
			)

			expect(result.stopReason).toBe("recovered")
			expect(result.responseText).toBe("Recovered result text")
			// No waiting for an attach that can never succeed, no cancel ever.
			expect(mockCancel).not.toHaveBeenCalled()
			expect(mockPrompt).toHaveBeenCalledOnce()
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("keeps waiting when the quiet window is interrupted by real turn activity", async () => {
			// agentRunning flickers false between chained pi-mono prompt calls —
			// a brief quiet dip must NOT trigger recovery. Quiessence resets when
			// the turn resumes; the runner waits for the load to succeed instead.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			mockInitialize.mockReset()
			mockInitialize
				.mockResolvedValueOnce(undefined) // initial newSession init
				.mockRejectedValueOnce(new Error("session remote-acp-1 has a turn in progress; cancel it first"))
				.mockRejectedValueOnce(new Error("session remote-acp-1 has a turn in progress; cancel it first"))
				.mockResolvedValue(undefined) // third reattach succeeds
			const runningStatus = {
				name: "s",
				agentMode: "ACP" as const,
				yolo: true,
				alive: true,
				clientConnected: false,
				connectedThroughBridge: false,
			}
			let polls = 0
			vi.mocked(getSession).mockImplementation(async () => {
				polls++
				// First poll: quiet dip (false). Polls 2–3: turn resumed. From
				// poll 4 (after attach): quiet for good → quiesce recovery fires.
				const running = polls === 2 || polls === 3
				return { ...runningStatus, agentRunning: running }
			})

			const result = await runUntilTurnEnd(makeRecoveryOptions())

			expect(result.stopReason).toBe("recovered")
			// The dip never reached the grace window (reset by the resumed
			// turn) — recovery only fired after a CONTINUOUS quiet stretch
			// following the attach (3 reattach inits + 1 original).
			expect(mockInitialize).toHaveBeenCalledTimes(4)
			expect(mockCancel).not.toHaveBeenCalled()
		})

		it("returns stopReason 'recovered' when the run finished during disconnect", async () => {
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockResolvedValue({
				name: "s",
				agentMode: "ACP",
				yolo: true,
				alive: true,
				agentRunning: false,
				clientConnected: false,
				connectedThroughBridge: false,
				finishedAt: new Date().toISOString(),
			})

			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ reconnectBackoffsMs: [10, 20, 40] }))

			expect(result.stopReason).toBe("recovered")
			// Response text comes from the mocked load replay (extractFinalAssistantText)
			expect(result.responseText).toBe("Recovered result text")
			// Session IS deleted after successful recovery
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("returns stopReason 'recovery_failed' when the replay yields no result", async () => {
			// The run finished during the disconnect, but session/load replay
			// cannot produce the final assistant text — the result is unknown.
			// Recovery must resolve (not throw, not hang) with a DISTINCT
			// stopReason so the manager can treat the run as failed instead of
			// showing the post-completion dropdown on an unknown result.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockResolvedValue({
				name: "s",
				agentMode: "ACP",
				yolo: true,
				alive: true,
				agentRunning: false,
				clientConnected: false,
				connectedThroughBridge: false,
				finishedAt: new Date().toISOString(),
			})
			// Empty replay — extractFinalAssistantText finds no final assistant text.
			mockLoadReplay = []

			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ reconnectBackoffsMs: [10, 20, 40] }))

			expect(result.stopReason).toBe("recovery_failed")
			expect(result.recoveryNote).toContain("Recovery failed")
			// The placeholder responseText still documents the unknown result.
			expect(result.responseText).toContain("could not be recovered")
		})

		it("throws 'result unknown' and does not delete when the session is unreachable", async () => {
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			// getSession always reports !alive → revive attempts fail.
			vi.mocked(getSession).mockResolvedValue({
				name: "s",
				agentMode: "ACP",
				yolo: true,
				alive: false,
				agentRunning: false,
				clientConnected: false,
				connectedThroughBridge: false,
			})
			// Revive: auth works, readiness works, but getSession still says !alive.
			vi.mocked(authenticateWorkspace).mockResolvedValue({
				connectToken: "tok2",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				wsUrl: "wss://worker.example.com",
				host: "worker.example.com",
			})

			await expect(runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions())).rejects.toThrow(
				"remote session no longer reachable",
			)

			// Revive readiness waits are capped per attempt (5min), unlike the initial
			// uncapped wait (10-min default) before the first prompt.
			const readyCalls = vi.mocked(waitForWorkspaceReady).mock.calls
			expect(readyCalls[0][0]).not.toHaveProperty("timeoutMs")
			for (const call of readyCalls.slice(1)) {
				expect(call[0]).toMatchObject({ timeoutMs: 5 * 60_000 })
			}

			expect(deleteSession).not.toHaveBeenCalled()
		})

		it("does a best-effort deleteSession then throws AbortError when aborted during recovery", async () => {
			const controller = new AbortController()
			// prompt rejects with connection error, then we abort while recovery is mid-flight.
			mockPrompt.mockImplementation(async () => {
				controller.abort()
				throw new RemoteConnectionError("WS closed")
			})
			vi.mocked(getSession).mockImplementation(async () => {
				// simulate a slow poll that notices the abort
				if (controller.signal.aborted) {
					const e = new Error("aborted")
					e.name = "AbortError"
					throw e
				}
				return {
					name: "s",
					agentMode: "ACP",
					yolo: true,
					alive: true,
					agentRunning: true,
					clientConnected: false,
					connectedThroughBridge: false,
				}
			})

			await expect(
				runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions({ signal: controller.signal })),
			).rejects.toThrow()

			// Best-effort delete was attempted.
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("deletes the session best-effort when an abort surfaces as a plain error while connected", async () => {
			// Ctrl+X while the WS is still healthy: prompt() rejects with a
			// non-RemoteConnectionError and signal.aborted is already true. The
			// remote session must not outlive its owner — best-effort delete, then
			// rethrow. Non-abort errors (below) never delete.
			const controller = new AbortController()
			mockPrompt.mockImplementation(async () => {
				controller.abort()
				throw new Error("user cancelled")
			})

			await expect(runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ signal: controller.signal }))).rejects.toThrow(
				"user cancelled",
			)

			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("does not delete session when a non-connection error propagates from prompt", async () => {
			mockPrompt.mockRejectedValue(new Error("genuine agent error"))

			await expect(runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions())).rejects.toThrow("genuine agent error")

			expect(deleteSession).not.toHaveBeenCalled()
		})

		it("resolves exactly once — no double completion on any path", async () => {
			// Normal completion: prompt() resolves once, deleteSession called once
			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ reconnectBackoffsMs: [10, 20, 40] }))
			expect(result.stopReason).toBe("end_turn")
			expect(deleteSession).toHaveBeenCalledOnce()
			expect(mockPrompt).toHaveBeenCalledOnce()
		})

		it("resolves exactly once on recovery path — no double completion", async () => {
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockImplementation(quietRunningFor(1))

			const result = await runUntilTurnEnd(makeRecoveryOptions())
			expect(result.stopReason).toBe("recovered")
			// deleteSession called exactly once (after the successful reattach recovery)
			expect(deleteSession).toHaveBeenCalledOnce()
			expect(mockPrompt).toHaveBeenCalledOnce()
		})

		it("resolves exactly once on finished-while-away recovery path", async () => {
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockResolvedValue({
				name: "s",
				agentMode: "ACP",
				yolo: true,
				alive: true,
				agentRunning: false,
				clientConnected: false,
				connectedThroughBridge: false,
				finishedAt: new Date().toISOString(),
			})

			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ reconnectBackoffsMs: [10, 20, 40] }))
			expect(result.stopReason).toBe("recovered")
			// deleteSession called exactly once (after recovery)
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("fires onReconnecting(true) on disconnect then onReconnecting(false) on reattach", async () => {
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WebSocket closed"))
			const onReconnecting = vi.fn()
			vi.mocked(getSession).mockImplementation(quietRunningFor(1))

			await runUntilTurnEnd(makeRecoveryOptions({ onReconnecting }))

			// Should be called with true (entering reconnecting) then false (reattached)
			expect(onReconnecting).toHaveBeenCalledWith(true)
			expect(onReconnecting).toHaveBeenCalledWith(false)
		})

		it("keeps retrying at poll cadence when status polls fail while the session is alive", async () => {
			// Local network down: every HTTP status poll fails while the sandbox
			// is fine. A failed poll says nothing about the session — no revive
			// budget, no "result unknown" failure; the runner retries at poll
			// cadence until a poll succeeds.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			let calls = 0
			vi.mocked(getSession).mockImplementation(async () => {
				calls++
				if (calls <= 4) throw new Error("HTTP 503 — local network down")
				return {
					name: "s",
					agentMode: "ACP" as const,
					yolo: true,
					alive: true,
					agentRunning: false,
					clientConnected: true,
					connectedThroughBridge: false,
					finishedAt: new Date().toISOString(),
				}
			})

			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions())

			expect(result.stopReason).toBe("recovered")
			// Kept polling past the four failures instead of giving up.
			expect(calls).toBeGreaterThanOrEqual(5)
			// No revive was attempted — the session was never confirmed dead. The
			// 3rd consecutive poll failure refreshes credentials (a re-auth, not a
			// revive), and the recovery fetch re-auths once more before rsync.
			expect(authenticateWorkspace).toHaveBeenCalledTimes(3)
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("resets the reattach budget when connectivity is regained with a live turn", async () => {
			// Flaky network burns the reattach budget with transient attach
			// failures, then connectivity drops and returns while the remote turn
			// is still running. The runner must retry the attach (live resume,
			// onReconnecting(false)) instead of watching in "reconnecting" until
			// the turn ends.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			mockInitialize.mockReset()
			mockInitialize
				.mockResolvedValueOnce(undefined) // initial newSession init
				.mockRejectedValueOnce(new RemoteConnectionError("flaky: loadSession timed out"))
				.mockRejectedValueOnce(new RemoteConnectionError("flaky: loadSession timed out"))
				.mockRejectedValueOnce(new RemoteConnectionError("flaky: loadSession timed out"))
				.mockResolvedValue(undefined) // the post-regain attach succeeds
			let polls = 0
			vi.mocked(getSession).mockImplementation(async () => {
				polls++
				// One full-outage poll blip — the fail→success edge that must
				// restore the burned reattach budget.
				if (polls === 4) throw new Error("HTTP 503 — network blip")
				return {
					name: "s",
					agentMode: "ACP" as const,
					yolo: true,
					alive: true,
					agentRunning: polls < 8,
					clientConnected: false,
					connectedThroughBridge: false,
					finishedAt: polls >= 8 ? new Date().toISOString() : undefined,
				}
			})

			const onReconnecting = vi.fn()
			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions({ onReconnecting }))

			expect(result.stopReason).toBe("recovered")
			// 1 initial init + 3 flaky failures + 1 successful reattach after the reset.
			expect(mockInitialize).toHaveBeenCalledTimes(5)
			expect(onReconnecting).toHaveBeenCalledWith(false)
		})

		it("refreshes expired credentials when polls are rejected with 401 (spec Q6)", async () => {
			// The connect token expired during the outage: status polls are
			// rejected with 401. The runner must re-auth and rebuild the client
			// instead of polling with dead credentials forever.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			mockInitialize.mockReset()
			mockInitialize.mockResolvedValue(undefined)
			let polls = 0
			vi.mocked(getSession).mockImplementation(async () => {
				polls++
				if (polls <= 2) throw new WorkerError("connect token expired", 401)
				return {
					name: "s",
					agentMode: "ACP" as const,
					yolo: true,
					alive: true,
					agentRunning: polls < 6,
					clientConnected: false,
					connectedThroughBridge: false,
					finishedAt: polls >= 6 ? new Date().toISOString() : undefined,
				}
			})

			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions())

			expect(result.stopReason).toBe("recovered")
			// Spawn auth + one refresh per 401-rejected poll + the attach reauth +
			// the recovery-fetch reauth.
			expect(authenticateWorkspace).toHaveBeenCalledTimes(5)
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("recovers the result via session/load replay", async () => {
			// The result is recovered at the protocol level: session/load replays
			// the finished session's history to a fresh client, and the text after
			// the last tool call — the final assistant message — is the answer.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockResolvedValue({
				name: "s",
				agentMode: "ACP",
				yolo: true,
				alive: true,
				agentRunning: false,
				clientConnected: false,
				connectedThroughBridge: false,
				finishedAt: new Date().toISOString(),
			})
			mockLoadReplay = [
				{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working on it" } } },
				{ update: { sessionUpdate: "tool_call", toolCallId: "kt.bash.1", status: "completed" } },
				{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The final " } } },
				{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer." } } },
			]

			const result = await runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions())

			expect(result.stopReason).toBe("recovered")
			// The text after the last tool call — the final assistant message.
			expect(result.responseText).toBe("The final answer.")
			expect(result.recoveryNote).toContain("replaying the remote session")
		})

		it("recovers immediately when the attached client observes the turn-end response", async () => {
			// The reattached client receives the ORIGINAL connection's prompt
			// response (an id it never sent) the moment the turn ends. That
			// response IS the turn's end — recover at once instead of waiting
			// out the quiesce grace (which can lose the race against the sandbox
			// reaping the remote child).
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockImplementation(quietRunningFor(1))

			// A grace the test could never wait out — only the turn-end signal
			// can complete the run.
			const runPromise = runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions({ turnSettleGraceMs: 60_000 }))

			// Wait for the reattach (the client constructed with the hook), then
			// fire the turn-end signal.
			await vi.waitFor(() => expect(capturedOptions?.onForeignResponse).toBeTypeOf("function"))
			;(capturedOptions as { onForeignResponse: (response: unknown) => void }).onForeignResponse({ id: 4, result: {} })

			const result = await runPromise

			expect(result.stopReason).toBe("recovered")
			expect(result.responseText).toBe("Recovered result text")
			expect(result.recoveryNote).toContain("replaying the remote session")
		})

		it("fails honestly when the remote session is gone (404) instead of retrying forever", async () => {
			// A definitive 404 from the worker (session deleted/reaped server-side)
			// must not be treated like a transient poll failure — the run fails
			// honestly with the session left undeleted, never an infinite retry.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockImplementation(async () => {
				throw new WorkerError("session not found", 404)
			})

			await expect(runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions())).rejects.toThrow(
				"remote session no longer exists",
			)
			// The session is already gone server-side; nothing to delete.
			expect(deleteSession).not.toHaveBeenCalled()
		})

		it("restarts the quiesce clock after a successful revive — no premature recovery", async () => {
			// Hibernation mid-recovery: the turn was quiet long enough that the
			// settle grace would fire, then the pod hibernates (!alive), then the
			// revive succeeds and the worker resumes the turn. The pre-hibernation
			// quiet window must NOT count against the just-revived turn.
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			// getSession call script (it is also called inside tryReviveWorkspace):
			//  1-6: alive + quiet   — quiet window accumulates toward grace (60ms)
			//  7:   !alive          — hibernation detected (a quiet poll here would
			//                         have crossed the grace threshold)
			//  8:   revive check    — alive → revive succeeds
			//  9:   alive + quiet   — worker hasn't resumed the turn yet (the test
			//                         point: fresh clock, no premature recovery)
			//  10:  alive + running — turn resumed
			//  11+: alive + quiet   — true quiesce past grace → recover
			const script = [
				{ alive: true, agentRunning: false },
				{ alive: true, agentRunning: false },
				{ alive: true, agentRunning: false },
				{ alive: true, agentRunning: false },
				{ alive: true, agentRunning: false },
				{ alive: true, agentRunning: false },
				{ alive: false, agentRunning: false },
				{ alive: true, agentRunning: false },
				{ alive: true, agentRunning: false },
				{ alive: true, agentRunning: true },
			]
			let calls = 0
			let observedResumedTurn = false
			vi.mocked(getSession).mockImplementation(async () => {
				calls++
				const entry = calls <= script.length ? script[calls - 1] : { alive: true, agentRunning: false }
				if (entry.agentRunning) observedResumedTurn = true
				return {
					name: "s",
					agentMode: "ACP" as const,
					yolo: true,
					alive: entry.alive,
					agentRunning: entry.agentRunning,
					clientConnected: false,
					connectedThroughBridge: false,
				}
			})

			const runPromise = runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions({ turnSettleGraceMs: 60 }))
			// Recovery must wait for the resumed turn — fire the turn-end signal
			// only after it was actually observed running post-revive.
			await vi.waitFor(() => expect(observedResumedTurn).toBe(true))
			;(capturedOptions as { onForeignResponse: (response: unknown) => void }).onForeignResponse({ id: 4, result: {} })
			const result = await runPromise

			expect(result.stopReason).toBe("recovered")
			// The turn was observed RUNNING after the revive — recovery did not
			// fire on the stale pre-hibernation quiet window.
			expect(observedResumedTurn).toBe(true)
			expect(deleteSession).toHaveBeenCalledOnce()
		})

		it("closes the previous WorkerClient before a reattach replaces it", async () => {
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockImplementation(quietRunningFor(1))
			const closers: Array<ReturnType<typeof vi.fn>> = []
			vi.mocked(WorkerClient).mockImplementation(() => {
				const close = vi.fn().mockResolvedValue(undefined)
				closers.push(close)
				return {
					close,
					// biome-ignore lint/suspicious/noExplicitAny: mock
				} as any
			})

			const result = await runUntilTurnEnd(makeRecoveryOptions())

			expect(result.stopReason).toBe("recovered")
			// The initial client plus one reattach replacement plus one
			// recovery-fetch credential refresh.
			expect(closers).toHaveLength(3)
			// The initial WorkerClient was closed when the reattach swapped it out…
			expect(closers[0]).toHaveBeenCalledOnce()
			// …the reattach replacement was closed when the recovery-fetch refresh
			// swapped it out…
			expect(closers[1]).toHaveBeenCalledOnce()
			// …and that refresh's client is closed exactly once by the finally block.
			expect(closers[2]).toHaveBeenCalledOnce()
		})

		it("does not force-disconnect when a status poll lands mid-recovery", async () => {
			// A slow status poll is in flight when recovery starts, and the first
			// poll (an always-on tick) fails outright. Neither may force-disconnect:
			// a failed HTTP poll says nothing about the WS transport, and once
			// recovery has begun the recovery loop is the sole poller — a late tick
			// must not disconnect the freshly attached client.
			let calls = 0
			vi.mocked(getSession).mockImplementation(async () => {
				calls++
				await new Promise((resolve) => setTimeout(resolve, 30))
				if (calls === 1) throw new Error("HTTP 503")
				return {
					name: "s",
					agentMode: "ACP" as const,
					yolo: true,
					alive: true,
					agentRunning: false,
					clientConnected: false,
					connectedThroughBridge: false,
					finishedAt: new Date().toISOString(),
				}
			})
			let rejectPrompt: ((err: Error) => void) | undefined
			mockPrompt.mockImplementation(
				() =>
					new Promise<never>((_resolve, reject) => {
						rejectPrompt = reject
					}),
			)
			const onReconnecting = vi.fn()

			const run = runRemoteAgent(WORKSPACE_ID, PROMPT, makeRecoveryOptions({ onReconnecting }))
			// t≈10ms: poll tick 1 starts (fails ≈40ms, still pre-recovery).
			// t≈50ms: tick 2 starts (succeeds ≈80ms, mid-recovery).
			// t≈60ms: the WS dies — recovery begins between the two.
			await new Promise((resolve) => setTimeout(resolve, 60))
			rejectPrompt?.(new RemoteConnectionError("WS closed"))
			const result = await run

			expect(onReconnecting).toHaveBeenCalledWith(true)
			expect(mockForceDisconnect).not.toHaveBeenCalled()
			expect(result.stopReason).toBe("recovered")
		})

		it("polls at the status-poll cadence once attached, not the backoff schedule", async () => {
			mockPrompt.mockRejectedValueOnce(new RemoteConnectionError("WS closed"))
			vi.mocked(getSession).mockImplementation(quietRunningFor(1))

			// The single 100ms backoff covers the one attach attempt; every
			// watch-only tick after it must run at the 10ms poll cadence.
			const runPromise = runRemoteAgent(
				WORKSPACE_ID,
				PROMPT,
				makeRecoveryOptions({ reconnectBackoffsMs: [100], turnSettleGraceMs: 150 }),
			)
			// Let the watch accumulate polls at the cadence, then end the turn.
			await vi.waitFor(() => expect(vi.mocked(getSession).mock.calls.length).toBeGreaterThanOrEqual(10))
			;(capturedOptions as { onForeignResponse: (response: unknown) => void }).onForeignResponse({ id: 4, result: {} })
			const result = await runPromise

			expect(result.stopReason).toBe("recovered")
			// Crossing the 150ms settle grace at a 10ms cadence takes ~15+ watch
			// polls (plus the first attach poll). On the 100ms backoff schedule
			// the run would have ended after ~3 polls.
			expect(vi.mocked(getSession).mock.calls.length).toBeGreaterThanOrEqual(10)
		})
	})

	describe("RemoteAgentSession steer during reconnecting", () => {
		it("throws 'agent temporarily unreachable' when session is reconnecting", async () => {
			// This tests the RemoteAgentSession adapter's steer() method directly.
			// The adapter is normally wired by agent-manager._runRemote, but the
			// steer behavior is self-contained in the adapter class.
			const { RemoteAgentSession } = await import("./remote-agent-session.js")
			const session = new RemoteAgentSession()
			session.setReconnecting(true)
			await expect(session.steer("do something")).rejects.toThrow("agent temporarily unreachable")
		})

		it("throws generic 'not supported' when session is NOT reconnecting", async () => {
			const { RemoteAgentSession } = await import("./remote-agent-session.js")
			const session = new RemoteAgentSession()
			await expect(session.steer("do something")).rejects.toThrow("Steering is not supported for remote agents")
		})
	})

	describe("activity reset on reattach", () => {
		it("clears stale tool state and emits activity_reset when reattaching", async () => {
			const { RemoteAgentSession } = await import("./remote-agent-session.js")
			const session = new RemoteAgentSession()

			// Track events emitted by the session
			const events: string[] = []
			session.subscribe((e) => events.push(e.type))

			// Simulate pre-disconnect tool activity
			session.recordToolCallStart("bash", "tc-1")
			session.recordToolCallStart("read", "tc-2")
			session.appendAssistantText("Some old text")

			// Verify tools are tracked
			expect(session.messages.length).toBeGreaterThan(0)

			// Enter reconnecting state
			session.setReconnecting(true)
			expect(events).not.toContain("activity_reset")

			// Reattach — should clear stale state and emit activity_reset
			session.setReconnecting(false)

			expect(events).toContain("activity_reset")
		})

		it("resets responseText on reattach so progress line starts fresh", async () => {
			// Pre-disconnect: the live turn streams partial text, then the WS dies.
			mockPrompt.mockImplementation(async () => {
				const cb = capturedOptions?.callbacks as { onTextDelta: (delta: string, fullText: string) => void } | undefined
				cb?.onTextDelta("partial stale ", "partial stale ")
				throw new RemoteConnectionError("WS closed")
			})
			// Reattach: the live turn's updates stream over the NEW connection —
			// the reattached client's initialize() simulates that fresh stream.
			mockInitialize.mockReset()
			mockInitialize
				.mockResolvedValueOnce(undefined) // initial new-session init
				.mockImplementation(async () => {
					const cb = capturedOptions?.callbacks as
						| { onTextDelta: (delta: string, fullText: string) => void }
						| undefined
					cb?.onTextDelta("fresh ", "fresh ")
					cb?.onTextDelta("text", "fresh text")
					return undefined
				})
			vi.mocked(getSession).mockImplementation(quietRunningFor(1))

			const deltas: string[] = []
			const fullTexts: string[] = []
			const runPromise = runRemoteAgent(
				WORKSPACE_ID,
				PROMPT,
				makeOptions({
					reconnectBackoffsMs: [10, 20, 40],
					turnSettleGraceMs: 30,
					pollIntervalMs: 10,
					callbacks: {
						onTextDelta: (delta: string, fullText: string) => {
							deltas.push(delta)
							fullTexts.push(fullText)
						},
					},
				}),
			)
			// Wait for the reattached stream's fresh text, then end the turn — the
			// quiesce no longer fires while attached.
			await vi.waitFor(() => expect(fullTexts).toContain("fresh text"))
			;(capturedOptions as { onForeignResponse: (response: unknown) => void }).onForeignResponse({ id: 4, result: {} })
			await runPromise

			// The post-reattach stream starts fresh: deltas are forwarded verbatim
			// and fullText is the new stream's own text — never merged with (or
			// sliced against) the stale pre-disconnect text.
			expect(deltas).toEqual(["partial stale ", "fresh ", "text"])
			expect(fullTexts).toEqual(["partial stale ", "fresh ", "fresh text"])
		})

		it("onReconnecting callback fires true then false, clearing stale activity via session subscribe", async () => {
			const { RemoteAgentSession } = await import("./remote-agent-session.js")
			const session = new RemoteAgentSession()

			// Simulate the activity tracker subscribing to session events
			// (mirrors what index.ts createActivityTracker does in onSessionCreated)
			const activityState = {
				activeTools: new Map<string, string>(),
				responseText: "",
			}
			session.subscribe(((event: { type: string }) => {
				if (event.type === "activity_reset") {
					activityState.activeTools.clear()
					activityState.responseText = ""
				}
			}) as never)

			// Simulate pre-disconnect activity accumulating
			activityState.activeTools.set("bash_123", "bash")
			activityState.activeTools.set("read_456", "read")
			activityState.responseText = "old stale text from before disconnect"

			expect(activityState.activeTools.size).toBe(2)
			expect(activityState.responseText).toBe("old stale text from before disconnect")

			// Enter reconnecting
			session.setReconnecting(true)
			expect(activityState.activeTools.size).toBe(2) // not cleared yet

			// Reattach — activity_reset fires, clearing stale state
			session.setReconnecting(false)

			expect(activityState.activeTools.size).toBe(0)
			expect(activityState.responseText).toBe("")
		})
	})
})

describe("attachRemoteAgent", () => {
	// Fast backoffs/poll/grace — same rationale as the disconnect-recovery tests.
	const FAST_BACKOFFS = [10, 20, 40]
	const GRACE = 30
	const FAST_POLL = 10

	const META: RemoteSessionMeta = {
		workspaceId: WORKSPACE_ID,
		sessionName: "acp-resume01",
		wsUrl: "wss://worker.example.com",
		host: "worker.example.com",
		cwd: "/home/sandbox/acp-resume01",
	}

	function makeAttachOptions(overrides: Partial<AttachRemoteAgentOptions> = {}): AttachRemoteAgentOptions {
		return {
			apiKey: "test-api-key",
			remoteSession: META,
			acpSessionId: "remote-acp-1",
			callbacks: {
				onTextDelta: vi.fn(),
				onToolActivity: vi.fn(),
				onTurnEnd: vi.fn(),
				onAssistantUsage: vi.fn(),
			},
			reconnectBackoffsMs: FAST_BACKOFFS,
			turnSettleGraceMs: GRACE,
			pollIntervalMs: FAST_POLL,
			...overrides,
		}
	}

	/** Attach and fire the turn-end signal once the attached client (with
	 *  onForeignResponse) exists — the realistic exit for resume tests. */
	async function attachUntilTurnEnd(options: AttachRemoteAgentOptions) {
		const attachPromise = attachRemoteAgent(options)
		await vi.waitFor(() => expect(capturedOptions?.onForeignResponse).toBeTypeOf("function"))
		;(capturedOptions as { onForeignResponse: (response: unknown) => void }).onForeignResponse({ id: 4, result: {} })
		return attachPromise
	}

	it("attaches to the still-running session and recovers the result on turn end", async () => {
		vi.mocked(getSession).mockImplementation(quietRunningFor(10))
		const onReconnecting = vi.fn()

		const result = await attachUntilTurnEnd(makeAttachOptions({ onReconnecting }))

		expect(result.stopReason).toBe("recovered")
		expect(result.responseText).toBe("Recovered result text")
		// Never created a new session, never re-prompted — attach only.
		expect(createSession).not.toHaveBeenCalled()
		expect(mockPrompt).not.toHaveBeenCalled()
		// One attach client (mockInitialize) plus one replay client (inline).
		expect(mockInitialize).toHaveBeenCalledTimes(1)
		expect(capturedOptions?.sessionId).toBe("remote-acp-1")
		// The resumed record can mirror reconnecting → running → completion.
		expect(onReconnecting).toHaveBeenNthCalledWith(1, true)
		expect(onReconnecting).toHaveBeenNthCalledWith(2, false)
		// Confirmed-finished run cleaned up the remote session.
		expect(deleteSession).toHaveBeenCalledOnce()
	})

	it("recovers via replay without attaching when the run finished while kimchi was closed", async () => {
		vi.mocked(getSession).mockResolvedValue({
			name: "s",
			agentMode: "ACP",
			yolo: true,
			alive: true,
			agentRunning: false,
			clientConnected: false,
			connectedThroughBridge: false,
			finishedAt: new Date().toISOString(),
		})

		const result = await attachRemoteAgent(makeAttachOptions())

		expect(result.stopReason).toBe("recovered")
		expect(result.responseText).toBe("Recovered result text")
		// No attach client was constructed — the replay client is the only one.
		expect(mockInitialize).not.toHaveBeenCalled()
		expect(mockPrompt).not.toHaveBeenCalled()
		expect(deleteSession).toHaveBeenCalledOnce()
	})

	it("throws when the session was reaped server-side (404) — result unknown", async () => {
		vi.mocked(getSession).mockRejectedValue(new WorkerError("not found", 404))

		await expect(attachRemoteAgent(makeAttachOptions())).rejects.toThrow("no longer exists")

		// Unknown outcome — nothing is deleted.
		expect(deleteSession).not.toHaveBeenCalled()
	})

	it("throws when the sandbox cannot be revived — session left undeleted", async () => {
		vi.mocked(getSession).mockResolvedValue({
			name: "s",
			agentMode: "ACP",
			yolo: true,
			alive: false,
			agentRunning: false,
			clientConnected: false,
			connectedThroughBridge: false,
		})

		await expect(attachRemoteAgent(makeAttachOptions())).rejects.toThrow("no longer reachable")

		// Unknown outcome — the unreachable session is not deleted.
		expect(deleteSession).not.toHaveBeenCalled()
	})

	it("deletes the session best-effort and throws AbortError on user kill", async () => {
		const controller = new AbortController()
		vi.mocked(getSession).mockImplementation(quietRunningFor(10))

		const attachPromise = attachRemoteAgent(makeAttachOptions({ signal: controller.signal }))
		await vi.waitFor(() => expect(capturedOptions?.onForeignResponse).toBeTypeOf("function"))
		controller.abort()

		await expect(attachPromise).rejects.toMatchObject({ name: "AbortError" })
		// The remote session must not outlive its owner once the user stops it.
		expect(deleteSession).toHaveBeenCalledOnce()
	})

	it("isRemoteSessionConnected returns true only on a positive sighting", async () => {
		// Positive: another kimchi process holds a live WS on the session.
		vi.mocked(getSession).mockResolvedValue({
			name: "s",
			agentMode: "ACP",
			yolo: true,
			alive: true,
			agentRunning: true,
			clientConnected: true,
			connectedThroughBridge: false,
		})
		await expect(isRemoteSessionConnected(META, "test-api-key")).resolves.toBe(true)

		// Negative: a failed poll must NOT block the resume — the attach's own
		// recovery machinery handles the real session state.
		vi.mocked(getSession).mockRejectedValue(new Error("network down"))
		await expect(isRemoteSessionConnected(META, "test-api-key")).resolves.toBe(false)
	})
})
