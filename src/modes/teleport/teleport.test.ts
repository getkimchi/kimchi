import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionServices,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RemoteAuthError } from "./api/types.js"
import type { RemoteAgentSession } from "./proxy/agent-session.js"
import { TeleportableAgentSession } from "./proxy/teleportable-session.js"
import type { RemoteSessionSummary } from "./types.js"

type ExecAsyncImpl = (cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr: string }>

const cloneMock = vi.hoisted(() => vi.fn())

const { execAsyncMock, execMock, authMock, listMock, getMeMock, buildMock, rsyncMock, waitMock } = vi.hoisted(() => {
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
		buildMock: vi.fn(),
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
vi.mock("./proxy/builder.js", () => ({
	buildRemoteAgentSession: buildMock,
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
	runDetach,
	runListSessions,
	runTeleport,
} from "./commands/index.js"

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
function asRemote(f: FakeSession): RemoteAgentSession {
	return f as unknown as RemoteAgentSession
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

function makeCtx(homeBase: FakeSession, opts: { triggerRebind?: () => Promise<void> } = {}) {
	const wrapper = TeleportableAgentSession.create(asSession(homeBase))
	const ui = makeUI()
	const services = {} as unknown as AgentSessionServices
	const triggerRebind = opts.triggerRebind ?? vi.fn(async () => {})
	const ctx: {
		wrapper: TeleportableAgentSession
		services: AgentSessionServices
		apiKey: string
		endpoint: string
		cwd: string
		ui: ReturnType<typeof makeUI>
		triggerRebind: () => Promise<void>
		onHostResolved?: (host: string) => void
	} = {
		wrapper,
		services,
		apiKey: "test-key",
		endpoint: "https://api.example.com",
		cwd: "/work/proj",
		ui,
		triggerRebind,
	}
	return { wrapper, ui, triggerRebind, ctx }
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
	// Be sure to use the local proxy-helper
	vi.stubEnv("KIMCHI_PROXY_HELPER", "bin/proxy-helper")
	execAsyncMock.mockReset()
	execAsyncMock.mockImplementation(async () => ({ stdout: "", stderr: "" }))
	authMock.mockReset()
	listMock.mockReset()
	getMeMock.mockReset()
	getMeMock.mockResolvedValue({ id: "test-user" })
	buildMock.mockReset()
	rsyncMock.mockReset()
	waitMock.mockReset()
	cloneMock.mockReset()
	cloneMock.mockResolvedValue(undefined)
	waitMock.mockResolvedValue({
		id: "sess",
		organizationId: "org",
		status: "ACTIVE",
		uri: "wss://host.example.com",
		createTime: "2026-01-01T00:00:00Z",
	})
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
	it("happy path: auth → rsync → build → swap → notify", async () => {
		const home = new FakeSession("local-1")
		const { wrapper, ctx, ui } = makeCtx(home)
		const remote = new FakeSession("remote-1")
		buildMock.mockResolvedValueOnce(asRemote(remote))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
		)

		expect(authMock).toHaveBeenCalledOnce()
		// Two rsync calls: workspace + session file.
		expect(rsyncMock).toHaveBeenCalledTimes(2)
		expect(buildMock).toHaveBeenCalledOnce()
		expect(wrapper.foreground).toBe(asRemote(remote))
		// runRsync was called with the per-teleport subdir as the destination.
		const rsyncCall = rsyncMock.mock.calls[0][0] as { destination?: string }
		expect(rsyncCall.destination).toBe("/home/sandbox/proj/")

		// Session file was also synced to the remote session dir.
		const sessionRsyncCall = rsyncMock.mock.calls[1][0] as { destination?: string; deleteExtraneous?: boolean }
		expect(sessionRsyncCall.destination).toBe("/home/sandbox/.pi/agent/sessions/--home-sandbox-proj--")
		expect(sessionRsyncCall.deleteExtraneous).toBe(false)

		// Remote received switchSession + getMessages + getState.
		expect(remote.switchSession).toHaveBeenCalledOnce()
		const switchedPath = (remote.switchSession.mock.calls[0] as [string])[0]
		expect(switchedPath).toBe("/home/sandbox/.pi/agent/sessions/--home-sandbox-proj--/teleport-session-export.jsonl")
		expect(remote.getMessages).toHaveBeenCalledOnce()
		expect(remote.getState).toHaveBeenCalledOnce()
	})

	it("--skip-session omits session copy and only rsyncs workspace", async () => {
		const home = new FakeSession("local-1")
		const { wrapper, ctx } = makeCtx(home)
		const remote = new FakeSession("remote-1")
		buildMock.mockResolvedValueOnce(asRemote(remote))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false, skipSession: true },
			ctx,
		)

		// Only workspace rsync — no session export or sync.
		expect(rsyncMock).toHaveBeenCalledTimes(1)
		expect(remote.switchSession).not.toHaveBeenCalled()
		expect(remote.getMessages).not.toHaveBeenCalled()
		expect(remote.getState).not.toHaveBeenCalled()
		expect(wrapper.foreground).toBe(asRemote(remote))
	})

	it("tolerates session-sync failure and continues", async () => {
		const home = new FakeSession("local-1")
		const { wrapper, ctx, ui } = makeCtx(home)
		const remote = new FakeSession("remote-1")
		buildMock.mockResolvedValueOnce(asRemote(remote))
		// First rsync (workspace) succeeds, second (session file) fails.
		rsyncMock.mockResolvedValueOnce({ fileCount: 1, totalBytes: 0, durationMs: 1 })
		rsyncMock.mockRejectedValueOnce(new Error("session sync fail"))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
		)

		// Only workspace rsync succeeded; session sync failed.
		expect(rsyncMock).toHaveBeenCalledTimes(2)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Session sync failed/), "warning")
		// Should NOT call switchSession because sessionExport was cleared on failure.
		expect(remote.switchSession).not.toHaveBeenCalled()
		expect(wrapper.foreground).toBe(asRemote(remote))
	})

	it("tolerates remote session-load failure and continues", async () => {
		const home = new FakeSession("local-1")
		const { wrapper, ctx, ui } = makeCtx(home)
		const remote = new FakeSession("remote-1")
		remote.switchSession = vi.fn(async () => {
			throw new Error("switchSession boom")
		})
		buildMock.mockResolvedValueOnce(asRemote(remote))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
		)

		expect(rsyncMock).toHaveBeenCalledTimes(2)
		expect(remote.switchSession).toHaveBeenCalledOnce()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not load session on remote/), "warning")
		expect(wrapper.foreground).toBe(asRemote(remote))
	})

	it("refuses when already foregrounded on a remote", async () => {
		const home = new FakeSession("local-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(new FakeSession("remote-existing")))

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
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
		buildMock.mockResolvedValueOnce(asRemote(new FakeSession("remote-1")))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: true, force: false },
			ctx,
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

	it("refuses on name collision", async () => {
		listMock.mockResolvedValueOnce([
			{
				id: "x",
				name: "feature-x",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle" as const,
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)

		await expect(
			runTeleport(
				{
					name: "feature-x",
					allowDirty: false,
					exclude: [],
					includeIgnored: false,
					abandonPending: false,
					force: false,
				},
				ctx,
			),
		).rejects.toThrow(/already exists/)
	})

	it("rolls back to home base when rsync fails", async () => {
		rsyncMock.mockRejectedValueOnce(new Error("rsync boom"))
		const home = new FakeSession("local-1")
		const { wrapper, ctx } = makeCtx(home)

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toThrow(/rsync failed/)
		expect(wrapper.isForegroundHomeBase).toBe(true)
		expect(buildMock).not.toHaveBeenCalled()
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

	it("setSessionName failure is non-fatal", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		remote.setSessionName = vi.fn(async () => {
			throw new Error("server full")
		})
		const { wrapper, ctx, ui } = makeCtx(home)
		buildMock.mockResolvedValueOnce(asRemote(remote))

		await runTeleport(
			{
				name: "named-one",
				allowDirty: false,
				exclude: [],
				includeIgnored: false,
				abandonPending: false,
				force: false,
			},
			ctx,
		)
		expect(wrapper.foreground).toBe(asRemote(remote))
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not set session name/), "warning")
	})

	it("waits for the sandbox to become ready between auth and rsync", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		buildMock.mockResolvedValueOnce(asRemote(new FakeSession("remote-1")))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
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
		const { wrapper, ctx } = makeCtx(home)
		waitMock.mockRejectedValueOnce(new Error("Session did not become ACTIVE within 90s (last status: INITIALIZING)"))

		await expect(
			runTeleport({ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false }, ctx),
		).rejects.toThrow(/Sandbox never became ready.*INITIALIZING/s)
		expect(rsyncMock).not.toHaveBeenCalled()
		expect(wrapper.isForegroundHomeBase).toBe(true)
	})

	it("rsync runs after auth and before build", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		buildMock.mockResolvedValueOnce(asRemote(new FakeSession("remote-1")))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
		)

		const authOrder = authMock.mock.invocationCallOrder[0]
		const rsyncOrder = rsyncMock.mock.invocationCallOrder[0]
		const buildOrder = buildMock.mock.invocationCallOrder[0]
		expect(rsyncOrder).toBeGreaterThan(authOrder)
		expect(buildOrder).toBeGreaterThan(rsyncOrder)
	})

	it("calls triggerRebind AFTER foregroundRemote (TUI re-binds to remote)", async () => {
		const home = new FakeSession("local-1")
		// Record what wrapper.isForegroundHomeBase reads as at the moment
		// triggerRebind is invoked — must be false (already swapped to
		// remote) otherwise InteractiveMode rebinds to the wrong session.
		let observedIsHomeBaseAtRebind: boolean | "not-called" = "not-called"
		// biome-ignore lint/style/useConst: forward reference — captured by triggerRebind before setup.wrapper exists.
		let wrapperRef: TeleportableAgentSession | undefined
		const triggerRebind = vi.fn(async () => {
			observedIsHomeBaseAtRebind = wrapperRef?.isForegroundHomeBase ?? true
		})
		const setup = makeCtx(home, { triggerRebind })
		wrapperRef = setup.wrapper
		buildMock.mockResolvedValueOnce(asRemote(new FakeSession("remote-1")))

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			setup.ctx,
		)

		expect(triggerRebind).toHaveBeenCalledOnce()
		expect(observedIsHomeBaseAtRebind).toBe(false)
	})

	it("treats a triggerRebind failure as non-fatal (warns but doesn't refuse)", async () => {
		const home = new FakeSession("local-1")
		const setup = makeCtx(home, {
			triggerRebind: vi.fn(async () => {
				throw new Error("rebind boom")
			}),
		})
		buildMock.mockResolvedValueOnce(asRemote(new FakeSession("remote-1")))

		// runTeleport should still resolve; the wrapper swap already happened
		// by the time triggerRebind threw.
		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			setup.ctx,
		)

		expect(setup.wrapper.isForegroundHomeBase).toBe(false)
		expect(setup.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Session rebind failed: rebind boom/), "warning")
	})

	it("calls onHostResolved BEFORE triggerRebind so the session indicator is set before UI refresh", async () => {
		const home = new FakeSession("local-1")
		const callOrder: string[] = []
		const triggerRebind = vi.fn(async () => {
			callOrder.push("rebind")
		})
		const setup = makeCtx(home, { triggerRebind })
		setup.ctx.onHostResolved = vi.fn((host: string) => {
			callOrder.push(`onHostResolved:${host}`)
		})
		buildMock.mockResolvedValueOnce(asRemote(new FakeSession("remote-1")))

		const result = await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			setup.ctx,
		)

		expect(setup.ctx.onHostResolved).toHaveBeenCalledOnce()
		expect(setup.ctx.onHostResolved).toHaveBeenCalledWith(result.host)
		expect(callOrder.indexOf(`onHostResolved:${result.host}`)).toBeLessThan(callOrder.indexOf("rebind"))
	})
})

