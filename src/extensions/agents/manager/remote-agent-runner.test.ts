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
}))

vi.mock("../../teleport/provisioning/git-provision.js", () => ({
	provisionGitCredential: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../teleport/provisioning/sync-local-changes.js", () => ({
	syncLocalChangesAfterClone: vi.fn().mockResolvedValue(undefined),
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

let capturedOptions: Record<string, unknown> | undefined

vi.mock("../../../sandbox/worker/acp-client.js", () => ({
	AcpSessionClient: vi.fn().mockImplementation((options: Record<string, unknown>) => {
		capturedOptions = options
		return {
			initialize: mockInitialize,
			prompt: mockPrompt,
			close: mockClose,
			cancel: mockCancel,
		}
	}),
}))

// Import after mocks are set up
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { waitForWorkspaceReady } from "../../../sandbox/cloud/readiness.js"
import { AcpSessionClient, type AcpSessionClientOptions } from "../../../sandbox/worker/acp-client.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { createSession, deleteSession } from "../../../sandbox/worker/sessions.js"
import { provisionGitCredential } from "../../teleport/provisioning/git-provision.js"
import { syncLocalChangesAfterClone } from "../../teleport/provisioning/sync-local-changes.js"
import { type RemoteRunOptions, runRemoteAgent } from "./remote-agent-runner.js"

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
	// Re-establish the AcpSessionClient constructor mock — clearAllMocks
	// resets the mockImplementation, so new AcpSessionClient() would return undefined.
	vi.mocked(AcpSessionClient).mockImplementation((options: AcpSessionClientOptions) => {
		capturedOptions = options as unknown as Record<string, unknown>
		return {
			initialize: mockInitialize,
			prompt: mockPrompt,
			close: mockClose,
			cancel: mockCancel,
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
			expect.objectContaining({ timeoutMs: 5 * 60_000 }),
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

	it("closes AcpSessionClient and deletes session on error", async () => {
		mockPrompt.mockRejectedValue(new Error("prompt failed"))

		await expect(runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions())).rejects.toThrow("prompt failed")

		// Cleanup must still happen
		expect(mockClose).toHaveBeenCalledOnce()
		expect(deleteSession).toHaveBeenCalledOnce()
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

	it("forwards onToolActivity, onTurnEnd, onAssistantUsage, onRawNotification callbacks", async () => {
		const callbacks = {
			onToolActivity: vi.fn(),
			onTurnEnd: vi.fn(),
			onAssistantUsage: vi.fn(),
			onRawNotification: vi.fn(),
		}
		await runRemoteAgent(WORKSPACE_ID, PROMPT, makeOptions({ callbacks }))

		const captured = capturedOptions?.callbacks as Record<string, (...args: unknown[]) => void> | undefined
		expect(captured).toBeDefined()
		if (!captured) return
		expect(typeof captured.onToolActivity).toBe("function")
		expect(typeof captured.onTurnEnd).toBe("function")
		expect(typeof captured.onAssistantUsage).toBe("function")
		expect(typeof captured.onRawNotification).toBe("function")

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
})
