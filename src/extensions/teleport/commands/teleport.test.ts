import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
	authMock,
	waitReadyMock,
	listWorkspacesMock,
	listSessionsMock,
	createSessionMock,
	overlayMock,
	pickWorkspaceMock,
	progressMock,
	progressInstances,
	promptGitTokenQueue,
	getGitRemoteHostMock,
	parseHostMock,
	readGitTokenMock,
	writeGitTokenMock,
	readTeleportHelpSeenAtMock,
	writeTeleportHelpSeenAtMock,
	readLocalGitConfigMock,
	provisionGitIdentityMock,
	provisionGitCredentialMock,
	provisionHarnessConfigMock,
	readTeleportCompactHintEnabledMock,
	runRsyncMock,
	formatRsyncFailureMock,
	resolveClonePlanMock,
	buildIncludeListMock,
	buildChangedFilesListMock,
	sumIncludeListBytesMock,
} = vi.hoisted(() => ({
	authMock: vi.fn(),
	waitReadyMock: vi.fn(),
	listWorkspacesMock: vi.fn(),
	listSessionsMock: vi.fn(),
	createSessionMock: vi.fn(),
	overlayMock: vi.fn(),
	pickWorkspaceMock: vi.fn(),
	progressMock: vi.fn(),
	progressInstances: [] as Array<{
		step: ReturnType<typeof vi.fn>
		complete: ReturnType<typeof vi.fn>
		setStepDetail: ReturnType<typeof vi.fn>
		setCancelling: ReturnType<typeof vi.fn>
		finish: ReturnType<typeof vi.fn>
		stop: ReturnType<typeof vi.fn>
		promptGitToken: ReturnType<typeof vi.fn>
	}>,
	promptGitTokenQueue: [] as Array<{ outcome: "submitted"; token: string; save: boolean } | { outcome: "skipped" }>,
	getGitRemoteHostMock: vi.fn(),
	parseHostMock: vi.fn(),
	readGitTokenMock: vi.fn(),
	writeGitTokenMock: vi.fn(),
	readTeleportHelpSeenAtMock: vi.fn(),
	writeTeleportHelpSeenAtMock: vi.fn(),
	readLocalGitConfigMock: vi.fn(),
	provisionGitIdentityMock: vi.fn(),
	provisionGitCredentialMock: vi.fn(),
	provisionHarnessConfigMock: vi.fn(),
	readTeleportCompactHintEnabledMock: vi.fn(),
	runRsyncMock: vi.fn(),
	formatRsyncFailureMock: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
	resolveClonePlanMock: vi.fn(),
	buildIncludeListMock: vi.fn(),
	buildChangedFilesListMock: vi.fn(),
	sumIncludeListBytesMock: vi.fn(),
}))

vi.mock("../../../sandbox/cloud/auth.js", () => ({ authenticateWorkspace: authMock }))
vi.mock("../../../sandbox/cloud/readiness.js", () => ({ waitForWorkspaceReady: waitReadyMock }))
vi.mock("../../../sandbox/cloud/workspaces.js", () => ({ listWorkspaces: listWorkspacesMock }))
vi.mock("../../../sandbox/worker/client.js", () => ({
	WorkerClient: class {},
}))
vi.mock("../../../sandbox/worker/sessions.js", () => ({
	listSessions: listSessionsMock,
	createSession: createSessionMock,
}))
vi.mock("../overlay/overlay-component.js", () => ({ createTabsOverlay: overlayMock }))
vi.mock("../ui/workspaces-panel.js", () => ({ pickWorkspace: pickWorkspaceMock }))
vi.mock("../../../sandbox/git-credentials.js", () => ({
	getGitRemoteHost: getGitRemoteHostMock,
	parseHostFromRemoteUrl: parseHostMock,
	readLocalGitConfig: readLocalGitConfigMock,
}))
vi.mock("../../../config.js", () => ({
	readGitToken: readGitTokenMock,
	writeGitToken: writeGitTokenMock,
	readTeleportHelpSeenAt: readTeleportHelpSeenAtMock,
	writeTeleportHelpSeenAt: writeTeleportHelpSeenAtMock,
	readTeleportCompactHintEnabled: readTeleportCompactHintEnabledMock,
}))
vi.mock("../provisioning/git-provision.js", () => ({
	provisionGitIdentity: provisionGitIdentityMock,
	provisionGitCredential: provisionGitCredentialMock,
}))
vi.mock("../provisioning/harness-config.js", () => ({
	provisionHarnessConfig: provisionHarnessConfigMock,
}))
vi.mock("../provisioning/clone-plan.js", () => {
	class ClonePlanError extends Error {
		readonly code: string
		constructor(code: string, message: string) {
			super(message)
			this.name = "ClonePlanError"
			this.code = code
		}
	}
	return { resolveClonePlan: resolveClonePlanMock, ClonePlanError }
})
vi.mock("../provisioning/include-list.js", () => ({
	buildIncludeList: buildIncludeListMock,
	buildChangedFilesList: buildChangedFilesListMock,
}))
vi.mock("../provisioning/estimate-bytes.js", () => ({
	sumIncludeListBytes: sumIncludeListBytesMock,
}))
vi.mock("../provisioning/rsync-runner.js", () => ({
	runRsync: runRsyncMock,
	formatRsyncFailure: formatRsyncFailureMock,
}))
vi.mock("../ui/progress.js", () => ({
	createTeleportProgress: (...args: unknown[]) => {
		progressMock(...args)
		const controller = {
			step: vi.fn(),
			complete: vi.fn(),
			setStepDetail: vi.fn(),
			setCancelling: vi.fn(),
			finish: vi.fn(),
			stop: vi.fn(),
			promptGitToken: vi.fn().mockImplementation(async () => {
				return promptGitTokenQueue.shift() ?? { outcome: "skipped" }
			}),
		}
		progressInstances.push(controller)
		return controller
	},
}))

