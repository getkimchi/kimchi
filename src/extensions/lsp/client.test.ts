import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { shutdownIdleClientsIn } from "./client.js"
import type { LspClient, PendingRequest } from "./types.js"

// =============================================================================
// Test helpers
// =============================================================================

const FIXED_NOW = 1_000_000_000
const THRESHOLD = 15 * 60 * 1000

/**
 * Build a minimal fake LspClient with only the fields that shutdownIdleClientsIn
 * and sendRequest touch. Cast through unknown to avoid filling in every field
 * of the LspClient interface.
 */
function makeFakeClient(opts: {
	lastActivity?: number
	pendingRequestsCount?: number
	progressTokenCount?: number
}): { client: LspClient; killMock: ReturnType<typeof vi.fn>; stdinWriteMock: ReturnType<typeof vi.fn> } {
	const killMock = vi.fn()
	const stdinWriteMock = vi.fn()
	const stdinFlushMock = vi.fn().mockResolvedValue(undefined)

	const pendingRequests = new Map<number, PendingRequest>()
	for (let i = 0; i < (opts.pendingRequestsCount ?? 0); i++) {
		pendingRequests.set(i + 1, {
			resolve: vi.fn(),
			reject: vi.fn(),
			method: "textDocument/hover",
		})
	}

	const activeProgressTokens = new Set<string | number>()
	for (let i = 0; i < (opts.progressTokenCount ?? 0); i++) {
		activeProgressTokens.add(`token-${i}`)
	}

	const client = {
		name: "gopls:/project",
		cwd: "/project",
		proc: {
			stdin: { write: stdinWriteMock, flush: stdinFlushMock, end: vi.fn() },
			stdout: new ReadableStream(),
			stderr: new ReadableStream(),
			kill: killMock,
			exited: new Promise<void>(() => {}),
			exitCode: null,
		},
		requestId: 0,
		lastActivity: opts.lastActivity ?? FIXED_NOW,
		pendingRequests,
		activeProgressTokens,
	} as unknown as LspClient

	return { client, killMock, stdinWriteMock }
}

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(FIXED_NOW)
})

afterEach(() => {
	vi.clearAllTimers()
	vi.useRealTimers()
})

// =============================================================================
// shutdownIdleClientsIn
// =============================================================================

