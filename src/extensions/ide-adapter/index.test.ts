import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ideAdapterExtension from "./index.js"
import { findMatchingLockfile, getLockfileDir, parseLockfile, scanLockfiles } from "./lockfile.js"
import { connectToIde } from "./mcp-client.js"
import type { LockfileData } from "./types.js"

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
	} {
		return {
			hasUI: options.hasUI ?? true,
			ui: {
				pasteToEditor: options.pasteToEditor ?? vi.fn(),
				setStatus: options.setStatus ?? vi.fn(),
			},
			cwd: "/tmp",
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

			expect(pasteToEditor).toHaveBeenCalledWith("@../a/b.ts:10-20")
			expect(ctx.ui.setStatus).toHaveBeenCalledWith("ide-adapter-mention", undefined)
			// Should NOT queue when pasted immediately
			const inputResult = pi._handlers.input[0]({ text: "hello" })
			expect(inputResult).toBeUndefined()
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
			expect(inputResult).toEqual({ action: "transform", text: "@../a/b.ts:10-20 hello" })
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
})
