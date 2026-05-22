import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionServices,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RemoteAuthError } from "./api/types.js"
import type { RemoteSessionSummary } from "./types.js"

type ExecAsyncImpl = (cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr: string }>

const cloneMock = vi.hoisted(() => vi.fn())

const { execAsyncMock, execMock, authMock, listMock, getMeMock, rsyncMock, waitMock } = vi.hoisted(() => {
	const execAsyncMock = vi.fn<ExecAsyncImpl>(async () => ({ stdout: "", stderr: "" }))
	const PROMISIFY = Symbol.for("nodejs.util.promisify.custom")
	const execMock: { (...args: unknown[]): void; [PROMISIFY]?: typeof execAsyncMock } = Object.assign(vi.fn(), {
		[PROMISIFY]: execAsyncMock,
	})
	return {
		execMock,
		execAsyncMock,
		authMock: vi.fn(),
		listMock: vi.fn(),
		getMeMock: vi.fn(),
		rsyncMock: vi.fn(),
		waitMock: vi.fn(),
	}
})

vi.mock("node:child_process", () => ({ exec: execMock }))
vi.mock("./api/index.js", () => ({
	authenticateRemoteSession: authMock,
	listRemoteSessions: listMock,
	getMe: getMeMock,
	waitForSessionReady: waitMock,
	RemoteAuthError: class RemoteAuthError extends Error {
		constructor(
			message: string,
			public readonly statusCode: number,
		) {
			super(message)
			this.name = "RemoteAuthError"
		}
	},
}))
vi.mock("./sync/rsync.js", () => ({
	runRsync: rsyncMock,
	BASE_EXCLUDE_GLOBS: [],
	RsyncError: class RsyncError extends Error {
		constructor(
			readonly exitCode: number,
			readonly stderr: string,
			message?: string,
		) {
			super(message ?? `rsync exited with code ${exitCode}`)
			this.name = "RsyncError"
		}
	},
}))

vi.mock("./commands/teleport-helpers.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./commands/teleport-helpers.js")>()
	return {
		...original,
		cloneRepoOnSandbox: cloneMock,
	}
})

// Imported after vi.mock so module resolution sees the mocks.
import {
	TeleportRefusal,
	deriveSandboxDest,
	deriveSandboxDestFromRepoUrl,
	runAttach,
	runConnect,
	runListSessions,
	runTeleport,
} from "./commands/index.js"
import { clearSessionCache } from "./commands/sessions.js"

class FakeSession {
	readonly sessionId: string
	readonly sessionManager = { getSessionId: () => this.sessionId }
	sessionName?: string
	isStreaming = false
	isBashRunning = false
	hasPendingBashMessages = false
	pendingMessageCount = 0
	abortBash = vi.fn()
	abortRetry = vi.fn()
	dispose = vi.fn()
	setSessionName = vi.fn(async (_n: string) => undefined)
	exportToJsonl = vi.fn((path: string) => {
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: "/work/proj",
		})
		const entry = JSON.stringify({
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "hi" },
		})
		const fs = require("node:fs")
		fs.writeFileSync(path, `${header}\n${entry}\n`, "utf-8")
		return path
	})
	switchSession = vi.fn(async (_path: string) => undefined)
	getMessages = vi.fn(async () => ({ messages: [] }))
	getState = vi.fn(async () => ({}))
	private listeners = new Set<AgentSessionEventListener>()

	constructor(sessionId: string, name?: string) {
		this.sessionId = sessionId
		this.sessionName = name
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	emit(event: AgentSessionEvent): void {
		for (const l of [...this.listeners]) l(event)
	}
}

function asSession(f: FakeSession): AgentSession {
	return f as unknown as AgentSession
}

function makeUI() {
	return {
		notify: vi.fn(),
		setStatus: vi.fn(),
		confirm: vi.fn(),
		select: vi.fn(),
		input: vi.fn(),
		editor: vi.fn(),
		setTitle: vi.fn(),
		setWidget: vi.fn(),
		setHeader: vi.fn(),
		setEditorText: vi.fn(),
		onTerminalInput: vi.fn(() => vi.fn()),
		custom: vi.fn(async () => undefined),
	} as unknown as ExtensionUIContext & {
		notify: ReturnType<typeof vi.fn>
		setStatus: ReturnType<typeof vi.fn>
		custom: ReturnType<typeof vi.fn>
	}
}

