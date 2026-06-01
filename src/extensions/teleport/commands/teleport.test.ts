import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
	getGitRemoteHostMock,
	parseHostMock,
	readGitTokenMock,
	writeGitTokenMock,
	promptForGitTokenMock,
	readLocalGitConfigMock,
	propagateGitConfigMock,
	propagateGitCredentialMock,
	cloneRepoMock,
	deriveSandboxDestMock,
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
		pauseInput: ReturnType<typeof vi.fn>
		resumeInput: ReturnType<typeof vi.fn>
	}>,
	getGitRemoteHostMock: vi.fn(),
	parseHostMock: vi.fn(),
	readGitTokenMock: vi.fn(),
	writeGitTokenMock: vi.fn(),
	promptForGitTokenMock: vi.fn(),
	readLocalGitConfigMock: vi.fn(),
	propagateGitConfigMock: vi.fn(),
	propagateGitCredentialMock: vi.fn(),
	cloneRepoMock: vi.fn(),
	deriveSandboxDestMock: vi.fn(),
}))

vi.mock("../../../sandbox/cloud/auth.js", () => ({ authenticateWorkspace: authMock }))
vi.mock("../../../sandbox/cloud/readiness.js", () => ({ waitForWorkspaceReady: waitReadyMock }))
vi.mock("../../../sandbox/cloud/workspaces.js", () => ({ listWorkspaces: listWorkspacesMock }))
vi.mock("../../../sandbox/worker/client.js", () => ({
	WorkerClient: class {
		constructor(_creds: unknown) {}
	},
}))
vi.mock("../../../sandbox/worker/sessions.js", () => ({
	listSessions: listSessionsMock,
	createSession: createSessionMock,
}))
vi.mock("../overlay/overlay-component.js", () => ({ createTabsOverlay: overlayMock }))
vi.mock("../ui/workspace-picker.js", () => ({ pickWorkspace: pickWorkspaceMock }))
vi.mock("../../../sandbox/git-credentials.js", () => ({
	getGitRemoteHost: getGitRemoteHostMock,
	parseHostFromRemoteUrl: parseHostMock,
}))
vi.mock("../../../config.js", () => ({
	readGitToken: readGitTokenMock,
	writeGitToken: writeGitTokenMock,
}))
vi.mock("../ui/git-token-prompt.js", () => ({ promptForGitToken: promptForGitTokenMock }))
vi.mock("../provisioning/git-propagate.js", () => ({
	readLocalGitConfig: readLocalGitConfigMock,
	propagateGitConfigToSandbox: propagateGitConfigMock,
	propagateGitCredentialToSandbox: propagateGitCredentialMock,
}))
vi.mock("../provisioning/git-clone.js", () => ({
	cloneRepoOnSandbox: cloneRepoMock,
	deriveSandboxDestFromRepoUrl: deriveSandboxDestMock,
}))
vi.mock("../ui/progress.js", () => ({
	createTeleportProgress: (...args: unknown[]) => {
		progressMock(...args)
		const controller = {
			step: vi.fn(),
			complete: vi.fn(),
			finish: vi.fn(),
			stop: vi.fn(),
			pauseInput: vi.fn(),
			resumeInput: vi.fn(),
		}
		progressInstances.push(controller)
		return controller
	},
}))

