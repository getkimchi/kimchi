import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const {
	authMock,
	resolveWorkspaceRefMock,
	runRsyncMock,
	formatRsyncFailureMock,
	provisionHarnessConfigMock,
	whichRsyncMock,
	rsyncInstallHintMock,
} = vi.hoisted(() => ({
	authMock: vi.fn(),
	resolveWorkspaceRefMock: vi.fn(),
	runRsyncMock: vi.fn(),
	formatRsyncFailureMock: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
	provisionHarnessConfigMock: vi.fn(),
	whichRsyncMock: vi.fn(() => true),
	rsyncInstallHintMock: vi.fn(() => "Install rsync"),
}))

vi.mock("../../../sandbox/cloud/auth.js", () => ({ authenticateWorkspace: authMock }))
vi.mock("./workspace-ref.js", () => ({ resolveWorkspaceRef: resolveWorkspaceRefMock }))
vi.mock("../provisioning/rsync-runner.js", () => ({
	runRsync: runRsyncMock,
	formatRsyncFailure: formatRsyncFailureMock,
}))
vi.mock("../provisioning/harness-config.js", () => ({
	provisionHarnessConfig: provisionHarnessConfigMock,
}))
vi.mock("../preflight/rsync.js", () => ({
	whichRsync: whichRsyncMock,
	rsyncInstallHint: rsyncInstallHintMock,
}))

import type { TeleportContext } from "../types.js"
import type { SyncArgs } from "./args.js"
import { TeleportRefusal } from "./errors.js"
import { resolveSyncPaths, runSync } from "./sync.js"

function syncArgs(overrides: Partial<SyncArgs>): SyncArgs {
	return {
		direction: "up",
		workspace: "w",
		source: ".",
		target: ".",
		exclude: [],
		includeIgnored: false,
		delete: false,
		dryRun: false,
		...overrides,
	}
}

const CREDS = {
	connectToken: "tok-1",
	expiresAt: "2030-01-01T00:00:00Z",
	wsUrl: "wss://host.example",
	host: "host.example",
}

function makeUi() {
	return {
		notify: vi.fn(),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	} as unknown as ExtensionUIContext & {
		notify: ReturnType<typeof vi.fn>
		setStatus: ReturnType<typeof vi.fn>
		setWidget: ReturnType<typeof vi.fn>
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

let syncTempDir = ""

beforeEach(() => {
	syncTempDir = mkdtempSync(join(tmpdir(), "kimchi-sync-run-"))
	writeFileSync(join(syncTempDir, "file.txt"), "hello", "utf-8")
	authMock.mockReset().mockResolvedValue(CREDS)
	resolveWorkspaceRefMock.mockReset().mockResolvedValue({ id: "ws-1", name: "my-ws" })
	runRsyncMock.mockReset().mockResolvedValue({ totalBytes: 1024, durationMs: 500, fileCount: 3 })
	formatRsyncFailureMock
		.mockReset()
		.mockImplementation((err: unknown) => (err instanceof Error ? err.message : String(err)))
	provisionHarnessConfigMock.mockReset().mockResolvedValue({ ok: true })
	whichRsyncMock.mockReset().mockReturnValue(true)
	rsyncInstallHintMock.mockReset().mockReturnValue("Install rsync")
})

afterEach(() => {
	if (syncTempDir) rmSync(syncTempDir, { recursive: true, force: true })
})

describe("resolveSyncPaths — up", () => {
	let cwd: string
	beforeAll(() => {
		cwd = mkdtempSync(join(tmpdir(), "kimchi-sync-test-"))
		mkdirSync(join(cwd, "subdir"), { recursive: true })
		writeFileSync(join(cwd, "file.txt"), "hello", "utf-8")
		writeFileSync(join(cwd, "subdir", "nested.txt"), "world", "utf-8")
	})
	afterAll(() => {
		rmSync(cwd, { recursive: true, force: true })
	})

	it("resolves a relative source against cwd and a relative target against SANDBOX_HOME", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "file.txt", target: "project/file.txt" }))
		expect(r.localPath).toBe(join(cwd, "file.txt"))
		expect(r.remotePath).toBe("/home/sandbox/project/file.txt")
		expect(r.isSourceDirectory).toBe(false)
	})

	it("flags a directory source via stat", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "subdir", target: "/home/sandbox/sub" }))
		expect(r.isSourceDirectory).toBe(true)
	})

	it("preserves a trailing slash on the local source path", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "subdir/", target: "/home/sandbox/sub/" }))
		expect(r.localPath).toBe(join(cwd, "subdir/"))
		expect(r.remotePath).toBe("/home/sandbox/sub/")
		expect(r.isSourceDirectory).toBe(true)
	})

	it("accepts an absolute local source", () => {
		const abs = join(cwd, "file.txt")
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: abs, target: "/home/sandbox/x" }))
		expect(r.localPath).toBe(abs)
	})

	it("expands ~ on the remote side to SANDBOX_HOME", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "file.txt", target: "~/project/file.txt" }))
		expect(r.remotePath).toBe("/home/sandbox/project/file.txt")
	})

	it("expands ~ on the local side to $HOME", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "down", source: "~/x", target: "~/y" }))
		expect(r.localPath).toBe(join(homedir(), "y"))
	})

	it("throws when the local source does not exist", () => {
		expect(() => resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "does-not-exist", target: "/x" }))).toThrow(
			/Local source does not exist/,
		)
	})
})