function makeCtx(homeBase: FakeSession) {
	const ui = makeUI()
	const services = {} as unknown as AgentSessionServices
	const ctx: import("./commands/types.js").TeleportContext = {
		session: asSession(homeBase),
		services,
		apiKey: "test-key",
		endpoint: "https://api.example.com",
		cwd: "/work/proj",
		ui,
		gitCredentialsSynced: new Set(),
	}
	return { ui, ctx }
}

function setExecOutputs(map: Record<string, { stdout?: string; err?: Error }>) {
	execAsyncMock.mockImplementation(async (cmd: string, _opts?: unknown) => {
		for (const [needle, response] of Object.entries(map)) {
			if (cmd.includes(needle)) {
				if (response.err) throw response.err
				return { stdout: response.stdout ?? "", stderr: "" }
			}
		}
		return { stdout: "", stderr: "" }
	})
}

const HAPPY_EXEC: Parameters<typeof setExecOutputs>[0] = {
	"command -v rsync": { stdout: "/usr/bin/rsync" },
	"du -sk": { stdout: "100 /work/proj" },
	"status --porcelain": { stdout: "" },
}

const AUTH_OK = {
	connectToken: "ct-1",
	wsUrl: "wss://host.example.com",
	expiresAt: "2026-01-01T00:00:00Z",
	host: "host.example.com",
	port: 443,
}

beforeEach(() => {
	clearSessionCache()
	// Be sure to use the local proxy-helper
	vi.stubEnv("KIMCHI_PROXY_HELPER", "bin/proxy-helper")
	execAsyncMock.mockReset()
	execAsyncMock.mockImplementation(async () => ({ stdout: "", stderr: "" }))
	authMock.mockReset()
	listMock.mockReset()
	getMeMock.mockReset()
	getMeMock.mockResolvedValue({ id: "test-user" })
	rsyncMock.mockReset()
	waitMock.mockReset()
	waitMock.mockResolvedValue(undefined)
	cloneMock.mockReset()
	cloneMock.mockResolvedValue(undefined)
	setExecOutputs(HAPPY_EXEC)
	authMock.mockResolvedValue(AUTH_OK)
	listMock.mockResolvedValue([])
	rsyncMock.mockResolvedValue({ fileCount: 1, totalBytes: 0, durationMs: 1 })
})

afterEach(() => {
	vi.restoreAllMocks()
})

// ───────────────────────── runTeleport ─────────────────────────