// ───────────────────────── runDetach ─────────────────────────

describe("runDetach", () => {
	it("happy path: dispose remote, transition wrapper to home base", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runDetach({ abandonPending: false }, ctx)

		expect(remote.dispose).toHaveBeenCalled()
		expect(wrapper.isForegroundHomeBase).toBe(true)
		expect(wrapper.getDetached().get("remote-1")).toBe(asRemote(remote))
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Detached from session remote-1/), "info")
	})

	it("refuses on home base", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		await expect(runDetach({ abandonPending: false }, ctx)).rejects.toBeInstanceOf(TeleportRefusal)
	})

	it("detaches immediately even when the remote is streaming", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		remote.isStreaming = true
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runDetach({ abandonPending: false }, ctx)
		expect(remote.dispose).toHaveBeenCalled()
		expect(wrapper.isForegroundHomeBase).toBe(true)
	})

	it("survives a dispose() error and still transitions", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		remote.dispose = vi.fn(() => {
			throw new Error("ws already dead")
		})
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runDetach({ abandonPending: false }, ctx)
		expect(wrapper.isForegroundHomeBase).toBe(true)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/WS shutdown error/), "warning")
	})

	it("uses session name in the hint when available", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1", "named-remote")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runDetach({ abandonPending: false }, ctx)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("/attach named-remote"), "info")
	})

	it("calls triggerRebind AFTER detachToHomeBase (TUI re-binds to home base)", async () => {
		const home = new FakeSession("local-1")
		let observedIsHomeBaseAtRebind: boolean | "not-called" = "not-called"
		// biome-ignore lint/style/useConst: forward reference — captured by triggerRebind before setup.wrapper exists.
		let wrapperRef: TeleportableAgentSession | undefined
		const triggerRebind = vi.fn(async () => {
			observedIsHomeBaseAtRebind = wrapperRef?.isForegroundHomeBase ?? false
		})
		const setup = makeCtx(home, { triggerRebind })
		wrapperRef = setup.wrapper
		setup.wrapper.foregroundRemote(asRemote(new FakeSession("remote-1")))

		await runDetach({ abandonPending: false }, setup.ctx)

		expect(triggerRebind).toHaveBeenCalledOnce()
		expect(observedIsHomeBaseAtRebind).toBe(true)
	})
})

