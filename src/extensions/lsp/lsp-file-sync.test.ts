// Regression tests for the "LSP file sync failed" code-frame dump observed in
// worktree sessions: a server that fails to start (e.g. typescript-language-server
// with no resolvable tsserver.js) must be reported once as a one-line message
// and never re-spawned for the rest of the session.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const mocks = vi.hoisted(() => {
	const tsServer = {
		name: "typescript-language-server",
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
		installHint: "npm i -g typescript-language-server typescript",
	}
	const goServer = {
		name: "gopls",
		command: "gopls",
		args: [],
		extensions: ["go"],
		installHint: "brew install gopls",
	}
	return {
		tsServer,
		goServer,
		getOrCreateClient: vi.fn(),
		ensureFileOpen: vi.fn(async () => {}),
		refreshFile: vi.fn(async () => {}),
		waitForDiagnostics: vi.fn(async () => false),
		detectServers: vi.fn(() => [tsServer]),
		detectMissingCandidates: vi.fn(() => []),
		serverForFile: vi.fn((filePath: string) => (filePath.endsWith(".ts") ? tsServer : null)),
		findRoot: vi.fn((_file: string, _server: string, sessionCwd: string) => sessionCwd),
	}
})

vi.mock("./client.js", () => ({
	getOrCreateClient: mocks.getOrCreateClient,
	ensureFileOpen: mocks.ensureFileOpen,
	pullDiagnostics: vi.fn(async () => []),
	refreshFile: mocks.refreshFile,
	waitForDiagnostics: mocks.waitForDiagnostics,
	sendRequest: vi.fn(),
	shutdownAll: vi.fn(),
}))

vi.mock("./servers.js", () => ({
	detectServers: mocks.detectServers,
	detectMissingCandidates: mocks.detectMissingCandidates,
	serverForFile: mocks.serverForFile,
	findRoot: mocks.findRoot,
	resolveTsserverPath: vi.fn(() => undefined),
	findMainRepoRoot: vi.fn(() => undefined),
}))

vi.mock("../prompt-construction/index.js", () => ({
	createSystemPromptBlocks: vi.fn(() => ({ register: vi.fn() })),
}))
vi.mock("../prompt-construction/tool-visibility.js", () => ({
	createToolVisibility: vi.fn(() => ({ disable: vi.fn() })),
}))
vi.mock("../steer-marker.js", () => ({
	markHarnessSteer: vi.fn((content: string) => content),
}))

import lspExtension from "../lsp.js"

const INIT_FAILURE =
	"LSP error: Request initialize failed with message: Could not find a valid TypeScript installation."