describe("resolveSyncPaths — down", () => {
	const cwd = "/Users/me/work"

	it("treats a trailing-slash source as a directory", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "down", source: "project/dist/", target: "./dist/" }))
		expect(r.isSourceDirectory).toBe(true)
		expect(r.remotePath).toBe("/home/sandbox/project/dist/")
		expect(r.localPath).toBe(join(cwd, "./dist/"))
	})

	it("treats a no-trailing-slash source as a single file", () => {
		const r = resolveSyncPaths(
			cwd,
			syncArgs({ direction: "down", source: "project/dist/output.tar", target: "./output.tar" }),
		)
		expect(r.isSourceDirectory).toBe(false)
	})

	it("accepts absolute remote source paths", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "down", source: "/var/log/app.log", target: "./app.log" }))
		expect(r.remotePath).toBe("/var/log/app.log")
	})

	it("expands ~ on the remote source to SANDBOX_HOME", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "down", source: "~/project/dist/", target: "./dist/" }))
		expect(r.remotePath).toBe("/home/sandbox/project/dist/")
		expect(r.isSourceDirectory).toBe(true)
	})
})

describe("harness config sync", () => {
	it("/sync up calls provisionHarnessConfig with resolved creds and signal after the workspace rsync", async () => {
		const ac = new AbortController()
		const { ctx } = makeCtx({ cwd: syncTempDir, signal: ac.signal })

		await runSync("up --workspace my-ws --source file.txt --target /remote/path", ctx)

		expect(runRsyncMock).toHaveBeenCalledOnce()
		expect(runRsyncMock).toHaveBeenCalledBefore(provisionHarnessConfigMock)
		expect(provisionHarnessConfigMock).toHaveBeenCalledOnce()
		expect(provisionHarnessConfigMock.mock.calls[0][0]).toMatchObject({
			remoteHost: "host.example",
			authToken: "tok-1",
			signal: ac.signal,
		})
	})

	it("/sync down does NOT call provisionHarnessConfig", async () => {
		const { ctx } = makeCtx({ cwd: syncTempDir })

		await runSync("down --workspace my-ws --source /remote/path --target file.txt", ctx)

		expect(runRsyncMock).toHaveBeenCalledOnce()
		expect(provisionHarnessConfigMock).not.toHaveBeenCalled()
	})

	it("/sync up --dry-run does NOT call provisionHarnessConfig", async () => {
		const { ctx } = makeCtx({ cwd: syncTempDir })

		await runSync("up --workspace my-ws --source file.txt --target /remote/path --dry-run", ctx)

		expect(runRsyncMock).toHaveBeenCalledOnce()
		expect(provisionHarnessConfigMock).not.toHaveBeenCalled()
	})

	it("refuses when provisionHarnessConfig returns ok: false", async () => {
		provisionHarnessConfigMock.mockResolvedValueOnce({ ok: false, error: "boom" })
		const { ctx, ui } = makeCtx({ cwd: syncTempDir })

		await expect(runSync("up --workspace my-ws --source file.txt --target /remote/path", ctx)).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(provisionHarnessConfigMock).toHaveBeenCalledOnce()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not sync harness config: boom"), "error")
	})
})