// State module reads/writes a fixed user path; we override it per-test via env.
let tempStatePath = ""
vi.mock("../state.js", () => {
	let cache: { lastWorkspaceId?: string; gitCredentialsSyncedWorkspaces: string[] } = {
		gitCredentialsSyncedWorkspaces: [],
	}
	return {
		readState: () => {
			try {
				return JSON.parse(readFileSync(tempStatePath, "utf-8"))
			} catch {
				return { ...cache }
			}
		},
		updateState: (update: (s: typeof cache) => void) => {
			const s = (() => {
				try {
					return JSON.parse(readFileSync(tempStatePath, "utf-8"))
				} catch {
					return { ...cache }
				}
			})()
			update(s)
			cache = s
			writeFileSync(tempStatePath, JSON.stringify(s))
		},
	}
})

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
	tempStatePath = join(tempDir, "state.json")
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
	getGitRemoteHostMock.mockReset().mockResolvedValue(undefined)
	parseHostMock.mockReset().mockImplementation((url: string) => (url.includes("github.com") ? "github.com" : undefined))
	readGitTokenMock.mockReset().mockReturnValue(undefined)
	writeGitTokenMock.mockReset()
	promptForGitTokenMock.mockReset().mockResolvedValue({ outcome: "skipped" })
	readLocalGitConfigMock.mockReset().mockResolvedValue({})
	propagateGitConfigMock.mockReset().mockResolvedValue(undefined)
	propagateGitCredentialMock.mockReset().mockResolvedValue(undefined)
	cloneRepoMock.mockReset().mockResolvedValue(undefined)
	deriveSandboxDestMock.mockReset().mockImplementation(
		(url: string) =>
			`/home/sandbox/${url
				.split("/")
				.pop()
				?.replace(/\.git$/, "")}/`,
	)
})

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe("runTeleport", () => {
	it("happy path: --workspace overrides cache, creates PTY session, opens overlay", async () => {
		writeFileSync(tempStatePath, JSON.stringify({ lastWorkspaceId: "cached", gitCredentialsSyncedWorkspaces: [] }))
		const { ctx, ui } = makeCtx()

		await runTeleport("mysession --workspace w-explicit", ctx)

		expect(listWorkspacesMock).not.toHaveBeenCalled()
		expect(authMock).toHaveBeenCalledOnce()
		expect(authMock.mock.calls[0][0]).toBe("w-explicit")
		expect(waitReadyMock).toHaveBeenCalledOnce()
		expect(listSessionsMock).toHaveBeenCalledOnce()
		expect(createSessionMock).toHaveBeenCalledOnce()
		expect(createSessionMock.mock.calls[0][1]).toBe("mysession")
		expect(createSessionMock.mock.calls[0][2]).toEqual({ agentMode: "PTY" })
		expect(ui.custom).toHaveBeenCalledOnce()

		const persisted = JSON.parse(readFileSync(tempStatePath, "utf-8"))
		expect(persisted.lastWorkspaceId).toBe("w-explicit")
		expect(ui.setHeader).toHaveBeenCalledWith(undefined)
	})

	it("uses the cached lastWorkspaceId when no --workspace is passed", async () => {
		writeFileSync(tempStatePath, JSON.stringify({ lastWorkspaceId: "w-cached", gitCredentialsSyncedWorkspaces: [] }))
		const { ctx } = makeCtx()

		await runTeleport("", ctx)

		expect(listWorkspacesMock).not.toHaveBeenCalled()
		expect(authMock.mock.calls[0][0]).toBe("w-cached")
	})

	it("attaches without POST when a session with the requested name exists", async () => {
		writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
		listSessionsMock.mockResolvedValue([{ name: "mysession", agentMode: "PTY" }])
		const { ctx } = makeCtx()

		await runTeleport("mysession --workspace w-explicit", ctx)

		expect(listSessionsMock).toHaveBeenCalledOnce()
		expect(createSessionMock).not.toHaveBeenCalled()
	})

	it("refuses when listSessions fails", async () => {
		writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
		listSessionsMock.mockRejectedValue(new Error("boom"))
		const { ctx, ui } = makeCtx()

		await expect(runTeleport("mysession --workspace w-1", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(createSessionMock).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not list sessions/), "error")
	})

	it("refuses without notifying when the picker is cancelled with Esc", async () => {
		writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
		listWorkspacesMock.mockResolvedValue([
			{ id: "w-1", name: "one", createdAt: new Date(), lastActivityAt: new Date(), status: "active" },
		])
		pickWorkspaceMock.mockResolvedValue(undefined)
		const { ctx, ui } = makeCtx()

		await expect(runTeleport("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
		expect(ui.notify).not.toHaveBeenCalled()
	})

	it("generates a new workspace ID when there are no workspaces to pick", async () => {
		writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
		listWorkspacesMock.mockResolvedValue([])
		const { ctx } = makeCtx()

		await runTeleport("", ctx)

		expect(pickWorkspaceMock).not.toHaveBeenCalled()
		expect(authMock).toHaveBeenCalledOnce()
		const workspaceId = authMock.mock.calls[0][0] as string
		expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/)
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
		writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
		const { ctx } = makeCtx()

		await runTeleport("--workspace w-1", ctx)

		expect(createSessionMock).toHaveBeenCalledOnce()
		const sessionName = createSessionMock.mock.calls[0][1] as string
		expect(sessionName).toMatch(/^pty-[0-9a-f]{8}$/)
	})

	describe("git provisioning", () => {
		it("--git-repo: identity → credentials → clone runs in order before createSession", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice", email: "a@example.com" })
			const order: string[] = []
			propagateGitConfigMock.mockImplementation(async () => {
				order.push("identity")
			})
			propagateGitCredentialMock.mockImplementation(async () => {
				order.push("credential")
			})
			cloneRepoMock.mockImplementation(async () => {
				order.push("clone")
			})
			createSessionMock.mockImplementation(async () => {
				order.push("createSession")
				return {}
			})
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1 --git-repo https://github.com/me/x.git --branch main", ctx)

			expect(order).toEqual(["identity", "credential", "clone", "createSession"])
			expect(cloneRepoMock.mock.calls[0][0]).toMatchObject({
				repoUrl: "https://github.com/me/x.git",
				branch: "main",
				shallow: true,
			})
			expect(createSessionMock.mock.calls[0][2]).toMatchObject({
				agentMode: "PTY",
				cwd: "/home/sandbox/x/",
			})
			expect(promptForGitTokenMock).not.toHaveBeenCalled()
		})

		it("--git-repo with no cached token: opens prompt and writes token when save is checked", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			readGitTokenMock.mockReturnValue(undefined)
			promptForGitTokenMock.mockResolvedValue({ outcome: "submitted", token: "ghp_new", save: true })
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1 --git-repo https://github.com/me/x.git", ctx)

			expect(promptForGitTokenMock).toHaveBeenCalledWith("github.com", expect.anything())
			expect(writeGitTokenMock).toHaveBeenCalledWith("github.com", "ghp_new", undefined)
			expect(propagateGitCredentialMock).toHaveBeenCalledOnce()
			expect(propagateGitCredentialMock.mock.calls[0][0]).toMatchObject({
				gitHost: "github.com",
				gitToken: "ghp_new",
			})
		})

		it("pauses and resumes the progress input lock around the git-token prompt", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			readGitTokenMock.mockReturnValue(undefined)
			let pauseCalled = false
			let resumeCalled = false
			promptForGitTokenMock.mockImplementation(async () => {
				// At the moment the prompt is open the lock must be paused but not yet resumed.
				const ctrl = progressInstances[0]
				pauseCalled = ctrl?.pauseInput.mock.calls.length === 1
				resumeCalled = (ctrl?.resumeInput.mock.calls.length ?? 0) > 0
				return { outcome: "submitted", token: "ghp_new", save: false }
			})
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1 --git-repo https://github.com/me/x.git", ctx)

			expect(pauseCalled).toBe(true)
			expect(resumeCalled).toBe(false)
			// After the prompt resolves, resumeInput is called exactly once.
			const ctrl = progressInstances[0]
			expect(ctrl?.pauseInput).toHaveBeenCalledTimes(1)
			expect(ctrl?.resumeInput).toHaveBeenCalledTimes(1)
		})

		it("resumes the input lock even when the prompt rejects", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			readGitTokenMock.mockReturnValue(undefined)
			promptForGitTokenMock.mockRejectedValue(new Error("prompt blew up"))
			const { ctx } = makeCtx()

			await expect(runTeleport("--workspace w-1 --git-repo https://github.com/me/x.git", ctx)).rejects.toThrow(
				"prompt blew up",
			)

			const ctrl = progressInstances[0]
			expect(ctrl?.pauseInput).toHaveBeenCalledTimes(1)
			expect(ctrl?.resumeInput).toHaveBeenCalledTimes(1)
		})

		it("does NOT pause the input lock when a cached token is available", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			readGitTokenMock.mockReturnValue("ghp_cached")
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1 --git-repo https://github.com/me/x.git", ctx)

			expect(promptForGitTokenMock).not.toHaveBeenCalled()
			const ctrl = progressInstances[0]
			expect(ctrl?.pauseInput).not.toHaveBeenCalled()
			expect(ctrl?.resumeInput).not.toHaveBeenCalled()
		})

		it("--no-git-token skips token resolution and credential propagation", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			readGitTokenMock.mockReturnValue("ghp_cached")
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1 --git-repo https://github.com/me/x.git --no-git-token", ctx)

			expect(readGitTokenMock).not.toHaveBeenCalled()
			expect(promptForGitTokenMock).not.toHaveBeenCalled()
			expect(propagateGitCredentialMock).not.toHaveBeenCalled()
			expect(cloneRepoMock).toHaveBeenCalledOnce()
		})

		it("local repo (no --git-repo): propagates identity + credentials, does not clone", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			getGitRemoteHostMock.mockResolvedValue("github.com")
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice" })
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1", ctx)

			expect(propagateGitConfigMock).toHaveBeenCalledOnce()
			expect(propagateGitCredentialMock).toHaveBeenCalledOnce()
			expect(cloneRepoMock).not.toHaveBeenCalled()
			expect(createSessionMock.mock.calls[0][2]).toEqual({ agentMode: "PTY" })
		})

		it("skips credential propagation when workspace is already in gitCredentialsSyncedWorkspaces", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: ["w-1"] }))
			getGitRemoteHostMock.mockResolvedValue("github.com")
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice" })
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1", ctx)

			expect(propagateGitCredentialMock).not.toHaveBeenCalled()
			// identity is not gated; it still runs
			expect(propagateGitConfigMock).toHaveBeenCalledOnce()
		})

		it("records workspaceId in gitCredentialsSyncedWorkspaces on first successful credential push", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			getGitRemoteHostMock.mockResolvedValue("github.com")
			readGitTokenMock.mockReturnValue("ghp_cached")
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1", ctx)

			const persisted = JSON.parse(readFileSync(tempStatePath, "utf-8"))
			expect(persisted.gitCredentialsSyncedWorkspaces).toContain("w-1")
		})

		it("clone failure is fatal; warns on identity/credential failure", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			readGitTokenMock.mockReturnValue("ghp_cached")
			readLocalGitConfigMock.mockResolvedValue({ name: "Alice" })
			propagateGitConfigMock.mockRejectedValueOnce(new Error("identity boom"))
			propagateGitCredentialMock.mockRejectedValueOnce(new Error("cred boom"))
			cloneRepoMock.mockRejectedValueOnce(new Error("clone boom"))
			const { ctx, ui } = makeCtx()

			await expect(runTeleport("--workspace w-1 --git-repo https://github.com/me/x.git", ctx)).rejects.toBeInstanceOf(
				TeleportRefusal,
			)

			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("identity boom"), "warning")
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("cred boom"), "warning")
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("clone boom"), "error")
			expect(createSessionMock).not.toHaveBeenCalled()
		})

		it("--no-shallow drops the shallow flag in cloneRepoOnSandbox", async () => {
			writeFileSync(tempStatePath, JSON.stringify({ gitCredentialsSyncedWorkspaces: [] }))
			const { ctx } = makeCtx()

			await runTeleport("--workspace w-1 --git-repo https://github.com/me/x.git --no-shallow", ctx)

			expect(cloneRepoMock.mock.calls[0][0]).toMatchObject({ shallow: false })
		})
	})
})