// ───────────────────────── runAttach ─────────────────────────

describe("runAttach", () => {
	it("refuses when already foregrounded on a remote", async () => {
		const home = new FakeSession("local-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(new FakeSession("remote-existing")))

		await expect(runAttach({ target: "remote-1" }, ctx)).rejects.toBeInstanceOf(TeleportRefusal)
	})

	it("attaches to in-process detached by sessionId without hitting listRemoteSessions", async () => {
		const home = new FakeSession("local-1")
		const detached = new FakeSession("remote-1")
		const fresh = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(detached))
		wrapper.detachToHomeBase()

		buildMock.mockResolvedValueOnce(asRemote(fresh))

		await runAttach({ target: "remote-1" }, ctx)

		expect(listMock).not.toHaveBeenCalled()
		expect(wrapper.foreground).toBe(asRemote(fresh))
		expect(wrapper.getDetached().has("remote-1")).toBe(false)
	})

	it("attaches to in-process detached by name", async () => {
		const home = new FakeSession("local-1")
		const detached = new FakeSession("remote-1", "alpha")
		const fresh = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(detached))
		wrapper.detachToHomeBase()
		buildMock.mockResolvedValueOnce(asRemote(fresh))

		await runAttach({ target: "alpha" }, ctx)

		expect(listMock).not.toHaveBeenCalled()
		expect(wrapper.foreground).toBe(asRemote(fresh))
	})

	it("attaches to server-side session by id", async () => {
		const home = new FakeSession("local-1")
		const fresh = new FakeSession("remote-server")
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
		buildMock.mockResolvedValueOnce(asRemote(fresh))
		const { wrapper, ctx } = makeCtx(home)

		await runAttach({ target: "remote-server" }, ctx)
		expect(wrapper.foreground).toBe(asRemote(fresh))
	})

	it("attaches to server-side session by name", async () => {
		const home = new FakeSession("local-1")
		const fresh = new FakeSession("remote-server")
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
		buildMock.mockResolvedValueOnce(asRemote(fresh))
		const { wrapper, ctx } = makeCtx(home)

		await runAttach({ target: "beta" }, ctx)
		expect(wrapper.foreground).toBe(asRemote(fresh))
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

		await expect(runAttach({ target: "feature-xz" }, ctx)).rejects.toThrow(/feature-xy/)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Did you mean/), "error")
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

		await expect(runAttach({ target: "done" }, ctx)).rejects.toThrow(/completed/)
	})

	it("calls onHostResolved BEFORE triggerRebind so the session indicator is set before UI refresh", async () => {
		const home = new FakeSession("local-1")
		const detached = new FakeSession("remote-1")
		const fresh = new FakeSession("remote-1")
		const callOrder: string[] = []
		const triggerRebind = vi.fn(async () => {
			callOrder.push("rebind")
		})
		const setup = makeCtx(home, { triggerRebind })
		setup.wrapper.foregroundRemote(asRemote(detached))
		setup.wrapper.detachToHomeBase()
		buildMock.mockResolvedValueOnce(asRemote(fresh))
		setup.ctx.onHostResolved = vi.fn((host: string) => {
			callOrder.push(`onHostResolved:${host}`)
		})

		const result = await runAttach({ target: "remote-1" }, setup.ctx)

		expect(setup.ctx.onHostResolved).toHaveBeenCalledOnce()
		expect(setup.ctx.onHostResolved).toHaveBeenCalledWith(result.host)
		expect(callOrder.indexOf(`onHostResolved:${result.host}`)).toBeLessThan(callOrder.indexOf("rebind"))
	})
})