function makeSession(files?: string[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kimchi-lsp-fail-"))
	for (const name of files ?? []) {
		fs.writeFileSync(path.join(dir, name), "{}\n")
	}
	const ext = createExtensionApi()
	lspExtension(ext.api)
	const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	return { dir, ext, consoleSpy }
}

function editToolResult(filePath: string) {
	return { toolName: "edit", isError: false, input: { path: filePath }, content: [], details: undefined }
}

describe("lsp file sync failure handling", () => {
	beforeEach(() => {
		mocks.getOrCreateClient.mockReset().mockRejectedValue(new Error(INIT_FAILURE))
		mocks.ensureFileOpen.mockReset().mockResolvedValue(undefined)
		mocks.refreshFile.mockReset().mockResolvedValue(undefined)
		mocks.waitForDiagnostics.mockReset().mockResolvedValue(false)
		mocks.detectServers.mockReset().mockReturnValue([mocks.tsServer])
		mocks.detectMissingCandidates.mockReset().mockReturnValue([])
		mocks.serverForFile
			.mockReset()
			.mockImplementation((filePath: string) => (filePath.endsWith(".ts") ? mocks.tsServer : null))
		mocks.findRoot.mockReset().mockImplementation((_file: string, _server: string, sessionCwd: string) => sessionCwd)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("logs a single one-line error and stops respawning after a start failure", async () => {
		const { dir, ext, consoleSpy } = makeSession()
		const sessionCtx = createContext({ cwd: dir })
		await ext.getHandler<unknown, unknown>("session_start")(null, sessionCtx)
		// No tsconfig/package.json in dir → no eager server start.
		expect(mocks.getOrCreateClient).not.toHaveBeenCalled()

		const toolResult = ext.getHandler<unknown, unknown>("tool_result")
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		await toolResult(editToolResult("bar.ts"), createContext({ cwd: dir }))

		// One spawn attempt total; the failure is remembered for the session.
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		// The failure is logged exactly once, as a plain single-line message —
		// never as an Error object (Bun would dump the bundled-source code frame).
		expect(consoleSpy).toHaveBeenCalledTimes(1)
		const logged = consoleSpy.mock.calls[0][0]
		expect(typeof logged).toBe("string")
		expect(logged.startsWith("LSP: typescript-language-server failed to start: ")).toBe(true)
		expect(logged.includes(INIT_FAILURE)).toBe(true)
		expect(logged.includes("\n")).toBe(false)
		// The status bar reflects the degraded server.
		const setStatus = sessionCtx.ui.setStatus as ReturnType<typeof vi.fn>
		expect(setStatus.mock.lastCall).toEqual(["lsp", "LSP: typescript-language-server failed to start"])
	})

	it("logs at most one line per server even when failures recur on different roots (monorepo)", async () => {
		const { dir, ext, consoleSpy } = makeSession()
		const sessionCtx = createContext({ cwd: dir })
		await ext.getHandler<unknown, unknown>("session_start")(null, sessionCtx)
		// Each package in a monorepo resolves to its own root.
		mocks.findRoot.mockImplementation((file: string) =>
			file.endsWith("/a/foo.ts") ? `${dir}/packages/a` : `${dir}/packages/b`,
		)

		const toolResult = ext.getHandler<unknown, unknown>("tool_result")
		await toolResult(editToolResult("packages/a/foo.ts"), createContext({ cwd: dir }))
		await toolResult(editToolResult("packages/b/foo.ts"), createContext({ cwd: dir }))
		// A repeat of the first root is suppressed without another spawn attempt.
		await toolResult(editToolResult("packages/a/foo.ts"), createContext({ cwd: dir }))

		// One spawn attempt per distinct root (different roots are genuinely
		// different server processes), but only one console line for the whole
		// session — the issue's "one human-readable line per session".
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(2)
		expect(consoleSpy).toHaveBeenCalledTimes(1)
		const logged = consoleSpy.mock.calls[0][0]
		expect(logged.startsWith("LSP: typescript-language-server failed to start: ")).toBe(true)
	})

	it("keeps the 'LSP file sync failed' label for mid-session sync failures", async () => {
		const { dir, ext, consoleSpy } = makeSession()
		mocks.getOrCreateClient.mockResolvedValue({ diagnostics: new Map() } as never)
		mocks.refreshFile.mockRejectedValue(new Error("sync boom"))
		const sessionCtx = createContext({ cwd: dir })
		await ext.getHandler<unknown, unknown>("session_start")(null, sessionCtx)

		const toolResult = ext.getHandler<unknown, unknown>("tool_result")
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		await toolResult(editToolResult("bar.ts"), createContext({ cwd: dir }))

		expect(consoleSpy).toHaveBeenCalledTimes(1)
		const logged = consoleSpy.mock.calls[0][0]
		expect(logged.startsWith("LSP file sync failed: ")).toBe(true)
		expect(logged).toContain("sync boom")
		// The status bar reports a mid-session failure, not a start failure.
		const setStatus = sessionCtx.ui.setStatus as ReturnType<typeof vi.fn>
		expect(setStatus.mock.lastCall).toEqual(["lsp", "LSP: typescript-language-server failed"])
	})

	it("records an eager session_start failure and skips respawning on later file ops", async () => {
		const { dir, ext, consoleSpy } = makeSession(["package.json"])
		const sessionCtx = createContext({ cwd: dir })
		await ext.getHandler<unknown, unknown>("session_start")(null, sessionCtx)
		// Marker present → eager start attempted and failed (rejection handled async).
		await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalledTimes(1))
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)

		const toolResult = ext.getHandler<unknown, unknown>("tool_result")
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))

		// No respawn, no repeat log, no file sync attempted.
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		expect(consoleSpy).toHaveBeenCalledTimes(1)
		expect(mocks.ensureFileOpen).not.toHaveBeenCalled()
		expect(mocks.refreshFile).not.toHaveBeenCalled()
	})

	it("retries server startup in a new session", async () => {
		const { dir, ext, consoleSpy } = makeSession()
		const toolResult = ext.getHandler<unknown, unknown>("tool_result")

		await ext.getHandler<unknown, unknown>("session_start")(null, createContext({ cwd: dir }))
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		expect(consoleSpy).toHaveBeenCalledTimes(1)

		// session_start resets the failure cache — a new session retries once.
		await ext.getHandler<unknown, unknown>("session_start")(null, createContext({ cwd: dir }))
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(2)
		expect(consoleSpy).toHaveBeenCalledTimes(2)
	})

	it("lsp tools fail with an actionable message instead of respawning", async () => {
		const { dir, ext, consoleSpy } = makeSession()
		const sessionCtx = createContext({ cwd: dir })
		await ext.getHandler<unknown, unknown>("session_start")(null, sessionCtx)

		const diagnosticTool = ext.getRegisteredTool("lsp_diagnostics")
		const filePath = path.join(dir, "foo.ts")
		const args = [filePath] as const

		// First call propagates the real server error (agent-readable).
		await expect(
			diagnosticTool.execute(
				"call-1",
				{ file_path: args[0] },
				undefined as never,
				undefined as never,
				sessionCtx as never,
			),
		).rejects.toThrow(INIT_FAILURE)
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)

		// The tool-path failure surfaces exactly like a file-sync failure: one
		// log line and a status-bar indicator (previously it was silent).
		expect(consoleSpy).toHaveBeenCalledTimes(1)
		const setStatus = sessionCtx.ui.setStatus as ReturnType<typeof vi.fn>
		expect(setStatus.mock.lastCall).toEqual(["lsp", "LSP: typescript-language-server failed to start"])

		// Second call short-circuits with the actionable session-scoped message,
		// without logging or touching the status bar again.
		await expect(
			diagnosticTool.execute(
				"call-2",
				{ file_path: args[0] },
				undefined as never,
				undefined as never,
				sessionCtx as never,
			),
		).rejects.toThrow(/failed to start for this session/)
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		expect(consoleSpy).toHaveBeenCalledTimes(1)
	})

	it("marks a mid-session sync failure as 'failed' (not 'failed to start') and stops syncing", async () => {
		const { dir, ext, consoleSpy } = makeSession()
		const sessionCtx = createContext({ cwd: dir })
		await ext.getHandler<unknown, unknown>("session_start")(null, sessionCtx)

		// Server starts fine, then dies while syncing the first edit.
		mocks.getOrCreateClient.mockReset().mockResolvedValue({ diagnostics: new Map() })
		mocks.refreshFile.mockRejectedValue(new Error("LSP connection closed"))

		const toolResult = ext.getHandler<unknown, unknown>("tool_result")
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))

		// The status bar tells a mid-session crash apart from a start failure.
		const setStatus = sessionCtx.ui.setStatus as ReturnType<typeof vi.fn>
		expect(setStatus.mock.lastCall).toEqual(["lsp", "LSP: typescript-language-server failed"])
		expect(consoleSpy).toHaveBeenCalledTimes(1)

		// Later edits skip the dead server without logging again…
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		expect(consoleSpy).toHaveBeenCalledTimes(1)

		// …and tools report the mid-session failure accurately.
		const diagnosticTool = ext.getRegisteredTool("lsp_diagnostics")
		await expect(
			diagnosticTool.execute(
				"call-1",
				{ file_path: path.join(dir, "foo.ts") },
				undefined as never,
				undefined as never,
				sessionCtx as never,
			),
		).rejects.toThrow(/^LSP server typescript-language-server failed for this session/)
	})

	it("keeps a failed server's status indicator when a healthy server syncs afterwards", async () => {
		mocks.detectServers.mockReturnValue([mocks.tsServer, mocks.goServer])
		mocks.serverForFile.mockImplementation((filePath: string) =>
			filePath.endsWith(".go") ? mocks.goServer : mocks.tsServer,
		)
		mocks.getOrCreateClient.mockImplementation(async (server: { command: string }) => {
			if (server.command === "gopls") return { diagnostics: new Map() }
			throw new Error(INIT_FAILURE)
		})

		const { dir, ext } = makeSession()
		const sessionCtx = createContext({ cwd: dir })
		await ext.getHandler<unknown, unknown>("session_start")(null, sessionCtx)

		const toolResult = ext.getHandler<unknown, unknown>("tool_result")
		const setStatus = sessionCtx.ui.setStatus as ReturnType<typeof vi.fn>

		// typescript-language-server fails to start; gopls stays healthy.
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		expect(setStatus.mock.lastCall).toEqual(["lsp", "LSP: typescript-language-server failed to start, gopls"])

		// A successful gopls sync follows — the failure indicator must survive.
		await toolResult(editToolResult("main.go"), createContext({ cwd: dir }))
		expect(mocks.refreshFile).toHaveBeenCalledTimes(1)
		expect(setStatus.mock.lastCall).toEqual(["lsp", "LSP: typescript-language-server failed to start, gopls"])
	})
})