describe("runTeleport", () => {
	function makeRunChildMock() {
		const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
		const runChild = vi.fn(async (opts: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }) => {
			calls.push({ cmd: opts.cmd, args: opts.args, env: opts.env })
			return 0
		})
		return { runChild, calls }
	}

	it("happy path: auth → rsync → ssh+tmux", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		const { runChild, calls } = makeRunChildMock()

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
			{ _runChildWithTTYHandoff: runChild },
		)

		expect(authMock).toHaveBeenCalledOnce()
		// Two rsync calls: workspace + session file.
		expect(rsyncMock).toHaveBeenCalledTimes(2)
		// runRsync was called with the per-teleport subdir as the destination.
		const rsyncCall = rsyncMock.mock.calls[0][0] as { destination?: string }
		expect(rsyncCall.destination).toBe("/home/sandbox/proj/")

		// Session file was also synced to the remote session dir.
		const sessionRsyncCall = rsyncMock.mock.calls[1][0] as {
			destination?: string
			deleteExtraneous?: boolean
		}
		expect(sessionRsyncCall.destination).toBe("/home/sandbox/.pi/agent/sessions/--home-sandbox-proj--")
		expect(sessionRsyncCall.deleteExtraneous).toBe(false)

		// SSH was spawned for interactive shell.
		expect(calls).toHaveLength(1)
		expect(calls[0].cmd).toBe("ssh")
		expect(calls[0].args).toContain("-t")
		expect(calls[0].args).toContain("sandbox@host.example.com")
		expect(calls[0].env?.AUTH_TOKEN).toBe("ct-1")
	})

	it("--skip-session omits session copy and only rsyncs workspace", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		const { runChild } = makeRunChildMock()

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false, skipSession: true },
			ctx,
			{ _runChildWithTTYHandoff: runChild },
		)

		// Only workspace rsync — no session export or sync.
		expect(rsyncMock).toHaveBeenCalledTimes(1)
		expect(runChild).toHaveBeenCalledOnce()
	})

	it("tolerates session-sync failure and continues", async () => {
		const home = new FakeSession("local-1")
		const { ctx, ui } = makeCtx(home)
		const { runChild } = makeRunChildMock()
		// First rsync (workspace) succeeds, second (session file) fails.
		rsyncMock.mockResolvedValueOnce({ fileCount: 1, totalBytes: 0, durationMs: 1 })
		rsyncMock.mockRejectedValueOnce(new Error("session sync fail"))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
			{ _runChildWithTTYHandoff: runChild },
		)

		// Only workspace rsync succeeded; session sync failed.
		expect(rsyncMock).toHaveBeenCalledTimes(2)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Session sync failed/), "warning")
		// SSH+tmux still launched despite session sync failure.
		expect(runChild).toHaveBeenCalledOnce()
	})

	it("refuses when home base is busy without --abandon-pending", async () => {
		const home = new FakeSession("local-1")
		home.isStreaming = true
		const { ctx } = makeCtx(home)

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toBeInstanceOf(TeleportRefusal)
	})

	it("--abandon-pending aborts in-flight work then proceeds", async () => {
		const home = new FakeSession("local-1")
		home.isStreaming = true
		home.abortBash = vi.fn(() => {
			home.isStreaming = false
		})
		const { ctx } = makeCtx(home)
		const { runChild } = makeRunChildMock()

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: true, force: false },
			ctx,
			{ _runChildWithTTYHandoff: runChild },
		)
		expect(home.abortBash).toHaveBeenCalled()
		expect(rsyncMock).toHaveBeenCalled()
	})

	it("refuses when rsync is missing from PATH", async () => {
		setExecOutputs({
			...HAPPY_EXEC,
			"command -v rsync": { err: new Error("not found") },
		})
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toThrow(/rsync/)
	})

	it("refuses on dirty tree without --allow-dirty", async () => {
		setExecOutputs({
			...HAPPY_EXEC,
			"status --porcelain": { stdout: " M src/a.ts\n" },
		})
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toThrow(/--allow-dirty/)
	})

	it("refuses on workspace > 5GB without --force", async () => {
		const sixGbKb = 6 * 1024 * 1024
		setExecOutputs({
			...HAPPY_EXEC,
			"du -sk": { stdout: `${sixGbKb} /work/proj` },
		})
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toThrow(/--force/)
	})

	it("reuses an existing session when name matches", async () => {
		listMock.mockResolvedValueOnce([
			{
				id: "existing-id",
				name: "feature-x",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle" as const,
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		const { runChild, calls } = makeRunChildMock()

		await runTeleport(
			{
				name: "feature-x",
				allowDirty: false,
				exclude: [],
				includeIgnored: false,
				abandonPending: false,
				force: false,
			},
			ctx,
			{ _runChildWithTTYHandoff: runChild },
		)

		// Should authenticate with the existing session ID, not create a new one.
		expect(authMock).toHaveBeenCalledWith("existing-id", expect.anything(), expect.anything(), expect.anything())
		expect(calls).toHaveLength(1)
		expect(ctx.lastSessionId).toBe("existing-id")
	})

	it("refuses cleanly on auth failure without attempting rsync", async () => {
		authMock.mockRejectedValueOnce(new RemoteAuthError("bad key", 401))
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toThrow(/Authentication failed/)
		expect(rsyncMock).not.toHaveBeenCalled()
	})

	it("waits for the sandbox to become ready between auth and rsync", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		const { runChild } = makeRunChildMock()

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
			{ _runChildWithTTYHandoff: runChild },
		)

		expect(waitMock).toHaveBeenCalledOnce()
		const authOrder = authMock.mock.invocationCallOrder[0]
		const waitOrder = waitMock.mock.invocationCallOrder[0]
		const rsyncOrder = rsyncMock.mock.invocationCallOrder[0]
		expect(waitOrder).toBeGreaterThan(authOrder)
		expect(rsyncOrder).toBeGreaterThan(waitOrder)
	})

	it("refuses when the sandbox never becomes ready", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		waitMock.mockRejectedValueOnce(new Error("Session did not become ready within 90s (last probe: timeout)"))

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toThrow(/Sandbox never became ready/)
		expect(rsyncMock).not.toHaveBeenCalled()
	})

	it("rsync runs after auth", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		const { runChild } = makeRunChildMock()

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
			{ _runChildWithTTYHandoff: runChild },
		)

		const authOrder = authMock.mock.invocationCallOrder[0]
		const rsyncOrder = rsyncMock.mock.invocationCallOrder[0]
		expect(rsyncOrder).toBeGreaterThan(authOrder)
	})

	it("surfaces a warning when ssh exits non-zero", async () => {
		const home = new FakeSession("local-1")
		const { ctx, ui } = makeCtx(home)
		const runChild = vi.fn(async () => 255)

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
			{ _runChildWithTTYHandoff: runChild },
		)

		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/ssh exited with code 255/), "warning")
	})
})