import type { TeleportContext } from "../types.js"
import { TeleportRefusal } from "./errors.js"
import {
	readSessionTail,
	runTeleport,
	SESSION_CREATE_TIMEOUT_MS,
	SESSION_TAIL_BYTES,
	SESSION_WIDEN_MAX_BYTES,
} from "./teleport.js"

const CREDS = {
	connectToken: "tok-1",
	expiresAt: "2030-01-01T00:00:00Z",
	wsUrl: "wss://host.example",
	host: "host.example",
}

function makeUi(): ExtensionUIContext & {
	notify: ReturnType<typeof vi.fn>
	custom: ReturnType<typeof vi.fn>
	setHeader: ReturnType<typeof vi.fn>
} {
	return {
		notify: vi.fn(),
		setStatus: vi.fn(),
		setHeader: vi.fn(),
		setWidget: vi.fn(),
		setTitle: vi.fn(),
		setEditorText: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setFooter: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(),
		getEditorText: vi.fn(),
		pasteToEditor: vi.fn(),
		select: vi.fn(),
		confirm: vi.fn(),
		input: vi.fn(),
		editor: vi.fn(),
		onTerminalInput: vi.fn(() => vi.fn()),
		addAutocompleteProvider: vi.fn(),
		custom: vi.fn(async () => undefined),
		theme: {} as never,
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} as unknown as ExtensionUIContext & {
		notify: ReturnType<typeof vi.fn>
		custom: ReturnType<typeof vi.fn>
		setHeader: ReturnType<typeof vi.fn>
	}
}

function makeCtx(over: Partial<TeleportContext> = {}): {
	ctx: TeleportContext
	ui: ReturnType<typeof makeUi>
} {
	const ui = makeUi()
	const ctx: TeleportContext = {
		apiKey: "test-key",
		endpoint: "https://api.example.com",
		cwd: "/work/proj",
		ui,
		signal: undefined,
		...over,
	}
	return { ctx, ui }
}

