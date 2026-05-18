import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionServices,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteAgentSession } from "../remote/remote-agent-session.js"
import type { RemoteSessionSummary } from "../remote/types.js"
import { RemoteAuthError } from "../remote/types.js"
import { TeleportableAgentSession } from "./teleportable-agent-session.js"

const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom")

type ExecAsyncImpl = (cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr: string }>

const { execAsyncMock, execMock, authMock, listMock, buildMock, rsyncMock, waitMock } = vi.hoisted(() => {
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
		buildMock: vi.fn(),
		rsyncMock: vi.fn(),
		waitMock: vi.fn(),
	}
})

vi.mock("node:child_process", () => ({ exec: execMock }))
vi.mock("../remote/auth.js", () => ({
	authenticateRemoteSession: authMock,
	listRemoteSessions: listMock,
	waitForSessionReady: waitMock,
}))
vi.mock("../remote/build-remote-session.js", () => ({
	buildRemoteAgentSession: buildMock,
}))
vi.mock("./rsync-transport.js", () => ({
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

// Imported after vi.mock so module resolution sees the mocks.
import {
	TeleportRefusal,
	deriveSandboxDest,
	runAttach,
	runConnect,
	runDetach,
	runListSessions,
	runTeleport,
} from "./teleport.js"

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
		setEditorText: vi.fn(),
	} as unknown as ExtensionUIContext & {
		notify: ReturnType<typeof vi.fn>
		setStatus: ReturnType<typeof vi.fn>
	}
}

function makeCtx(homeBase: FakeSession, opts: { triggerRebind?: () => Promise<void> } = {}) {
	const wrapper = TeleportableAgentSession.create(asSession(homeBase))
	const ui = makeUI()
	const services = {} as unknown as AgentSessionServices
	const triggerRebind = opts.triggerRebind ?? vi.fn(async () => {})
	return {
		wrapper,
		ui,
		triggerRebind,
		ctx: {
			wrapper,
			services,
			apiKey: "test-key",
			endpoint: "https://api.example.com",
			cwd: "/work/proj",
			ui,
			triggerRebind,
		},
	}
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
	execAsyncMock.mockReset()
	execAsyncMock.mockImplementation(async () => ({ stdout: "", stderr: "" }))
	authMock.mockReset()
	listMock.mockReset()
	buildMock.mockReset()
	rsyncMock.mockReset()
	waitMock.mockReset()
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
		expect(rsyncMock).toHaveBeenCalledOnce()
		expect(buildMock).toHaveBeenCalledOnce()
		expect(wrapper.foreground).toBe(asRemote(remote))
		// Short final notification — just the session id, no extra hints.
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^Teleported to remote session [\w-]+\.$/), "info")
		// Session summary surfaces immediately after auth, before the wait.
		// Carries the target path so the user knows where their files live
		// (the agent's CWD is still /home/sandbox).
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringMatching(
				/Created remote session:[\s\S]*id:[\s\S]*host:[\s\S]*port:[\s\S]*url:[\s\S]*target:\s+\/home\/sandbox\/proj\//,
			),
			"info",
		)
		// runRsync was called with the per-teleport subdir as the destination.
		const rsyncCall = rsyncMock.mock.calls[0][0] as { destination?: string }
		expect(rsyncCall.destination).toBe("/home/sandbox/proj/")
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

	it("passes onPhase to runRsync and drives per-step status text", async () => {
		const home = new FakeSession("local-1")
		const { ctx, ui } = makeCtx(home)
		buildMock.mockResolvedValueOnce(asRemote(new FakeSession("remote-1")))
		rsyncMock.mockImplementationOnce(async (opts: { onPhase?: (p: "mkdir" | "rsync") => void }) => {
			opts.onPhase?.("mkdir")
			opts.onPhase?.("rsync")
			return { fileCount: 1, totalBytes: 0, durationMs: 1 }
		})

		await runTeleport(
			{ allowDirty: false, exclude: [], includeIgnored: false, abandonPending: false, force: false },
			ctx,
		)

		const rsyncCallArgs = rsyncMock.mock.calls[0][0] as { onPhase?: unknown }
		expect(typeof rsyncCallArgs.onPhase).toBe("function")
		expect(ui.setStatus).toHaveBeenCalledWith("teleport", "Preparing remote directory…")
		expect(ui.setStatus).toHaveBeenCalledWith("teleport", "Syncing workspace…")
		// Order matters: mkdir before rsync.
		const calls = ui.setStatus.mock.calls as Array<[string, string | undefined]>
		const mkdirIdx = calls.findIndex((c) => c[1] === "Preparing remote directory…")
		const rsyncIdx = calls.findIndex((c) => c[1] === "Syncing workspace…")
		expect(mkdirIdx).toBeGreaterThanOrEqual(0)
		expect(rsyncIdx).toBeGreaterThan(mkdirIdx)
	})

	it("calls triggerRebind AFTER foregroundRemote (TUI re-binds to remote)", async () => {
		const home = new FakeSession("local-1")
		// Record what wrapper.isForegroundHomeBase reads as at the moment
		// triggerRebind is invoked — must be false (already swapped to
		// remote) otherwise InteractiveMode rebinds to the wrong session.
		let observedIsHomeBaseAtRebind: boolean | "not-called" = "not-called"
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
		// Final "Teleported …" info still fires (user sees the success path).
		expect(setup.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^Teleported/), "info")
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

	it("refuses when remote is busy without --abandon-pending", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		remote.isStreaming = true
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await expect(runDetach({ abandonPending: false }, ctx)).rejects.toThrow(/busy/)
		expect(remote.dispose).not.toHaveBeenCalled()
	})

	it("--abandon-pending aborts then detaches", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		remote.isStreaming = true
		remote.abortBash = vi.fn(() => {
			remote.isStreaming = false
		})
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runDetach({ abandonPending: true }, ctx)
		expect(remote.abortBash).toHaveBeenCalled()
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
		const tableCall = ui.notify.mock.calls.find(
			(c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("STATE"),
		)
		expect(tableCall).toBeDefined()
		const out = tableCall?.[0] as string
		expect(out).toContain("fg-id")
		expect(out).toContain("det-id")
		expect(out).toContain("srvr1234")
		// fg-id appears exactly once (no duplicate from server list)
		expect((out.match(/fg-id/g) ?? []).length).toBe(1)
	})

	it("falls back to local state when listRemoteSessions fails", async () => {
		const home = new FakeSession("local-1")
		const fg = new FakeSession("fg-id", "fg")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(fg))

		listMock.mockRejectedValueOnce(new Error("network down"))

		await runListSessions(ctx)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not fetch server sessions/), "warning")
		const tableCall = ui.notify.mock.calls.find(
			(c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("STATE"),
		)
		expect(tableCall).toBeDefined()
		expect(tableCall?.[0] as string).toContain("fg-id")
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

		expect(authMock).toHaveBeenCalledWith("fg-id-1234567890", "test-key", { endpoint: "https://api.example.com" })
		expect(listMock).not.toHaveBeenCalled()
		expect(calls).toHaveLength(1)
		expect(calls[0].cmd).toBe("ssh")
		expect(calls[0].args).toContain("sandbox@host.example.com")
		expect(calls[0].args).toContain("443")
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
		expect(authMock).toHaveBeenCalledWith("det-id-abc", expect.anything(), expect.anything())
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
		expect(authMock).toHaveBeenCalledWith("srvr-1", expect.anything(), expect.anything())
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
