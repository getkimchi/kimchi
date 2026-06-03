import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
	propagateGitConfigMock,
	propagateGitCredentialMock,
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
	propagateGitConfigMock: vi.fn(),
	propagateGitCredentialMock: vi.fn(),
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
}))
vi.mock("../../../config.js", () => ({
	readGitToken: readGitTokenMock,
	writeGitToken: writeGitTokenMock,
	readTeleportHelpSeenAt: readTeleportHelpSeenAtMock,
	writeTeleportHelpSeenAt: writeTeleportHelpSeenAtMock,
}))
vi.mock("../provisioning/git-propagate.js", () => ({
	readLocalGitConfig: readLocalGitConfigMock,
	propagateGitConfigToSandbox: propagateGitConfigMock,
	propagateGitCredentialToSandbox: propagateGitCredentialMock,
}))
vi.mock("../ui/progress.js", () => ({
	createTeleportProgress: (...args: unknown[]) => {
		progressMock(...args)
		const controller = {
			step: vi.fn(),
			complete: vi.fn(),
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
import { runTeleport } from "./teleport.js"

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
	createSessionMock.mockReset().mockResolvedValue({})
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
	propagateGitConfigMock.mockReset().mockResolvedValue(undefined)
	propagateGitCredentialMock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe("runTeleport", () => {
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
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/already exists.*Use \/sessions to attach/), "error")
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

	describe("git provisioning", () => {
		it("--git-repo: identity → credentials run in order before createSession with details.git", async () => {
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice", email: "a@example.com" })
			const order: string[] = []
			propagateGitConfigMock.mockImplementation(async () => {
				order.push("identity")
			})
			propagateGitCredentialMock.mockImplementation(async () => {
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
			expect(propagateGitCredentialMock).toHaveBeenCalledOnce()
			expect(propagateGitCredentialMock.mock.calls[0][0]).toMatchObject({
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
			expect(propagateGitCredentialMock).not.toHaveBeenCalled()
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

			expect(propagateGitConfigMock).toHaveBeenCalledOnce()
			expect(propagateGitCredentialMock).toHaveBeenCalledOnce()
			expect(createSessionMock.mock.calls[0][2]).toEqual({ agentMode: "PTY" })
		})

		it("warns (does not refuse) on identity/credential propagation failure", async () => {
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice" })
			propagateGitConfigMock.mockRejectedValueOnce(new Error("identity boom"))
			propagateGitCredentialMock.mockRejectedValueOnce(new Error("cred boom"))
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
		it("uploads the local session file when one is present", async () => {
			const sessionFile = join(tempDir, "session.jsonl")
			writeFileSync(sessionFile, '{"type":"session"}\n')
			const { ctx } = makeCtx({ sessionFile })

			await runTeleport("mysession --workspace 11111111-1111-4111-8111-111111111111", ctx)

			expect(createSessionMock).toHaveBeenCalledOnce()
			expect(createSessionMock.mock.calls[0][3]).toMatchObject({ sessionFile })
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
})