let tempDir = ""

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "teleport-test-"))
	authMock.mockReset().mockResolvedValue(CREDS)
	waitReadyMock.mockReset().mockResolvedValue(undefined)
	listWorkspacesMock.mockReset().mockResolvedValue([])
	listSessionsMock.mockReset().mockResolvedValue([])
	createSessionMock.mockReset().mockResolvedValue({ freshClone: true })
	pickWorkspaceMock.mockReset()
	overlayMock.mockReset().mockReturnValue(() => ({
		render: () => [],
		invalidate: () => {},
		dispose: () => {},
	}))
	progressMock.mockReset()
	progressInstances.length = 0
	promptGitTokenQueue.length = 0
	getGitRemoteHostMock.mockReset().mockResolvedValue(undefined)
	parseHostMock.mockReset().mockImplementation((url: string) => (url.includes("github.com") ? "github.com" : undefined))
	readGitTokenMock.mockReset().mockReturnValue(undefined)
	writeGitTokenMock.mockReset()
	readTeleportHelpSeenAtMock.mockReset().mockReturnValue("2025-01-01T00:00:00.000Z")
	writeTeleportHelpSeenAtMock.mockReset()
	readLocalGitConfigMock.mockReset().mockResolvedValue({})
	provisionGitIdentityMock.mockReset().mockResolvedValue(undefined)
	provisionGitCredentialMock.mockReset().mockResolvedValue(undefined)
	provisionHarnessConfigMock.mockReset().mockResolvedValue({ ok: true })
	readTeleportCompactHintEnabledMock.mockReset().mockReturnValue(true)
	runRsyncMock.mockReset().mockResolvedValue({ fileCount: 1, totalBytes: 1, durationMs: 1 })
	formatRsyncFailureMock
		.mockReset()
		.mockImplementation((err: unknown) => (err instanceof Error ? err.message : String(err)))
	resolveClonePlanMock.mockReset().mockResolvedValue(undefined)
	buildIncludeListMock.mockReset().mockResolvedValue(["src/a.ts", ".git/HEAD", ".git/refs/heads/main"])
	buildChangedFilesListMock.mockReset().mockResolvedValue(["src/a.ts", "README.md"])
	sumIncludeListBytesMock.mockReset().mockResolvedValue(123)
})

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe("runTeleport", () => {
	it("shows an inline status line message while resolving the workspace, and clears it before the overlay opens", async () => {
		const { ctx, ui } = makeCtx()
		const setStatusMock = ui.setStatus as unknown as ReturnType<typeof vi.fn>

		await runTeleport("mysession --workspace 22222222-2222-4222-8222-222222222222", ctx)

		const teleportStatusCalls = setStatusMock.mock.calls.filter((c) => c[0] === "teleport")
		expect(teleportStatusCalls.length).toBeGreaterThanOrEqual(2)
		expect(teleportStatusCalls[0]).toEqual(["teleport", "Teleport: resolving workspace…"])
		expect(teleportStatusCalls.at(-1)).toEqual(["teleport", undefined])
	})

	it("kicks off local work in parallel with the authentication network call", async () => {
		// Hold authMock open until we say so, so we can observe whether the
		// local readLocalGitConfig + getGitRemoteHost calls happened during
		// the wait or only after.
		let releaseAuth: (v: typeof CREDS) => void = () => {}
		authMock.mockImplementation(
			() =>
				new Promise<typeof CREDS>((resolve) => {
					releaseAuth = resolve
				}),
		)
		const calledDuringAuthWait = { readLocalGitConfig: false, getGitRemoteHost: false }
		readLocalGitConfigMock.mockImplementation(async () => {
			calledDuringAuthWait.readLocalGitConfig = true
			return {}
		})
		getGitRemoteHostMock.mockImplementation(async () => {
			calledDuringAuthWait.getGitRemoteHost = true
			return undefined
		})
		const { ctx } = makeCtx()

		const p = runTeleport("--workspace 11111111-1111-4111-8111-111111111111", ctx)
		// Yield enough microtasks for runTeleport's eager local kick-off to land.
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		expect(calledDuringAuthWait.readLocalGitConfig).toBe(true)
		expect(calledDuringAuthWait.getGitRemoteHost).toBe(true)
		// Let auth finish so the rest of runTeleport can complete.
		releaseAuth(CREDS)
		await p
	})

	it("happy path: creates PTY session, opens overlay", async () => {
		const { ctx, ui } = makeCtx()

		await runTeleport("mysession --workspace 22222222-2222-4222-8222-222222222222", ctx)

		// resolveWorkspaceRef always lists now (UUID shortcut removed) so it
		// can return the workspace's current name to preserve on auth.
		expect(listWorkspacesMock).toHaveBeenCalledOnce()
		expect(authMock).toHaveBeenCalledOnce()
		expect(authMock.mock.calls[0][0]).toBe("22222222-2222-4222-8222-222222222222")
		expect(waitReadyMock).toHaveBeenCalledOnce()
		expect(listSessionsMock).toHaveBeenCalledOnce()
		expect(createSessionMock).toHaveBeenCalledOnce()
		expect(createSessionMock.mock.calls[0][1]).toBe("mysession")
		expect(createSessionMock.mock.calls[0][2]).toEqual({ agentMode: "PTY" })
		// Large repos take longer than the 30s WorkerClient default;
		// teleport must pass a per-call timeout that outlasts them.
		expect(createSessionMock.mock.calls[0][3]).toMatchObject({ timeoutMs: SESSION_CREATE_TIMEOUT_MS })
		// Must outlast the 30s WorkerClient default — large repos
		// exceed it and the session would otherwise abort mid-flight.
		expect(SESSION_CREATE_TIMEOUT_MS).toBeGreaterThan(30_000)
		expect(ui.custom).toHaveBeenCalledOnce()
	})

	it("refuses when a session with the requested name already exists", async () => {
		listSessionsMock.mockResolvedValue([{ name: "mysession", agentMode: "PTY" }])
		const { ctx, ui } = makeCtx()

		await expect(runTeleport("mysession --workspace 22222222-2222-4222-8222-222222222222", ctx)).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(listSessionsMock).toHaveBeenCalledOnce()
		expect(createSessionMock).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringMatching(/already exists.*Use \/remote-sessions to attach/),
			"error",
		)
	})

	it("refuses when listSessions fails", async () => {
		listSessionsMock.mockRejectedValue(new Error("boom"))
		const { ctx, ui } = makeCtx()

		await expect(runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(createSessionMock).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not list sessions/), "error")
	})

	it("cancels cleanly when the progress panel fires onCancel mid-flight: notify instead of throw", async () => {
		// Block at sandbox-ready so the cancel callback has time to fire.
		let releaseReady: () => void = () => {}
		waitReadyMock.mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					releaseReady = () => reject(new Error("aborted"))
				}),
		)
		const { ctx, ui } = makeCtx()

		const teleportPromise = runTeleport("mysession --workspace 22222222-2222-4222-8222-222222222222", ctx)

		// Wait a microtask so createTeleportProgress is invoked and we can
		// grab the onCancel hook from its options.
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		const onCancel = (progressMock.mock.calls[0]?.[1] as { onCancel?: () => void } | undefined)?.onCancel
		expect(onCancel).toBeTypeOf("function")
		onCancel?.()
		// The local abort cascades; release the blocking promise so the await unwinds.
		releaseReady()

		await expect(teleportPromise).resolves.toBeUndefined()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Teleport cancelled/), "info")
		// We had creds (auth succeeded before the cancel) → notify must include the workspace hint.
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringMatching(/Workspace .* is still up.*\/remote-sessions.*\/teleport/),
			"info",
		)
		expect(progressInstances[0]?.stop).toHaveBeenCalled()
		expect(createSessionMock).not.toHaveBeenCalled()
	})

	it("cancel before auth completes: notify has no workspace hint (creds were never set)", async () => {
		let releaseAuth: () => void = () => {}
		authMock.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					releaseAuth = () => reject(new Error("aborted"))
				}),
		)
		const { ctx, ui } = makeCtx()

		const teleportPromise = runTeleport("mysession --workspace 22222222-2222-4222-8222-222222222222", ctx)
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		const onCancel = (progressMock.mock.calls[0]?.[1] as { onCancel?: () => void } | undefined)?.onCancel
		onCancel?.()
		releaseAuth()

		await expect(teleportPromise).resolves.toBeUndefined()
		expect(ui.notify).toHaveBeenCalledWith("Teleport cancelled.", "info")
	})

	it("refuses without notifying when the picker is cancelled with Esc", async () => {
		listWorkspacesMock.mockResolvedValue([
			{
				id: "11111111-1111-4111-8111-111111111111",
				name: "one",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "active",
			},
		])
		pickWorkspaceMock.mockResolvedValue(undefined)
		const { ctx, ui } = makeCtx()

		await expect(runTeleport("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
		expect(ui.notify).not.toHaveBeenCalled()
	})

	it("generates a new workspace ID when there are no workspaces to pick", async () => {
		listWorkspacesMock.mockResolvedValue([])
		const { ctx } = makeCtx()

		await runTeleport("", ctx)

		expect(pickWorkspaceMock).not.toHaveBeenCalled()
		expect(authMock).toHaveBeenCalledOnce()
		const workspaceId = authMock.mock.calls[0][0] as string
		expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/)
	})

	it("--help shows the help modal and skips teleport", async () => {
		const { ctx, ui } = makeCtx()

		await runTeleport("--help", ctx)

		expect(ui.custom).toHaveBeenCalledTimes(1)
		expect(authMock).not.toHaveBeenCalled()
		expect(overlayMock).not.toHaveBeenCalled()
		expect(createSessionMock).not.toHaveBeenCalled()
		expect(readTeleportHelpSeenAtMock).not.toHaveBeenCalled()
		expect(writeTeleportHelpSeenAtMock).not.toHaveBeenCalled()
	})

	it("--help ignores other arguments and works without an apiKey", async () => {
		const { ctx } = makeCtx({ apiKey: "" })

		await runTeleport("name --workspace bogus --unknown --help extra", ctx)

		expect(authMock).not.toHaveBeenCalled()
		expect(overlayMock).not.toHaveBeenCalled()
	})

	it("refuses when apiKey is missing", async () => {
		const { ctx, ui } = makeCtx({ apiKey: "" })

		await expect(runTeleport("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/API key/), "error")
	})

	it("refuses when args fail to parse", async () => {
		const { ctx, ui } = makeCtx()

		await expect(runTeleport("--bogus", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Unknown flag/), "error")
	})

	it("generates a default session name when none is given", async () => {
		const { ctx } = makeCtx()

		await runTeleport("--workspace 11111111-1111-4111-8111-111111111111", ctx)

		expect(createSessionMock).toHaveBeenCalledOnce()
		const sessionName = createSessionMock.mock.calls[0][1] as string
		expect(sessionName).toMatch(/^pty-[0-9a-f]{8}$/)
	})

	describe("harness config sync", () => {
		it("calls provisionHarnessConfig with the resolved creds and completes the teleport", async () => {
			const { ctx, ui } = makeCtx()

			await runTeleport("mysession --workspace 22222222-2222-4222-8222-222222222222", ctx)

			expect(provisionHarnessConfigMock).toHaveBeenCalledOnce()
			expect(provisionHarnessConfigMock.mock.calls[0][0]).toMatchObject({
				remoteHost: CREDS.host,
				authToken: CREDS.connectToken,
			})
			// Teleport still completes — overlay opens, no warning emitted.
			expect(ui.custom).toHaveBeenCalledOnce()
			expect(ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/Could not sync harness config/), "warning")
		})

		it("syncs harness config even when workspace rsync is skipped (non-git cwd)", async () => {
			// cwd /work/proj is not a git repo, so shouldRsyncWorkspace is false
			// and the workspace runRsync is never invoked — but config sync must
			// still run. Pins the invariant that config sync is not gated behind
			// shouldRsyncWorkspace.
			const { ctx, ui } = makeCtx()

			await runTeleport("mysession --workspace 22222222-2222-4222-8222-222222222222", ctx)

			expect(provisionHarnessConfigMock).toHaveBeenCalledOnce()
			expect(ui.custom).toHaveBeenCalledOnce()
		})

		it("warns but continues when config sync fails", async () => {
			provisionHarnessConfigMock.mockResolvedValueOnce({ ok: false, error: "boom" })
			const { ctx, ui } = makeCtx()

			await runTeleport("mysession --workspace 22222222-2222-4222-8222-222222222222", ctx)

			expect(provisionHarnessConfigMock).toHaveBeenCalledOnce()
			expect(ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Could not sync harness config to sandbox: boom"),
				"warning",
			)
			// Teleport still completes — overlay opens, session created.
			expect(createSessionMock).toHaveBeenCalledOnce()
			expect(ui.custom).toHaveBeenCalledOnce()
		})
	})

	describe("git provisioning", () => {
		it("--git-repo: identity → credentials run in order before createSession with details.git", async () => {
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice", email: "a@example.com" })
			const order: string[] = []
			provisionGitIdentityMock.mockImplementation(async () => {
				order.push("identity")
			})
			provisionGitCredentialMock.mockImplementation(async () => {
				order.push("credential")
			})
			createSessionMock.mockImplementation(async () => {
				order.push("createSession")
				return {}
			})
			const { ctx } = makeCtx()

			await runTeleport(
				"--workspace 11111111-1111-4111-8111-111111111111 --git-repo https://github.com/me/x.git --branch main",
				ctx,
			)

			expect(order).toEqual(["identity", "credential", "createSession"])
			expect(createSessionMock.mock.calls[0][2]).toEqual({
				agentMode: "PTY",
				cwd: "/home/sandbox/x/",
				details: {
					git: {
						repo: "https://github.com/me/x.git",
						branch: "main",
						targetDirectory: "x",
					},
				},
			})
			expect(progressInstances[0]?.promptGitToken).not.toHaveBeenCalled()
		})

		it("--git-repo with no cached token: opens prompt via progress and writes token when save is checked", async () => {
			readGitTokenMock.mockReturnValue(undefined)
			promptGitTokenQueue.push({ outcome: "submitted", token: "ghp_new", save: true })
			const { ctx } = makeCtx()

			await runTeleport("--workspace 11111111-1111-4111-8111-111111111111 --git-repo https://github.com/me/x.git", ctx)

			expect(progressInstances[0]?.promptGitToken).toHaveBeenCalledWith("github.com")
			expect(writeGitTokenMock).toHaveBeenCalledWith("github.com", "ghp_new", undefined)
			expect(provisionGitCredentialMock).toHaveBeenCalledOnce()
			expect(provisionGitCredentialMock.mock.calls[0][1]).toMatchObject({
				gitHost: "github.com",
				gitToken: "ghp_new",
			})
		})

		it("invokes progress.promptGitToken when no cached token is available", async () => {
			readGitTokenMock.mockReturnValue(undefined)
			const { ctx } = makeCtx()

			await runTeleport("--workspace 11111111-1111-4111-8111-111111111111 --git-repo https://github.com/me/x.git", ctx)

			const ctrl = progressInstances[0]
			expect(ctrl?.promptGitToken).toHaveBeenCalledTimes(1)
			expect(ctrl?.promptGitToken).toHaveBeenCalledWith("github.com")
		})

		it("does NOT invoke progress.promptGitToken when a cached token is available", async () => {
			readGitTokenMock.mockReturnValue("ghp_cached")
			const { ctx } = makeCtx()

			await runTeleport("--workspace 11111111-1111-4111-8111-111111111111 --git-repo https://github.com/me/x.git", ctx)

			const ctrl = progressInstances[0]
			expect(ctrl?.promptGitToken).not.toHaveBeenCalled()
		})

		it("--no-git-token skips token resolution and credential propagation", async () => {
			readGitTokenMock.mockReturnValue("ghp_cached")
			const { ctx } = makeCtx()

			await runTeleport(
				"--workspace 11111111-1111-4111-8111-111111111111 --git-repo https://github.com/me/x.git --no-git-token",
				ctx,
			)

			expect(readGitTokenMock).not.toHaveBeenCalled()
			expect(progressInstances[0]?.promptGitToken).not.toHaveBeenCalled()
			expect(provisionGitCredentialMock).not.toHaveBeenCalled()
			expect(createSessionMock.mock.calls[0][2]).toMatchObject({
				details: { git: { repo: "https://github.com/me/x.git", targetDirectory: "x" } },
			})
		})

		it("local repo (no --git-repo): propagates identity + credentials, sends no details.git", async () => {
			getGitRemoteHostMock.mockResolvedValue("github.com")
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice" })
			const { ctx } = makeCtx()

			await runTeleport("--workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(provisionGitIdentityMock).toHaveBeenCalledOnce()
			expect(provisionGitCredentialMock).toHaveBeenCalledOnce()
			expect(createSessionMock.mock.calls[0][2]).toEqual({ agentMode: "PTY" })
		})

		it("warns (does not refuse) on identity/credential propagation failure", async () => {
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice" })
			provisionGitIdentityMock.mockRejectedValueOnce(new Error("identity boom"))
			provisionGitCredentialMock.mockRejectedValueOnce(new Error("cred boom"))
			const { ctx, ui } = makeCtx()

			await runTeleport("--workspace 11111111-1111-4111-8111-111111111111 --git-repo https://github.com/me/x.git", ctx)

			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("identity boom"), "warning")
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("cred boom"), "warning")
			// Worker is responsible for cloning now; createSession is still attempted.
			expect(createSessionMock).toHaveBeenCalledOnce()
		})

		it("rejects --no-shallow (removed in favor of worker-side clone)", async () => {
			const { ctx, ui } = makeCtx()

			await expect(
				runTeleport(
					"--workspace 11111111-1111-4111-8111-111111111111 --git-repo https://github.com/me/x.git --no-shallow",
					ctx,
				),
			).rejects.toBeInstanceOf(TeleportRefusal)
			expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Unknown flag/), "error")
		})
	})

	describe("session upload", () => {
		it("uploads an annotated temp copy of the session file and deletes it afterwards", async () => {
			const sessionFile = join(tempDir, "session.jsonl")
			writeFileSync(sessionFile, '{"type":"session"}\n')
			const { ctx } = makeCtx({ sessionFile })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(createSessionMock).toHaveBeenCalledOnce()
			const { sessionFile: uploaded } = createSessionMock.mock.calls[0][3]
			// The uploaded file is an annotated copy of the original — not the
			// original path — and the copy is cleaned up after upload.
			expect(uploaded).not.toBe(sessionFile)
			// The temp copy is removed again once the upload finished — otherwise
			// session JSONLs would pile up in the OS temp dir.
			expect(existsSync(uploaded)).toBe(false)
		})

		it("appends a [Teleport] handoff note as a user message to the uploaded session", async () => {
			const sessionFile = join(tempDir, "session.jsonl")
			const originalContent = '{"type":"session"}\n'
			writeFileSync(sessionFile, originalContent)
			const { ctx } = makeCtx({ sessionFile })

			// Read the uploaded file contents inside the createSession mock — the
			// temp copy is deleted right after upload, so we must capture it here.
			let capturedUpload = ""
			createSessionMock.mockImplementationOnce(async (_client, _name, _req, opts) => {
				capturedUpload = readFileSync(opts.sessionFile, "utf8")
				return { name: "mysession" }
			})

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			// Original session file is never mutated by the upload.
			expect(readFileSync(sessionFile, "utf8")).toBe(originalContent)

			// Original content survives the copy…
			expect(capturedUpload).toContain(originalContent.trimEnd())
			// …and the handoff note got appended as a parseable user-message entry,
			// so the resumed remote agent sees the environment change in context
			// (and the user sees it in the transcript).
			const noteLine = capturedUpload.split("\n").find((l) => l.includes("[Teleport]"))
			if (noteLine === undefined) throw new Error("handoff note line missing from uploaded JSONL")
			const parsed = JSON.parse(noteLine)
			expect(parsed.message.role).toBe("user")
			expect(parsed.message.content[0].text).toContain("Environment handoff")
		})

		it("--skip-session opts out even when a local session file exists", async () => {
			const sessionFile = join(tempDir, "session.jsonl")
			writeFileSync(sessionFile, '{"type":"session"}\n')
			const { ctx } = makeCtx({ sessionFile })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111 --skip-session", ctx)

			expect(createSessionMock.mock.calls[0][3]).toMatchObject({ sessionFile: undefined })
		})

		it("does not upload when no local session file is available", async () => {
			const { ctx } = makeCtx()

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(createSessionMock.mock.calls[0][3]).toMatchObject({ sessionFile: undefined })
		})

		it("silently skips upload when the session file path is stale (file missing)", async () => {
			const { ctx } = makeCtx({ sessionFile: join(tempDir, "does-not-exist.jsonl") })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(createSessionMock.mock.calls[0][3]).toMatchObject({ sessionFile: undefined })
		})
	})

	describe("compaction hint gate", () => {
		// 25 messages > the production lookback of 20, exercising the real
		// lookback path (a never-compacted session hints at any count).
		function writeSessionJsonl(timestamp: Date, messageCount = 25): string {
			const sessionFile = join(tempDir, "session.jsonl")
			const entry = {
				type: "message",
				timestamp: timestamp.toISOString(),
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			}
			writeFileSync(sessionFile, `${Array.from({ length: messageCount }, () => JSON.stringify(entry)).join("\n")}\n`)
			return sessionFile
		}

		function usageOf(tokens: number | null) {
			return () => ({ tokens, contextWindow: 200_000, percent: tokens === null ? null : tokens / 2000 })
		}

		beforeEach(() => {
			readTeleportCompactHintEnabledMock.mockReset().mockReturnValue(true)
		})

		// Above/below the production threshold (TELEPORT_COMPACT_HINT_DEFAULTS),
		// which the gate now uses directly.
		const BIG_TOKENS = 300_000
		const SMALL_TOKENS = 100_000

		it("refuses a big, recently active session before any network call", async () => {
			const sessionFile = writeSessionJsonl(new Date())
			const { ctx, ui } = makeCtx({ sessionFile, getContextUsage: usageOf(BIG_TOKENS) })

			await expect(
				runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx),
			).rejects.toBeInstanceOf(TeleportRefusal)
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("--no-compact-hint"), "error")
			// The gate runs before workspace resolution — no network, no progress UI.
			expect(authMock).not.toHaveBeenCalled()
			expect(listWorkspacesMock).not.toHaveBeenCalled()
			expect(progressInstances).toHaveLength(0)
		})

		it("proceeds for a big, fresh session when --no-compact-hint is passed", async () => {
			const sessionFile = writeSessionJsonl(new Date())
			const { ctx } = makeCtx({ sessionFile, getContextUsage: usageOf(BIG_TOKENS) })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111 --no-compact-hint", ctx)

			expect(authMock).toHaveBeenCalledOnce()
		})

		it("proceeds for a big, fresh session when the config disables the hint", async () => {
			readTeleportCompactHintEnabledMock.mockReturnValue(false)
			const sessionFile = writeSessionJsonl(new Date())
			const { ctx } = makeCtx({ sessionFile, getContextUsage: usageOf(BIG_TOKENS) })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(authMock).toHaveBeenCalledOnce()
		})

		it("proceeds for a small session", async () => {
			const sessionFile = writeSessionJsonl(new Date())
			const { ctx } = makeCtx({ sessionFile, getContextUsage: usageOf(SMALL_TOKENS) })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(authMock).toHaveBeenCalledOnce()
		})

		it("proceeds for a big but stale (2h old) session", async () => {
			const sessionFile = writeSessionJsonl(new Date(Date.now() - 2 * 60 * 60_000))
			const { ctx } = makeCtx({ sessionFile, getContextUsage: usageOf(BIG_TOKENS) })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(authMock).toHaveBeenCalledOnce()
		})

		it("proceeds when context usage reports tokens null (post-compaction unknown), even for a big fresh file", async () => {
			const sessionFile = writeSessionJsonl(new Date())
			const { ctx } = makeCtx({ sessionFile, getContextUsage: usageOf(null) })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(authMock).toHaveBeenCalledOnce()
		})

		it("proceeds silently when getContextUsage is unavailable (hint is non-critical)", async () => {
			const sessionFile = writeSessionJsonl(new Date())
			const { ctx } = makeCtx({ sessionFile })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(authMock).toHaveBeenCalledOnce()
		})

		it("proceeds when no session file is available", async () => {
			const { ctx } = makeCtx({ getContextUsage: usageOf(BIG_TOKENS) })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(authMock).toHaveBeenCalledOnce()
		})

		/**
		 * 25 fresh head messages (enough to hint if the whole file is evaluated),
		 * followed by one giant message line of `padBytes` that swallows the tail
		 * slice — the tail evaluation sees only a fragment of that line and can't
		 * decide, forcing the widen-to-whole-file fallback.
		 */
		function writeGiantSessionJsonl(padBytes: number): string {
			const sessionFile = join(tempDir, "session.jsonl")
			const timestamp = new Date().toISOString()
			const head = Array.from({ length: 25 }, () =>
				JSON.stringify({
					type: "message",
					timestamp,
					message: { role: "user", content: [{ type: "text", text: "hello" }] },
				}),
			)
			const giant = JSON.stringify({
				type: "message",
				timestamp,
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(padBytes) }] },
			})
			writeFileSync(sessionFile, `${[...head, giant].join("\n")}\n`)
			return sessionFile
		}

		it("skips the hint silently when an undecidable session file exceeds the widen cap", async () => {
			// The tail slice lies entirely inside the giant line, so the tail
			// evaluation can't decide — and at over SESSION_WIDEN_MAX_BYTES the
			// whole-file fallback is refused: the non-critical hint is skipped.
			const sessionFile = writeGiantSessionJsonl(SESSION_WIDEN_MAX_BYTES + 1024)
			const { ctx, ui } = makeCtx({ sessionFile, getContextUsage: usageOf(BIG_TOKENS) })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(authMock).toHaveBeenCalledOnce()
			expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("--no-compact-hint"), "error")
		})

		it("widens an undecidable file under the cap and still refuses a big fresh session", async () => {
			const sessionFile = writeGiantSessionJsonl(1024 * 1024)
			const { ctx, ui } = makeCtx({ sessionFile, getContextUsage: usageOf(BIG_TOKENS) })

			await expect(
				runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx),
			).rejects.toBeInstanceOf(TeleportRefusal)
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("--no-compact-hint"), "error")
		})
	})
})

