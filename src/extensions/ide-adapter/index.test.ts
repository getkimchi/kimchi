import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdeSelectionIndicator } from "../ui.js"
import ideAdapterExtension from "./index.js"
import { findMatchingLockfile, getLockfileDir, parseLockfile, scanLockfiles } from "./lockfile.js"
import { connectToIde } from "./mcp-client.js"
import type { LockfileData } from "./types.js"

vi.mock("../ui.js", () => ({
	setIdeSelectionIndicator: vi.fn(),
}))

vi.mock("../permissions/mode-controller.js", () => ({
	getPermissionMode: vi.fn(() => ({ mode: "default", source: "config", initiatedBy: "user" })),
}))

vi.mock("./mcp-client.js", () => ({
	connectToIde: vi.fn(),
}))

vi.mock("./lockfile.js", () => ({
	scanLockfiles: vi.fn(),
	parseLockfile: vi.fn(),
	findMatchingLockfile: vi.fn(),
	getLockfileDir: vi.fn(),
	getLockfilePid: vi.fn().mockReturnValue(null),
	isProcessAlive: vi.fn().mockReturnValue(true),
}))

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
}))

import { readFileSync } from "node:fs"

describe("ide-adapter extension", () => {
	function createFakeExtensionAPI(): ExtensionAPI & {
		_handlers: Record<string, ((...args: unknown[]) => unknown)[]>
		registeredTools: Array<{
			name: string
			label: string
			description: string
			parameters: Record<string, unknown>
			execute: (...args: unknown[]) => unknown
		}>
	} {
		const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {}
		const registeredTools: Array<{
			name: string
			label: string
			description: string
			parameters: Record<string, unknown>
			execute: (...args: unknown[]) => unknown
		}> = []
		return {
			on: (event: string, handler: (...args: unknown[]) => unknown) => {
				if (!handlers[event]) handlers[event] = []
				handlers[event].push(handler)
			},
			_handlers: handlers,
			registeredTools,
			registerTool: vi.fn(
				(tool: {
					name: string
					label: string
					description: string
					parameters: Record<string, unknown>
					execute: (...args: unknown[]) => unknown
				}) => {
					registeredTools.push(tool)
				},
			),
			addContextFiles: vi.fn(),
			removeContextFiles: vi.fn(),
			defineCommand: vi.fn(),
			requireApproval: vi.fn(),
			sendMessage: vi.fn(),
			setSystemPrompt: vi.fn(),
			setCustomSystemPrompt: vi.fn(),
			setModelRole: vi.fn(),
			addSystemPromptBlock: vi.fn(),
			removeSystemPromptBlock: vi.fn(),
			showUI: vi.fn(),
			hideUI: vi.fn(),
			disableUI: vi.fn(),
			restoreUI: vi.fn(),
			setModelRegistry: vi.fn(),
			setThinkingLevel: vi.fn(),
			attachFiles: vi.fn(),
			detachFiles: vi.fn(),
			events: {
				on: vi.fn(),
				off: vi.fn(),
				emit: vi.fn(),
			},
		} as unknown as ExtensionAPI & {
			_handlers: Record<string, ((...args: unknown[]) => unknown)[]>
			registeredTools: Array<{
				name: string
				label: string
				description: string
				parameters: Record<string, unknown>
				execute: (...args: unknown[]) => unknown
			}>
		}
	}

	function createFakeCtx(
		options: { hasUI?: boolean; pasteToEditor?: ReturnType<typeof vi.fn>; setStatus?: ReturnType<typeof vi.fn> } = {},
	): {
		hasUI: boolean
		ui: { pasteToEditor: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> }
		cwd: string
		sessionManager: { getSessionId: () => string }
	} {
		return {
			hasUI: options.hasUI ?? true,
			ui: {
				pasteToEditor: options.pasteToEditor ?? vi.fn(),
				setStatus: options.setStatus ?? vi.fn(),
			},
			cwd: "/tmp",
			sessionManager: { getSessionId: () => "test-session" },
		}
	}

	describe("handler registration", () => {
		it("registers session_start, input, and session_shutdown handlers", () => {
			const pi = createFakeExtensionAPI()
			ideAdapterExtension(pi)
			expect(pi._handlers.session_start).toHaveLength(1)
			expect(pi._handlers.input).toHaveLength(1)
			expect(pi._handlers.session_shutdown).toHaveLength(1)
		})
	})

	/**
	 * Build a mock MCP `tools/call` response envelope matching the shape that
	 * `McpJsonRpc.kt` produces on the IDE side:
	 * `{ content: [{ type: "text", text: "<json-stringified-payload>" }] }`.
	 *
	 * Tests must use this (not the raw payload) because `requestIdeApproval`
	 * unwraps the MCP content envelope before reading `approved`.
	 */
	function mcpEnvelope(payload: Record<string, unknown>): unknown {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		}
	}

	describe("input handler", () => {
		it("passes through when no pending mentions", () => {
			const pi = createFakeExtensionAPI()
			ideAdapterExtension(pi)
			const result = pi._handlers.input[0]({ text: "hello" })
			expect(result).toBeUndefined()
		})
	})

	describe("at_mentioned notification", () => {
		beforeEach(() => {
			vi.useFakeTimers()
			vi.mocked(connectToIde).mockReset()
			vi.mocked(scanLockfiles).mockReset()
			vi.mocked(parseLockfile).mockReset()
			vi.mocked(findMatchingLockfile).mockReset()
			vi.mocked(getLockfileDir).mockReset()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("pastes mention immediately into editor when UI is available", async () => {
			const pi = createFakeExtensionAPI()
			const pasteToEditor = vi.fn()
			const ctx = createFakeCtx({ hasUI: true, pasteToEditor })
			ideAdapterExtension(pi)

			const fakeConnection = {
				lockfile: { ideName: "TestIDE" },
				listTools: vi.fn().mockResolvedValue([]),
				callTool: vi.fn(),
				close: vi.fn().mockResolvedValue(undefined),
				setNotificationHandler: vi.fn(),
			}
			vi.mocked(connectToIde).mockResolvedValue(fakeConnection as unknown as Awaited<ReturnType<typeof connectToIde>>)
			vi.mocked(getLockfileDir).mockReturnValue("/tmp/locks")
			vi.mocked(scanLockfiles).mockReturnValue(["/tmp/locks/ide.lock"])
			vi.mocked(parseLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)
			vi.mocked(findMatchingLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)

			pi._handlers.session_start[0](null, ctx)
			await vi.advanceTimersByTimeAsync(0)

			const setHandler = vi.mocked(fakeConnection.setNotificationHandler)
			expect(setHandler).toHaveBeenCalled()
			const handler = setHandler.mock.calls[0][0]

			handler({ method: "at_mentioned", params: { filePath: "/a/b.ts", lineStart: 10, lineEnd: 20 } })

			expect(pasteToEditor).toHaveBeenCalledWith("@/a/b.ts:10-20")
			expect(ctx.ui.setStatus).toHaveBeenCalledWith("ide-adapter-mention", undefined)
			// Should NOT queue when pasted immediately
			const inputResult = pi._handlers.input[0]({ text: "hello" })
			expect(inputResult).toBeUndefined()
		})

		it("queues mention when pasteToEditor throws (e.g. editor hidden or no active editor)", async () => {
			const pi = createFakeExtensionAPI()
			const pasteToEditor = vi.fn(() => {
				throw new Error("No active editor")
			})
			const ctx = createFakeCtx({ hasUI: true, pasteToEditor })
			ideAdapterExtension(pi)

			const fakeConnection = {
				lockfile: { ideName: "TestIDE" },
				listTools: vi.fn().mockResolvedValue([]),
				callTool: vi.fn(),
				close: vi.fn().mockResolvedValue(undefined),
				setNotificationHandler: vi.fn(),
			}
			vi.mocked(connectToIde).mockResolvedValue(fakeConnection as unknown as Awaited<ReturnType<typeof connectToIde>>)
			vi.mocked(getLockfileDir).mockReturnValue("/tmp/locks")
			vi.mocked(scanLockfiles).mockReturnValue(["/tmp/locks/ide.lock"])
			vi.mocked(parseLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)
			vi.mocked(findMatchingLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)

			pi._handlers.session_start[0](null, ctx)
			await vi.advanceTimersByTimeAsync(0)

			const setHandler = vi.mocked(fakeConnection.setNotificationHandler)
			const handler = setHandler.mock.calls[0][0]

			handler({ method: "at_mentioned", params: { filePath: "/a/b.ts", lineStart: 10, lineEnd: 20 } })

			expect(pasteToEditor).toHaveBeenCalledWith("@/a/b.ts:10-20")
			expect(ctx.ui.setStatus).not.toHaveBeenCalled()
			// Falls back to queue — next input should prepend the mention
			const inputResult = pi._handlers.input[0]({ text: "hello" })
			expect(inputResult).toEqual({ action: "transform", text: "@/a/b.ts:10-20 hello" })
		})

		it("queues mention when UI is not available", async () => {
			const pi = createFakeExtensionAPI()
			const ctx = createFakeCtx({ hasUI: false, pasteToEditor: vi.fn() })
			ideAdapterExtension(pi)

			const fakeConnection = {
				lockfile: { ideName: "TestIDE" },
				listTools: vi.fn().mockResolvedValue([]),
				callTool: vi.fn(),
				close: vi.fn().mockResolvedValue(undefined),
				setNotificationHandler: vi.fn(),
			}
			vi.mocked(connectToIde).mockResolvedValue(fakeConnection as unknown as Awaited<ReturnType<typeof connectToIde>>)
			vi.mocked(getLockfileDir).mockReturnValue("/tmp/locks")
			vi.mocked(scanLockfiles).mockReturnValue(["/tmp/locks/ide.lock"])
			vi.mocked(parseLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)
			vi.mocked(findMatchingLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)

			pi._handlers.session_start[0](null, ctx)
			await vi.advanceTimersByTimeAsync(0)

			const setHandler = vi.mocked(fakeConnection.setNotificationHandler)
			const handler = setHandler.mock.calls[0][0]

			handler({ method: "at_mentioned", params: { filePath: "/a/b.ts", lineStart: 10, lineEnd: 20 } })

			expect(ctx.ui.pasteToEditor).not.toHaveBeenCalled()
			const inputResult = pi._handlers.input[0]({ text: "hello" })
			expect(inputResult).toEqual({ action: "transform", text: "@/a/b.ts:10-20 hello" })
		})
	})

	describe("session lifecycle", () => {
		beforeEach(() => {
			vi.useFakeTimers()
			vi.mocked(connectToIde).mockReset()
			vi.mocked(scanLockfiles).mockReset()
			vi.mocked(parseLockfile).mockReset()
			vi.mocked(findMatchingLockfile).mockReset()
			vi.mocked(getLockfileDir).mockReset()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("session_start does not throw", () => {
			const pi = createFakeExtensionAPI()
			ideAdapterExtension(pi)
			expect(() => pi._handlers.session_start[0](null, { cwd: "/tmp" })).not.toThrow()
		})

		it("session_shutdown does not throw", () => {
			const pi = createFakeExtensionAPI()
			ideAdapterExtension(pi)
			expect(() => pi._handlers.session_shutdown[0]()).not.toThrow()
		})

		it("stops polling after 3 failed connection attempts", async () => {
			vi.mocked(getLockfileDir).mockReturnValue("/tmp/locks")
			vi.mocked(scanLockfiles).mockReturnValue(["/tmp/locks/ide.lock"])
			vi.mocked(parseLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)
			vi.mocked(findMatchingLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)
			vi.mocked(connectToIde).mockRejectedValue(new Error("connection refused"))

			const pi = createFakeExtensionAPI()
			ideAdapterExtension(pi)

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			pi._handlers.session_start[0](null, { cwd: "/tmp" })

			// Initial discoverAndConnect is called synchronously; flush microtasks
			await vi.advanceTimersByTimeAsync(0)
			expect(connectToIde).toHaveBeenCalledTimes(1)

			// Tick 1 more poll interval – attempt 2
			await vi.advanceTimersByTimeAsync(5000)
			expect(connectToIde).toHaveBeenCalledTimes(2)

			// Tick 1 more poll interval – attempt 3
			await vi.advanceTimersByTimeAsync(5000)
			expect(connectToIde).toHaveBeenCalledTimes(3)

			// After 3 failures the timer should be cleared, so another tick does nothing
			await vi.advanceTimersByTimeAsync(5000)
			expect(connectToIde).toHaveBeenCalledTimes(3)

			expect(warnSpy).toHaveBeenCalledWith(
				"[ide-adapter] Max reconnect retries (3) reached. Stopping discovery polling.",
			)

			warnSpy.mockRestore()
		})

		it("resets retry counter on successful connection", async () => {
			vi.mocked(getLockfileDir).mockReturnValue("/tmp/locks")
			vi.mocked(scanLockfiles).mockReturnValue(["/tmp/locks/ide.lock"])
			vi.mocked(parseLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)
			vi.mocked(findMatchingLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)

			// Fail twice, then succeed
			vi.mocked(connectToIde)
				.mockRejectedValueOnce(new Error("fail 1"))
				.mockRejectedValueOnce(new Error("fail 2"))
				.mockResolvedValueOnce({
					lockfile: { ideName: "TestIDE" },
					listTools: vi.fn().mockResolvedValue([]),
					callTool: vi.fn(),
					close: vi.fn().mockResolvedValue(undefined),
					setNotificationHandler: vi.fn(),
				} as unknown as Awaited<ReturnType<typeof connectToIde>>)

			const pi = createFakeExtensionAPI()
			ideAdapterExtension(pi)

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

			pi._handlers.session_start[0](null, { cwd: "/tmp" })

			// Initial attempt fails
			await vi.advanceTimersByTimeAsync(0)
			expect(connectToIde).toHaveBeenCalledTimes(1)

			// Tick – 2nd attempt fails
			await vi.advanceTimersByTimeAsync(5000)
			expect(connectToIde).toHaveBeenCalledTimes(2)

			// Tick – 3rd attempt succeeds
			await vi.advanceTimersByTimeAsync(5000)
			expect(connectToIde).toHaveBeenCalledTimes(3)

			// Timer is still alive but connection is set, so next tick does not call connectToIde
			await vi.advanceTimersByTimeAsync(5000)
			expect(connectToIde).toHaveBeenCalledTimes(3)

			warnSpy.mockRestore()
			logSpy.mockRestore()
		})
	})

	describe("tool_call approval hook", () => {
		beforeEach(() => {
			vi.useFakeTimers()
			vi.mocked(connectToIde).mockReset()
			vi.mocked(scanLockfiles).mockReset()
			vi.mocked(parseLockfile).mockReset()
			vi.mocked(findMatchingLockfile).mockReset()
			vi.mocked(getLockfileDir).mockReset()
			vi.mocked(readFileSync).mockReset()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		/**
		 * Wire up a fake IDE connection synchronously and fire session_start so
		 * the adapter's module-local `connection` variable is populated.
		 */
		async function setupWithConnection(callToolImpl: ReturnType<typeof vi.fn>): Promise<{
			pi: ReturnType<typeof createFakeExtensionAPI>
			ctx: ReturnType<typeof createFakeCtx>
		}> {
			const fakeConnection = {
				lockfile: { ideName: "TestIDE" },
				listTools: vi.fn().mockResolvedValue([]),
				callTool: callToolImpl,
				close: vi.fn().mockResolvedValue(undefined),
				setNotificationHandler: vi.fn(),
			}
			vi.mocked(connectToIde).mockResolvedValue(fakeConnection as unknown as Awaited<ReturnType<typeof connectToIde>>)
			vi.mocked(getLockfileDir).mockReturnValue("/tmp/locks")
			vi.mocked(scanLockfiles).mockReturnValue(["/tmp/locks/ide.lock"])
			vi.mocked(parseLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)
			vi.mocked(findMatchingLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)

			const pi = createFakeExtensionAPI()
			const ctx = createFakeCtx({ hasUI: false })
			ideAdapterExtension(pi)
			pi._handlers.session_start[0](null, ctx)
			// Flush the discoverAndConnect microtask so `connection` is populated
			// before tool_call runs. Without this the approval hook short-circuits
			// on the "IDE not connected" branch.
			await vi.advanceTimersByTimeAsync(0)
			return { pi, ctx }
		}

		it("ignores tool calls that are not write or edit", async () => {
			const { pi, ctx } = await setupWithConnection(vi.fn().mockResolvedValue({ approved: true }))
			const result = await pi._handlers.tool_call[0]({ toolName: "read", input: { path: "/tmp/a" } }, ctx)
			expect(result).toBeUndefined()
		})

		it("is a no-op when no IDE is connected", async () => {
			// No lockfiles → no connection
			vi.mocked(getLockfileDir).mockReturnValue("/tmp/locks")
			vi.mocked(scanLockfiles).mockReturnValue([])

			const pi = createFakeExtensionAPI()
			const ctx = createFakeCtx({ hasUI: false })
			ideAdapterExtension(pi)
			pi._handlers.session_start[0](null, ctx)
			await vi.advanceTimersByTimeAsync(0)

			const result = await pi._handlers.tool_call[0](
				{ toolName: "write", input: { path: "a.txt", content: "new" } },
				ctx,
			)
			expect(result).toBeUndefined()
		})

		it("blocks when the user rejects the change", async () => {
			vi.mocked(readFileSync).mockReturnValue("old")
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: false }))
			const { pi, ctx } = await setupWithConnection(callTool)

			const result = await pi._handlers.tool_call[0](
				{ toolName: "write", input: { path: "a.txt", content: "new" } },
				ctx,
			)
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("User rejected the proposed change"),
			})
			expect(result).toMatchObject({ block: true })
			expect(callTool).toHaveBeenCalledWith(
				"proposeChange",
				expect.objectContaining({
					originalContent: "old",
					newContent: "new",
				}),
				undefined,
			)
		})

		it("lets the tool proceed when the user approves", async () => {
			vi.mocked(readFileSync).mockReturnValue("old")
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true }))
			const { pi, ctx } = await setupWithConnection(callTool)

			const result = await pi._handlers.tool_call[0](
				{ toolName: "write", input: { path: "a.txt", content: "new" } },
				ctx,
			)
			expect(result).toBeUndefined()
			expect(callTool).toHaveBeenCalledWith(
				"proposeChange",
				expect.objectContaining({
					originalContent: "old",
					newContent: "new",
				}),
				undefined,
			)
		})

		it("computes newContent for edit by applying operations", async () => {
			vi.mocked(readFileSync).mockReturnValue("hello world")
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true }))
			const { pi, ctx } = await setupWithConnection(callTool)

			await pi._handlers.tool_call[0](
				{
					toolName: "edit",
					input: { path: "a.txt", edits: [{ oldText: "world", newText: "kimchi" }] },
				},
				ctx,
			)
			expect(callTool).toHaveBeenCalledWith(
				"proposeChange",
				expect.objectContaining({
					originalContent: "hello world",
					newContent: "hello kimchi",
				}),
				undefined,
			)
		})

		it("blocks when edit oldText is not found (fail-closed)", async () => {
			vi.mocked(readFileSync).mockReturnValue("hello")
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true }))
			const { pi, ctx } = await setupWithConnection(callTool)

			const result = await pi._handlers.tool_call[0](
				{
					toolName: "edit",
					input: { path: "a.txt", edits: [{ oldText: "missing", newText: "x" }] },
				},
				ctx,
			)
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("Could not compute the proposed change"),
			})
			expect(callTool).not.toHaveBeenCalled()
		})

		it("blocks when the IDE call itself fails (fail-closed)", async () => {
			vi.mocked(readFileSync).mockReturnValue("old")
			const callTool = vi.fn().mockRejectedValue(new Error("ws closed"))
			const { pi, ctx } = await setupWithConnection(callTool)

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const result = await pi._handlers.tool_call[0](
				{ toolName: "write", input: { path: "a.txt", content: "new" } },
				ctx,
			)
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("IDE approval failed"),
			})
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("proposeChange call failed"))
			warnSpy.mockRestore()
		})

		it("blocks when the IDE returns a malformed response (fail-closed)", async () => {
			vi.mocked(readFileSync).mockReturnValue("old")
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ weirdShape: true }))
			const { pi, ctx } = await setupWithConnection(callTool)
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const result = await pi._handlers.tool_call[0](
				{ toolName: "write", input: { path: "a.txt", content: "new" } },
				ctx,
			)
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("IDE approval failed"),
			})
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("proposeChange call failed"))
			warnSpy.mockRestore()
		})

		it("blocks without calling the IDE when the signal is already aborted", async () => {
			vi.mocked(readFileSync).mockReturnValue("old")
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true }))
			const { pi, ctx } = await setupWithConnection(callTool)

			const controller = new AbortController()
			controller.abort()
			const result = await pi._handlers.tool_call[0](
				{ toolName: "write", input: { path: "a.txt", content: "new" } },
				{ ...ctx, signal: controller.signal },
			)
			expect(callTool).not.toHaveBeenCalled()
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("IDE approval failed"),
			})
		})

		it("forwards the abort signal to connection.callTool", async () => {
			vi.mocked(readFileSync).mockReturnValue("old")
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true }))
			const { pi, ctx } = await setupWithConnection(callTool)

			const controller = new AbortController()
			await pi._handlers.tool_call[0](
				{ toolName: "write", input: { path: "a.txt", content: "new" } },
				{ ...ctx, signal: controller.signal },
			)
			expect(callTool).toHaveBeenCalledWith(
				"proposeChange",
				expect.objectContaining({ filePath: expect.stringContaining("a.txt") }),
				controller.signal,
			)
		})

		it("handles write to a new file (empty originalContent)", async () => {
			vi.mocked(readFileSync).mockImplementation(() => {
				const err = new Error("ENOENT") as Error & { code: string }
				err.code = "ENOENT"
				throw err
			})
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true }))
			const { pi, ctx } = await setupWithConnection(callTool)

			await pi._handlers.tool_call[0]({ toolName: "write", input: { path: "new.txt", content: "fresh" } }, ctx)
			expect(callTool).toHaveBeenCalledWith(
				"proposeChange",
				expect.objectContaining({
					originalContent: "",
					newContent: "fresh",
				}),
				undefined,
			)
		})

		it("overrides write.input.content when the user hand-edits the proposed content", async () => {
			vi.mocked(readFileSync).mockReturnValue("old")
			// IDE returns approved=true with newContent = the user's edited version,
			// which differs from the agent's original proposal ("new").
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true, newContent: "user-edited content" }))
			const { pi, ctx } = await setupWithConnection(callTool)

			const eventInput: Record<string, unknown> = { path: "a.txt", content: "new" }
			const result = await pi._handlers.tool_call[0]({ toolName: "write", input: eventInput }, ctx)
			expect(result).toBeUndefined()
			// The hook must have mutated the input so the write tool applies the user's text.
			expect(eventInput.content).toBe("user-edited content")
		})

		it("does not override write.input when the user did not edit the proposed content", async () => {
			vi.mocked(readFileSync).mockReturnValue("old")
			// IDE returns approved=true with newContent = the agent's original proposal.
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true, newContent: "new" }))
			const { pi, ctx } = await setupWithConnection(callTool)

			const eventInput: Record<string, unknown> = { path: "a.txt", content: "new" }
			await pi._handlers.tool_call[0]({ toolName: "write", input: eventInput }, ctx)
			// No override — the agent's original content is preserved.
			expect(eventInput.content).toBe("new")
		})

		it("overrides edit.input.edits with a full-file replacement when the user hand-edits the proposed content", async () => {
			vi.mocked(readFileSync).mockReturnValue("hello world")
			// Agent proposes replacing "world" -> "kimchi" (final newContent = "hello kimchi").
			// User then hand-edits the proposed pane to "hello KIMCHI". The hook must
			// rewrite input.edits as a single full-file replace.
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true, newContent: "hello KIMCHI" }))
			const { pi, ctx } = await setupWithConnection(callTool)

			const eventInput: Record<string, unknown> = {
				path: "a.txt",
				edits: [{ oldText: "world", newText: "kimchi" }],
			}
			const result = await pi._handlers.tool_call[0]({ toolName: "edit", input: eventInput }, ctx)
			expect(result).toBeUndefined()
			// input.edits is rewritten to a single full-file replacement operation.
			expect(eventInput.edits).toEqual([{ oldText: "hello world", newText: "hello KIMCHI" }])
			// Legacy single-operation fields are cleared.
			expect(eventInput.oldText).toBeUndefined()
			expect(eventInput.newText).toBeUndefined()
		})

		it("blocks when file is unreadable for non-ENOENT reasons", async () => {
			vi.mocked(readFileSync).mockImplementation(() => {
				const err = new Error("permission denied") as Error & { code: string }
				err.code = "EACCES"
				throw err
			})
			const callTool = vi.fn().mockResolvedValue(mcpEnvelope({ approved: true }))
			const { pi, ctx } = await setupWithConnection(callTool)
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const result = await pi._handlers.tool_call[0](
				{ toolName: "write", input: { path: "a.txt", content: "new" } },
				ctx,
			)
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("Could not compute the proposed change"),
			})
			expect(callTool).not.toHaveBeenCalled()
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to read"), expect.any(Error))
			warnSpy.mockRestore()
		})
	})

	describe("selection_changed notification", () => {
		beforeEach(() => {
			vi.useFakeTimers()
			vi.mocked(connectToIde).mockReset()
			vi.mocked(scanLockfiles).mockReset()
			vi.mocked(parseLockfile).mockReset()
			vi.mocked(findMatchingLockfile).mockReset()
			vi.mocked(getLockfileDir).mockReset()
			vi.mocked(setIdeSelectionIndicator).mockReset()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("clears the selection indicator when lineStart:0 and lineEnd:0", async () => {
			const fakeConnection = {
				lockfile: { ideName: "TestIDE" },
				listTools: vi.fn().mockResolvedValue([]),
				callTool: vi.fn(),
				close: vi.fn().mockResolvedValue(undefined),
				setNotificationHandler: vi.fn(),
			}
			vi.mocked(connectToIde).mockResolvedValue(fakeConnection as unknown as Awaited<ReturnType<typeof connectToIde>>)
			vi.mocked(getLockfileDir).mockReturnValue("/tmp/locks")
			vi.mocked(scanLockfiles).mockReturnValue(["/tmp/locks/ide.lock"])
			vi.mocked(parseLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)
			vi.mocked(findMatchingLockfile).mockReturnValue({
				port: 12345,
				pid: 1,
				ideName: "TestIDE",
				ideVersion: "1.0",
				transport: "ws",
				workspaceFolders: ["/tmp"],
				authToken: "tok",
			} as LockfileData)

			const pi = createFakeExtensionAPI()
			const ctx = createFakeCtx({ hasUI: true })
			ideAdapterExtension(pi)
			pi._handlers.session_start[0](null, ctx)
			await vi.advanceTimersByTimeAsync(0)

			const handler = vi.mocked(fakeConnection.setNotificationHandler).mock.calls[0][0]

			// First, set a selection
			handler({ method: "selection_changed", params: { filePath: "/a/b.ts", lineStart: 10, lineEnd: 20 } })
			expect(setIdeSelectionIndicator).toHaveBeenCalledWith("@/a/b.ts:10-20")

			// Then send a 0:0 selection — should clear per CONTRACT.md
			vi.mocked(setIdeSelectionIndicator).mockClear()
			handler({ method: "selection_changed", params: { filePath: "/a/b.ts", lineStart: 0, lineEnd: 0 } })
			expect(setIdeSelectionIndicator).toHaveBeenCalledWith(null)
		})
	})
})