describe("shutdownIdleClientsIn", () => {
	it("does not shut down a client within the idle threshold", () => {
		const { client, killMock } = makeFakeClient({ lastActivity: FIXED_NOW - 60_000 }) // 1 min ago
		const clientMap = new Map([["gopls:/project", client]])
		const lockMap = new Map<string, Promise<LspClient>>()

		shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)

		expect(killMock).not.toHaveBeenCalled()
		expect(clientMap.has("gopls:/project")).toBe(true)
	})

	it("shuts down a client whose lastActivity exceeds the threshold", () => {
		const { client, killMock } = makeFakeClient({ lastActivity: FIXED_NOW - THRESHOLD - 1 })
		const clientMap = new Map([["gopls:/project", client]])
		const lockMap = new Map<string, Promise<LspClient>>()

		shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)

		expect(killMock).toHaveBeenCalledTimes(1)
		expect(clientMap.has("gopls:/project")).toBe(false)
	})

	it("removes the client from the lock map after shutdown", () => {
		const { client } = makeFakeClient({ lastActivity: FIXED_NOW - THRESHOLD - 1 })
		const clientMap = new Map([["gopls:/project", client]])
		const lockMap = new Map<string, Promise<LspClient>>([["gopls:/project", Promise.resolve(client)]])

		shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)

		expect(lockMap.has("gopls:/project")).toBe(false)
	})

	it("does not shut down a client with pending requests", () => {
		const { client, killMock } = makeFakeClient({
			lastActivity: FIXED_NOW - THRESHOLD - 1,
			pendingRequestsCount: 1,
		})
		const clientMap = new Map([["gopls:/project", client]])
		const lockMap = new Map<string, Promise<LspClient>>()

		shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)

		expect(killMock).not.toHaveBeenCalled()
		expect(clientMap.has("gopls:/project")).toBe(true)
	})

	it("does not shut down a client with active progress tokens", () => {
		const { client, killMock } = makeFakeClient({
			lastActivity: FIXED_NOW - THRESHOLD - 1,
			progressTokenCount: 1,
		})
		const clientMap = new Map([["gopls:/project", client]])
		const lockMap = new Map<string, Promise<LspClient>>()

		shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)

		expect(killMock).not.toHaveBeenCalled()
		expect(clientMap.has("gopls:/project")).toBe(true)
	})

	it("sends LSP shutdown request before killing the process", () => {
		const { client, killMock, stdinWriteMock } = makeFakeClient({ lastActivity: FIXED_NOW - THRESHOLD - 1 })
		const clientMap = new Map([["gopls:/project", client]])
		const lockMap = new Map<string, Promise<LspClient>>()

		shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)

		// stdinWrite is called synchronously by writeMessage inside sendRequest,
		// before proc.kill() runs. Verify both were called and in the right order.
		expect(stdinWriteMock).toHaveBeenCalledTimes(1)
		expect(killMock).toHaveBeenCalledTimes(1)
		expect(stdinWriteMock.mock.invocationCallOrder[0]).toBeLessThan(killMock.mock.invocationCallOrder[0])

		// Verify the written message contains the shutdown method
		const writtenData = stdinWriteMock.mock.calls[0][0] as string
		expect(writtenData).toContain('"shutdown"')
	})

	it("handles multiple clients — shuts down only idle ones", () => {
		const idleClient = makeFakeClient({ lastActivity: FIXED_NOW - THRESHOLD - 1 })
		const activeClient = makeFakeClient({ lastActivity: FIXED_NOW - 30_000 })
		const clientMap = new Map([
			["gopls:/idle", idleClient.client],
			["gopls:/active", activeClient.client],
		])
		const lockMap = new Map<string, Promise<LspClient>>()

		shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)

		expect(idleClient.killMock).toHaveBeenCalledTimes(1)
		expect(activeClient.killMock).not.toHaveBeenCalled()
		expect(clientMap.has("gopls:/idle")).toBe(false)
		expect(clientMap.has("gopls:/active")).toBe(true)
	})

	it("handles an empty map without error", () => {
		const clientMap = new Map<string, LspClient>()
		const lockMap = new Map<string, Promise<LspClient>>()

		expect(() => shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)).not.toThrow()
	})

	it("preserves a client mid-initialize (pending 'initialize' request)", () => {
		// Simulate a client whose initialize request is still in flight.
		// This is the high-stakes scenario: killing mid-initialize orphans
		// a half-started server and wastes the expensive project-load.
		const { client, killMock } = makeFakeClient({
			lastActivity: FIXED_NOW - THRESHOLD - 1,
			pendingRequestsCount: 1,
		})
		// Overwrite the generic hover entry with a realistic initialize entry
		client.pendingRequests.clear()
		client.pendingRequests.set(1, {
			resolve: vi.fn(),
			reject: vi.fn(),
			method: "initialize",
		})
		const clientMap = new Map([["gopls:/project", client]])
		const lockMap = new Map<string, Promise<LspClient>>()

		shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)

		expect(killMock).not.toHaveBeenCalled()
		expect(clientMap.has("gopls:/project")).toBe(true)
	})

	it("does not throw when proc.kill() throws (already-dead process)", () => {
		const { client } = makeFakeClient({ lastActivity: FIXED_NOW - THRESHOLD - 1 })
		// Simulate kill throwing on an already-exited process
		client.proc.kill = () => {
			throw new Error("Process already exited")
		}
		const clientMap = new Map([["gopls:/project", client]])
		const lockMap = new Map<string, Promise<LspClient>>()

		expect(() => shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)).not.toThrow()
		// Client was still removed from the map (deletion happens before kill)
		expect(clientMap.has("gopls:/project")).toBe(false)
	})

	it("continues sweeping remaining clients when one throws during shutdown", () => {
		// First client: stdin.write throws synchronously (simulates sendRequest throw)
		const broken = makeFakeClient({ lastActivity: FIXED_NOW - THRESHOLD - 1 })
		broken.stdinWriteMock.mockImplementation(() => {
			throw new Error("stdin closed")
		})
		// Second client: normal idle client
		const healthy = makeFakeClient({ lastActivity: FIXED_NOW - THRESHOLD - 1 })

		const clientMap = new Map([
			["gopls:/broken", broken.client],
			["gopls:/healthy", healthy.client],
		])
		const lockMap = new Map<string, Promise<LspClient>>()

		expect(() => shutdownIdleClientsIn(clientMap, lockMap, THRESHOLD, FIXED_NOW)).not.toThrow()
		// Both clients removed from map and killed
		expect(clientMap.size).toBe(0)
		expect(broken.killMock).toHaveBeenCalledTimes(1)
		expect(healthy.killMock).toHaveBeenCalledTimes(1)
	})
})