// ───────────────────────── runListSessions ─────────────────────────

describe("runListSessions", () => {
	it("notifies 'No remote sessions.' when everything is empty", async () => {
		const home = new FakeSession("local-1")
		const { ctx, ui } = makeCtx(home)

		await runListSessions(ctx)
		expect(ui.notify).toHaveBeenCalledWith("No remote sessions.", "info")
	})

	it("renders foreground + detached + server-only rows without duplicates", async () => {
		const home = new FakeSession("local-1")
		const fg = new FakeSession("fg-id", "fg")
		const detached = new FakeSession("det-id", "det")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(detached))
		wrapper.detachToHomeBase()
		wrapper.foregroundRemote(asRemote(fg))

		listMock.mockResolvedValueOnce([
			{
				id: "fg-id",
				name: "fg-server-name",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: true,
			},
			{
				id: "det-id",
				name: "det-server-name",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: false,
			},
			{
				id: "srvr1234",
				name: "remote-only",
				createdAt: new Date(),
				lastActivityAt: new Date(),
				status: "idle",
				hasConnectedClient: false,
			},
		] satisfies RemoteSessionSummary[])

		await runListSessions(ctx)
		expect(listMock).toHaveBeenCalledOnce()
		expect(ui.custom).toHaveBeenCalledOnce()

		// Invoke the factory to verify rendered content
		const factory = ui.custom.mock.calls[0][0] as (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (r: unknown) => void,
		) => { render(w: number): string[] }
		let captured: unknown
		const mockTui = { requestRender: vi.fn(), terminal: { rows: 40, cols: 120 } }
		const panel = factory(mockTui, {}, {}, (r) => {
			captured = r
		})
		const lines = panel.render(120).join("\n")
		expect(lines).toContain("fg-id")
		expect(lines).toContain("det-id")
		expect(lines).toContain("srvr1234")
		// fg-id appears exactly once (no duplicate from server list)
		expect((lines.match(/fg-id/g) ?? []).length).toBe(1)
	})

	it("falls back to local state when listRemoteSessions fails", async () => {
		const home = new FakeSession("local-1")
		const fg = new FakeSession("fg-id", "fg")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(fg))

		listMock.mockRejectedValueOnce(new Error("network down"))

		await runListSessions(ctx)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not fetch server sessions/), "warning")
		expect(ui.custom).toHaveBeenCalledOnce()

		// Invoke the factory to verify rendered content
		const factory = ui.custom.mock.calls[0][0] as (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (r: unknown) => void,
		) => { render(w: number): string[] }
		const mockTui = { requestRender: vi.fn(), terminal: { rows: 40, cols: 120 } }
		const panel = factory(mockTui, {}, {}, vi.fn())
		const lines = panel.render(120).join("\n")
		expect(lines).toContain("fg-id")
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

	it("refuses when on home base with no target", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)
		const { runChild } = makeRunChildMock()

		await expect(runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
		expect(runChild).not.toHaveBeenCalled()
	})

	it("uses the foreground sessionId when no target is given", async () => {
		const home = new FakeSession("local-1")
		const fg = new FakeSession("fg-id-1234567890")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(fg))
		const { runChild, calls } = makeRunChildMock()

		await runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })

		expect(authMock).toHaveBeenCalledWith("fg-id-1234567890", "test-key", "Remote session for proj", {
			endpoint: "https://api.example.com",
		})
		expect(listMock).not.toHaveBeenCalled()
		expect(calls).toHaveLength(1)
		expect(calls[0].cmd).toBe("ssh")
		expect(calls[0].args).toContain("sandbox@host.example.com")
		expect(calls[0].env?.AUTH_TOKEN).toBe("ct-1")
	})

	it("resolves an in-process detached target by name without listRemoteSessions", async () => {
		const home = new FakeSession("local-1")
		const detached = new FakeSession("det-id-abc", "named-one")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(detached))
		wrapper.detachToHomeBase()
		const { runChild, calls } = makeRunChildMock()

		await runConnect({ target: "named-one" }, ctx, { _runChildWithTTYHandoff: runChild })

		expect(listMock).not.toHaveBeenCalled()
		expect(authMock).toHaveBeenCalledWith("det-id-abc", expect.anything(), expect.anything(), expect.anything())
		expect(calls).toHaveLength(1)
		// /connect does not promote the detached entry — kimchi's foreground stays unchanged.
		expect(wrapper.isForegroundHomeBase).toBe(true)
		expect(wrapper.getDetached().get("det-id-abc")).toBe(asRemote(detached))
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
		const fg = new FakeSession("fg-id")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(fg))
		authMock.mockRejectedValueOnce(new RemoteAuthError("bad token", 401))
		const { runChild } = makeRunChildMock()

		await expect(runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })).rejects.toThrow(/Authentication failed/)
		expect(runChild).not.toHaveBeenCalled()
	})

	it("surfaces a warning when ssh exits non-zero", async () => {
		const home = new FakeSession("local-1")
		const fg = new FakeSession("fg-id")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(fg))
		const runChild = vi.fn(async () => 255)

		await runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })

		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/ssh exited with code 255/), "warning")
	})

	it("does not change wrapper foreground after ssh exits", async () => {
		const home = new FakeSession("local-1")
		const fg = new FakeSession("fg-id")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(fg))
		const { runChild } = makeRunChildMock()

		await runConnect({}, ctx, { _runChildWithTTYHandoff: runChild })

		expect(wrapper.foreground).toBe(asRemote(fg))
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