// ───────────────────────── runAttach ─────────────────────────

describe("runAttach", () => {
	function makeRunChildMock() {
		const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
		const runChild = vi.fn(async (opts: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }) => {
			calls.push({ cmd: opts.cmd, args: opts.args, env: opts.env })
			return 0
		})
		return { runChild, calls }
	}

	it("resolves a server-side session by id and spawns ssh", async () => {
		const home = new FakeSession("local-1")
		listMock.mockResolvedValueOnce([
			{
				id: "remote-server",
				name: "beta",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const { ctx } = makeCtx(home)
		const { runChild, calls } = makeRunChildMock()

		await runAttach({ target: "remote-server" }, ctx, { _runChildWithTTYHandoff: runChild })

		expect(listMock).toHaveBeenCalledOnce()
		expect(authMock).toHaveBeenCalledWith("remote-server", expect.anything(), expect.anything(), expect.anything())
		expect(calls).toHaveLength(1)
		expect(calls[0].args).toContain("-t")
	})

	it("resolves a server-side session by name", async () => {
		const home = new FakeSession("local-1")
		listMock.mockResolvedValueOnce([
			{
				id: "remote-server",
				name: "beta",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const { ctx } = makeCtx(home)
		const { runChild, calls } = makeRunChildMock()

		await runAttach({ target: "beta" }, ctx, { _runChildWithTTYHandoff: runChild })

		expect(authMock).toHaveBeenCalledWith("remote-server", expect.anything(), expect.anything(), expect.anything())
		expect(calls).toHaveLength(1)
	})

	it("refuses on unknown target and offers close matches", async () => {
		listMock.mockResolvedValueOnce([
			{
				id: "a",
				name: "feature-xy",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const home = new FakeSession("local-1")
		const { ctx, ui } = makeCtx(home)
		const { runChild } = makeRunChildMock()

		await expect(runAttach({ target: "feature-xz" }, ctx, { _runChildWithTTYHandoff: runChild })).rejects.toThrow(
			/feature-xy/,
		)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Did you mean/), "error")
		expect(runChild).not.toHaveBeenCalled()
	})

	it("refuses on completed session", async () => {
		listMock.mockResolvedValueOnce([
			{
				id: "x",
				name: "done",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "completed",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		const { runChild } = makeRunChildMock()

		await expect(runAttach({ target: "done" }, ctx, { _runChildWithTTYHandoff: runChild })).rejects.toThrow(/completed/)
		expect(runChild).not.toHaveBeenCalled()
	})

	it("refuses on auth failure and does not spawn ssh", async () => {
		const home = new FakeSession("local-1")
		listMock.mockResolvedValueOnce([
			{
				id: "remote-1",
				name: "test",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const { ctx } = makeCtx(home)
		authMock.mockRejectedValueOnce(new RemoteAuthError("bad token", 401))
		const { runChild } = makeRunChildMock()

		await expect(runAttach({ target: "remote-1" }, ctx, { _runChildWithTTYHandoff: runChild })).rejects.toThrow(
			/Authentication failed/,
		)
		expect(runChild).not.toHaveBeenCalled()
	})

	it("surfaces a warning when ssh exits non-zero", async () => {
		const home = new FakeSession("local-1")
		listMock.mockResolvedValueOnce([
			{
				id: "remote-1",
				name: "test",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const { ctx, ui } = makeCtx(home)
		const runChild = vi.fn(async () => 255)

		await runAttach({ target: "remote-1" }, ctx, { _runChildWithTTYHandoff: runChild })

		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/ssh exited with code 255/), "warning")
	})
})

// ───────────────────────── runListSessions ─────────────────────────

describe("runListSessions", () => {
	it("always opens the panel (even when empty)", async () => {
		const home = new FakeSession("local-1")
		const { ctx, ui } = makeCtx(home)

		await runListSessions(ctx)
		// Panel is always shown — data arrives asynchronously.
		expect(ui.custom).toHaveBeenCalledOnce()
	})

	it("calls getMe and forwards id as creatorId to listRemoteSessions", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		getMeMock.mockResolvedValueOnce({ id: "user-42", email: "u@example.com" })

		await runListSessions(ctx)

		expect(getMeMock).toHaveBeenCalledWith("test-key", { endpoint: "https://api.example.com" })
		expect(listMock).toHaveBeenCalledWith(
			"test-key",
			expect.objectContaining({ creatorId: "user-42", endpoint: "https://api.example.com" }),
		)
	})

	it("still lists sessions (unfiltered) when getMe fails", async () => {
		const home = new FakeSession("local-1")
		const { ctx, ui } = makeCtx(home)
		getMeMock.mockRejectedValueOnce(new Error("me unavailable"))

		await runListSessions(ctx)

		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not fetch current user/), "warning")
		expect(listMock).toHaveBeenCalledWith("test-key", expect.objectContaining({ creatorId: undefined }))
	})
})

// ───────────────────────── runConnect ─────────────────────────

describe("runConnect", () => {
	function makeRunChildMock() {
		const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
		const runChild = vi.fn(async (opts: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }) => {
			calls.push({ cmd: opts.cmd, args: opts.args, env: opts.env })
			return 0
		})
		return { runChild, calls }
	}

	it("refuses when no target and no lastSessionId", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		const { runChild } = makeRunChildMock()

		await expect(runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
		expect(runChild).not.toHaveBeenCalled()
	})

	it("uses lastSessionId when no target is given", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		ctx.lastSessionId = "last-1234567890"
		const { runChild, calls } = makeRunChildMock()

		await runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })

		expect(authMock).toHaveBeenCalledWith("last-1234567890", "test-key", "Remote session for proj", {
			endpoint: "https://api.example.com",
		})
		expect(listMock).not.toHaveBeenCalled()
		expect(calls).toHaveLength(1)
		expect(calls[0].cmd).toBe("ssh")
		expect(calls[0].args).toContain("sandbox@host.example.com")
		expect(calls[0].env?.AUTH_TOKEN).toBe("ct-1")
	})

	it("resolves a server-side target by name", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		listMock.mockResolvedValueOnce([
			{
				id: "srvr-1",
				name: "beta",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const { runChild, calls } = makeRunChildMock()

		await runConnect({ target: "beta" }, ctx, { _runChildWithTTYHandoff: runChild })

		expect(listMock).toHaveBeenCalledOnce()
		expect(authMock).toHaveBeenCalledWith("srvr-1", expect.anything(), expect.anything(), expect.anything())
		expect(calls).toHaveLength(1)
	})

	it("refuses on a completed target", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		listMock.mockResolvedValueOnce([
			{
				id: "x",
				name: "done",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "completed",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const { runChild } = makeRunChildMock()

		await expect(runConnect({ target: "done" }, ctx, { _runChildWithTTYHandoff: runChild })).rejects.toThrow(
			/completed/,
		)
		expect(authMock).not.toHaveBeenCalled()
		expect(runChild).not.toHaveBeenCalled()
	})

	it("refuses on auth failure and does not spawn ssh", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		ctx.lastSessionId = "fg-id"
		authMock.mockRejectedValueOnce(new RemoteAuthError("bad token", 401))
		const { runChild } = makeRunChildMock()

		await expect(runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })).rejects.toThrow(/Authentication failed/)
		expect(runChild).not.toHaveBeenCalled()
	})

	it("surfaces a warning when ssh exits non-zero", async () => {
		const home = new FakeSession("local-1")
		const { ctx, ui } = makeCtx(home)
		ctx.lastSessionId = "fg-id"
		const runChild = vi.fn(async () => 255)

		await runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })

		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/ssh exited with code 255/), "warning")
	})
})

// ───────────────────────── deriveSandboxDest ─────────────────────────

describe("deriveSandboxDest", () => {
	it("uses the basename of the local source cwd", () => {
		expect(deriveSandboxDest("/Users/me/projects/my-app")).toBe("/home/sandbox/my-app/")
	})

	it("strips trailing slashes before taking the basename", () => {
		expect(deriveSandboxDest("/Users/me/projects/my-app/")).toBe("/home/sandbox/my-app/")
		expect(deriveSandboxDest("/Users/me/projects/my-app///")).toBe("/home/sandbox/my-app/")
	})

	it("falls back to 'workspace' when basename would be empty", () => {
		expect(deriveSandboxDest("/")).toBe("/home/sandbox/workspace/")
		expect(deriveSandboxDest("")).toBe("/home/sandbox/workspace/")
	})

	it("preserves spaces and unusual chars (shellEscape handles them downstream)", () => {
		expect(deriveSandboxDest("/Users/me/my project")).toBe("/home/sandbox/my project/")
		expect(deriveSandboxDest("/Users/me/proj v2.0")).toBe("/home/sandbox/proj v2.0/")
	})

	it("uses the deepest path component for nested sources", () => {
		expect(deriveSandboxDest("/Users/me/work/clients/acme/api-v3")).toBe("/home/sandbox/api-v3/")
	})

	it("keeps leading-dot names (e.g. .dotfiles dir is valid)", () => {
		expect(deriveSandboxDest("/Users/me/.dotfiles")).toBe("/home/sandbox/.dotfiles/")
	})
})

// ───────────────────────── deriveSandboxDestFromRepoUrl ─────────────────────────

describe("deriveSandboxDestFromRepoUrl", () => {
	it("extracts repo name from HTTPS URL", () => {
		expect(deriveSandboxDestFromRepoUrl("https://github.com/org/my-repo.git")).toBe("/home/sandbox/my-repo/")
	})

	it("extracts repo name from HTTPS URL without .git", () => {
		expect(deriveSandboxDestFromRepoUrl("https://github.com/org/my-repo")).toBe("/home/sandbox/my-repo/")
	})

	it("extracts repo name from SSH shorthand", () => {
		expect(deriveSandboxDestFromRepoUrl("git@github.com:org/my-repo.git")).toBe("/home/sandbox/my-repo/")
	})

	it("extracts repo name from SSH shorthand without .git", () => {
		expect(deriveSandboxDestFromRepoUrl("git@github.com:org/my-repo")).toBe("/home/sandbox/my-repo/")
	})

	it("handles nested paths in HTTPS URLs", () => {
		expect(deriveSandboxDestFromRepoUrl("https://gitlab.com/group/subgroup/project.git")).toBe("/home/sandbox/project/")
	})

	it("falls back to workspace for unparseable URLs", () => {
		expect(deriveSandboxDestFromRepoUrl("")).toBe("/home/sandbox/workspace/")
	})
})
