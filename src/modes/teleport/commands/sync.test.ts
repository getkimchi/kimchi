import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionServices,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteAgentSession } from "../proxy/agent-session.js"
import { TeleportableAgentSession } from "../proxy/teleportable-session.js"

const { authMock, rsyncMock } = vi.hoisted(() => ({
	authMock: vi.fn(),
	rsyncMock: vi.fn(),
}))

vi.mock("../api/index.js", () => ({
	authenticateRemoteSession: authMock,
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

vi.mock("../sync/rsync.js", () => ({
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

type ExecAsyncImpl = (cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr: string }>

const { execAsyncMock, execMock } = vi.hoisted(() => {
	const execAsyncMock = vi.fn<ExecAsyncImpl>(async () => ({ stdout: "", stderr: "" }))
	const PROMISIFY = Symbol.for("nodejs.util.promisify.custom")
	const execMock: { (...args: unknown[]): void; [PROMISIFY]?: typeof execAsyncMock } = Object.assign(vi.fn(), {
		[PROMISIFY]: execAsyncMock,
	})
	return { execMock, execAsyncMock }
})

vi.mock("node:child_process", () => ({ exec: execMock }))

import type { SyncArgs } from "./args.js"
import { TeleportRefusal } from "./errors.js"
import { runSync } from "./sync.js"

// ─── Test helpers ────────────────────────────────────────────────────────────

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
	}
}

function makeCtx(homeBase: FakeSession) {
	const wrapper = TeleportableAgentSession.create(asSession(homeBase))
	const ui = makeUI()
	const services = {} as unknown as AgentSessionServices
	return {
		wrapper,
		ui,
		ctx: {
			wrapper,
			services,
			apiKey: "test-key",
			endpoint: "https://api.example.com",
			cwd: "/work/proj",
			ui,
		},
	}
}

const AUTH_OK = {
	connectToken: "ct-1",
	wsUrl: "wss://host.example.com",
	expiresAt: "2026-01-01T00:00:00Z",
	host: "host.example.com",
	description: "test session",
}

const DEFAULT_UP_ARGS: SyncArgs = {
	direction: "up",
	exclude: [],
	includeIgnored: false,
	delete: false,
	dryRun: false,
}

const DEFAULT_DOWN_ARGS: SyncArgs = {
	direction: "down",
	exclude: [],
	includeIgnored: false,
	delete: false,
	dryRun: false,
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
	vi.stubEnv("KIMCHI_PROXY_HELPER", "bin/proxy-helper")
	execAsyncMock.mockReset()
	execAsyncMock.mockImplementation(async (cmd: string) => {
		if (cmd.includes("command -v rsync")) return { stdout: "/usr/bin/rsync", stderr: "" }
		return { stdout: "", stderr: "" }
	})
	authMock.mockReset()
	authMock.mockResolvedValue(AUTH_OK)
	rsyncMock.mockReset()
	rsyncMock.mockResolvedValue({ fileCount: 5, totalBytes: 2048, durationMs: 300 })
})

afterEach(() => {
	vi.unstubAllEnvs()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runSync", () => {
	it("refuses when on home base (no remote session)", async () => {
		const home = new FakeSession("local-1")
		const { ctx } = makeCtx(home)

		await expect(runSync(DEFAULT_UP_ARGS, ctx)).rejects.toThrow(TeleportRefusal)
		expect(rsyncMock).not.toHaveBeenCalled()
	})

	it("refuses when rsync is not on PATH", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		execAsyncMock.mockImplementation(async (cmd: string) => {
			if (cmd.includes("command -v rsync")) throw new Error("not found")
			return { stdout: "", stderr: "" }
		})

		await expect(runSync(DEFAULT_UP_ARGS, ctx)).rejects.toThrow(/rsync/)
	})

	it("syncs up: calls runRsync with direction=up and correct paths", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync(DEFAULT_UP_ARGS, ctx)

		expect(authMock).toHaveBeenCalledWith("remote-1", "test-key", expect.any(String), {
			endpoint: "https://api.example.com",
		})
		expect(rsyncMock).toHaveBeenCalledTimes(1)
		const opts = rsyncMock.mock.calls[0][0]
		expect(opts.source).toBe("/work/proj")
		expect(opts.destination).toContain("proj")
		expect(opts.direction).toBe("up")
		expect(opts.remoteHost).toBe("host.example.com")
		expect(opts.remoteUser).toBe("sandbox")
		expect(opts.authToken).toBe("ct-1")
		expect(opts.deleteExtraneous).toBe(false)
		expect(opts.dryRun).toBe(false)
	})

	it("syncs down: calls runRsync with direction=down and correct paths", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync(DEFAULT_DOWN_ARGS, ctx)

		expect(rsyncMock).toHaveBeenCalledTimes(1)
		const opts = rsyncMock.mock.calls[0][0]
		// source is always local, destination is always remote — direction controls transfer
		expect(opts.source).toBe("/work/proj")
		expect(opts.destination).toContain("proj")
		expect(opts.direction).toBe("down")
	})

	it("passes sub-path when specified", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync({ ...DEFAULT_UP_ARGS, path: "src/lib" }, ctx)

		const opts = rsyncMock.mock.calls[0][0]
		expect(opts.source).toContain("src/lib")
		expect(opts.destination).toContain("src/lib")
	})

	it("uses parent directory and fileFilter for single-file down sync", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		// Path with a dot in the last segment and no trailing slash → treated as a file
		await runSync({ ...DEFAULT_DOWN_ARGS, path: "src/main.go" }, ctx)

		const opts = rsyncMock.mock.calls[0][0]
		// source/destination should be the parent directory, not the file itself
		expect(opts.source).toContain("src")
		expect(opts.source).not.toContain("main.go")
		expect(opts.destination).toContain("src")
		expect(opts.destination).not.toContain("main.go")
		expect(opts.fileFilter).toBe("main.go")
	})

	it("treats paths ending with / as directories even if they contain a dot", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync({ ...DEFAULT_DOWN_ARGS, path: "src/v2.0/" }, ctx)

		const opts = rsyncMock.mock.calls[0][0]
		expect(opts.source).toContain("v2.0")
		expect(opts.fileFilter).toBeUndefined()
	})

	it("forwards --delete flag", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync({ ...DEFAULT_UP_ARGS, delete: true }, ctx)

		const opts = rsyncMock.mock.calls[0][0]
		expect(opts.deleteExtraneous).toBe(true)
	})

	it("forwards --dry-run flag", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync({ ...DEFAULT_UP_ARGS, dryRun: true }, ctx)

		const opts = rsyncMock.mock.calls[0][0]
		expect(opts.dryRun).toBe(true)
	})

	it("forwards --exclude globs", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync({ ...DEFAULT_UP_ARGS, exclude: ["*.bak", "tmp/"] }, ctx)

		const opts = rsyncMock.mock.calls[0][0]
		expect(opts.excludeGlobs).toContain("*.bak")
		expect(opts.excludeGlobs).toContain("tmp/")
	})

	it("forwards --include-ignored flag", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync({ ...DEFAULT_UP_ARGS, includeIgnored: true }, ctx)

		const opts = rsyncMock.mock.calls[0][0]
		expect(opts.includeIgnored).toBe(true)
	})

	it("reports success info to the UI", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync(DEFAULT_UP_ARGS, ctx)

		// Should have called info at least twice: once for "Syncing…" and once for "Sync complete"
		const infoCalls = (ui.notify.mock.calls as [string, string][]).filter(([_msg, level]) => level === "info")
		expect(infoCalls.length).toBeGreaterThanOrEqual(2)
		const completionCall = infoCalls.find(([msg]) => msg.includes("Sync complete"))
		expect(completionCall).toBeDefined()
		expect(completionCall?.[0]).toContain("5 file(s)")
	})

	it("reports dry-run prefix on completion", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync({ ...DEFAULT_UP_ARGS, dryRun: true }, ctx)

		const infoCalls = (ui.notify.mock.calls as [string, string][]).filter(([_msg, level]) => level === "info")
		const completionCall = infoCalls.find(([msg]) => msg.includes("Dry run complete"))
		expect(completionCall).toBeDefined()
	})

	it("refuses cleanly when rsync fails", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		rsyncMock.mockRejectedValueOnce(new Error("connection closed"))

		await expect(runSync(DEFAULT_UP_ARGS, ctx)).rejects.toThrow(/rsync failed/)
	})

	it("refuses cleanly when auth fails", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		authMock.mockRejectedValueOnce(new Error("forbidden"))

		await expect(runSync(DEFAULT_UP_ARGS, ctx)).rejects.toThrow(/Authentication failed/)
	})

	it("clears status after sync (success path)", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		await runSync(DEFAULT_UP_ARGS, ctx)

		// Last setStatus call should be undefined (cleared)
		const statusCalls = ui.setStatus.mock.calls
		const lastCall = statusCalls[statusCalls.length - 1]
		expect(lastCall[1]).toBeUndefined()
	})

	it("clears status after sync (failure path)", async () => {
		const home = new FakeSession("local-1")
		const remote = new FakeSession("remote-1")
		const { wrapper, ctx, ui } = makeCtx(home)
		wrapper.foregroundRemote(asRemote(remote))

		rsyncMock.mockRejectedValueOnce(new Error("oops"))

		try {
			await runSync(DEFAULT_UP_ARGS, ctx)
		} catch {
			// expected
		}

		// Status should have been cleared in the finally block before the refuse() call
		// The refuse() function also clears status, so we just check it's not left stuck
		const statusCalls = ui.setStatus.mock.calls
		const lastCall = statusCalls[statusCalls.length - 1]
		expect(lastCall[1]).toBeUndefined()
	})
})