describe("readSessionTail", () => {
	it("reads a file that fits the tail budget whole and marks it as such", async () => {
		const sessionFile = join(tempDir, "small.jsonl")
		const content = '{"type":"message","message":{"role":"user"}}\n{"type":"compaction"}\n'
		writeFileSync(sessionFile, content)

		const info = await readSessionTail(sessionFile)

		expect(info.tail).toBe(content)
		expect(info.tailIsWholeFile).toBe(true)
		expect(info.fileSizeBytes).toBe(Buffer.byteLength(content))
		expect(info.fileMtimeMs).toBeGreaterThan(0)
	})

	it("reads exactly the last SESSION_TAIL_BYTES when the file is larger", async () => {
		const sessionFile = join(tempDir, "large.jsonl")
		const body = "x".repeat(SESSION_TAIL_BYTES + 1000)
		writeFileSync(sessionFile, body)

		const info = await readSessionTail(sessionFile)

		expect(info.tailIsWholeFile).toBe(false)
		expect(info.tail).toBe("x".repeat(SESSION_TAIL_BYTES))
		expect(info.fileSizeBytes).toBe(SESSION_TAIL_BYTES + 1000)
	})
})

describe("runTeleport --fast", () => {
	const FAST_WS = "11111111-1111-4111-8111-111111111111"

	beforeEach(() => {
		resolveClonePlanMock.mockResolvedValue({
			url: "https://github.com/me/proj.git",
			httpsUrl: "https://github.com/me/proj.git",
			branch: "main",
		})
	})

	it("without --fast: clone plan / working-tree list are never touched", async () => {
		const { ctx } = makeCtx()

		await runTeleport(`mysession --workspace ${FAST_WS}`, ctx)

		expect(resolveClonePlanMock).not.toHaveBeenCalled()
		expect(buildChangedFilesListMock).not.toHaveBeenCalled()
	})

	it("clones server-side with details.git, then diff-rsyncs the working tree", async () => {
		const { ctx, ui } = makeCtx()

		await runTeleport(`mysession --workspace ${FAST_WS} --fast`, ctx)

		expect(resolveClonePlanMock).toHaveBeenCalledWith("/work/proj", undefined, expect.anything())
		expect(createSessionMock).toHaveBeenCalledOnce()
		expect(createSessionMock.mock.calls[0][2]).toMatchObject({
			agentMode: "PTY",
			cwd: "/home/sandbox/proj/",
			details: {
				git: {
					repo: "https://github.com/me/proj.git",
					branch: "main",
					targetDirectory: "proj",
				},
			},
		})
		expect(runRsyncMock).toHaveBeenCalledOnce()
		expect(runRsyncMock.mock.calls[0][0]).toMatchObject({
			localPath: "/work/proj",
			remotePath: "/home/sandbox/proj/",
			filesFrom: ["src/a.ts", "README.md"],
			deleteExtraneous: true,
			excludeFilters: [".git/", ".env", ".env.*", ".envrc", ".kimchi/"],
		})
		expect(buildIncludeListMock).not.toHaveBeenCalled()
		expect(ui.custom).toHaveBeenCalledOnce()
	})

	it("--git-repo URL mismatch refuses before touching the sandbox", async () => {
		const { ClonePlanError } = await import("../provisioning/clone-plan.js")
		resolveClonePlanMock.mockRejectedValue(
			new ClonePlanError("url-mismatch", "cwd origin X does not match --git-repo URL Y"),
		)
		const { ctx, ui } = makeCtx()

		await expect(
			runTeleport(`mysession --workspace ${FAST_WS} --git-repo https://github.com/me/y.git --fast`, ctx),
		).rejects.toBeInstanceOf(TeleportRefusal)
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cwd origin X does not match --git-repo URL Y"),
			"error",
		)
		expect(authMock).not.toHaveBeenCalled()
		expect(createSessionMock).not.toHaveBeenCalled()
		expect(runRsyncMock).not.toHaveBeenCalled()
	})

	it("freshClone=false: diff rsync skips --delete and warns", async () => {
		createSessionMock.mockResolvedValue({ freshClone: false })
		const { ctx, ui } = makeCtx()

		await runTeleport(`mysession --workspace ${FAST_WS} --fast`, ctx)

		expect(runRsyncMock.mock.calls[0][0]).toMatchObject({ deleteExtraneous: false })
		expect(ui.notify).toHaveBeenCalledWith(
			"Remote dir already existed — skipping pruning of extra remote files",
			"warning",
		)
	})

	it("diff-rsync failure warns, keeps the session, opens the overlay", async () => {
		runRsyncMock.mockRejectedValue(new Error("rsync boom"))
		const { ctx, ui } = makeCtx()

		await runTeleport(`mysession --workspace ${FAST_WS} --fast`, ctx)

		expect(createSessionMock).toHaveBeenCalledOnce()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("rsync boom"), "warning")
		expect(ui.custom).toHaveBeenCalledOnce()
	})

	it("unpushed branch: sends branch in details.git, worker falls back to checkout -B", async () => {
		resolveClonePlanMock.mockResolvedValue({
			url: "https://github.com/me/proj.git",
			httpsUrl: "https://github.com/me/proj.git",
			branch: "feat-x",
		})
		const { ctx, ui } = makeCtx()

		await runTeleport(`mysession --workspace ${FAST_WS} --fast`, ctx)

		expect(createSessionMock.mock.calls[0][2]).toMatchObject({
			details: { git: { branch: "feat-x" } },
		})
		expect(ui.custom).toHaveBeenCalledOnce()
	})

	it("clone failure: warns, retries createSession without details.git, then full rsync", async () => {
		createSessionMock.mockRejectedValueOnce(new Error("clone boom")).mockResolvedValueOnce({ freshClone: true })
		const { ctx, ui } = makeCtx()

		await runTeleport(`mysession --workspace ${FAST_WS} --fast`, ctx)

		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Clone-based provisioning failed: clone boom"),
			"warning",
		)
		expect(createSessionMock).toHaveBeenCalledTimes(2)
		expect(createSessionMock.mock.calls[1][2]).not.toHaveProperty("details")
		expect(buildIncludeListMock).toHaveBeenCalled()
		expect(runRsyncMock).toHaveBeenCalled()
	})
})
