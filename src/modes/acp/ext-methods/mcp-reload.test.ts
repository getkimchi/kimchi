import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { SessionReloadOutcome } from "pi-mcp-adapter/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	clearReloadHandles,
	registerReloadHandle,
	unregisterReloadHandle,
} from "../../../extensions/mcp/reload-registry.js"
import { handleReloadMcpConfig, validateReloadParams } from "./mcp-reload.js"

function makeConn() {
	return { extNotification: vi.fn().mockResolvedValue(undefined) } as unknown as AgentSideConnection
}

function makeHandle(overrides: Partial<{ outcome: SessionReloadOutcome; reject: Error }> = {}) {
	return {
		reload: vi.fn(async (): Promise<SessionReloadOutcome> => {
			if (overrides.reject) throw overrides.reject
			return (
				overrides.outcome ?? {
					status: "applied",
					added: ["a"],
					removed: ["b"],
					changed: ["c"],
					unchanged: ["d"],
					blocked: [{ name: "e", blockedReason: "project server requires trust" }],
					needsAuth: ["f"],
					serverErrors: [],
				}
			)
		}),
	}
}

function flushNotifications(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
	clearReloadHandles()
	// Clear call history but KEEP mock implementations: the handler schedules
	// notifications via setImmediate, which can fire after the test ends.
	vi.clearAllMocks()
})

describe("validateReloadParams", () => {
	it("accepts empty params and echoes nothing", () => {
		expect(validateReloadParams({})).toEqual({})
	})

	it("accepts a servers array and a string applyToken", () => {
		expect(validateReloadParams({ servers: ["github", "fs"], applyToken: "apply-7" })).toEqual({
			servers: ["github", "fs"],
			applyToken: "apply-7",
		})
	})

	it.each([
		["servers not an array", { servers: "github" }],
		["servers with a non-string entry", { servers: ["github", 42] }],
		["applyToken not a string", { applyToken: 7 }],
	])("rejects %s", (_name, params) => {
		expect(() => validateReloadParams(params as Record<string, unknown>)).toThrow(
			expect.objectContaining({ code: -32602 }),
		)
	})
})

describe("handleReloadMcpConfig", () => {
	it("fans out to every session's handle and echoes the applyToken", async () => {
		const handleOne = makeHandle()
		const handleTwo = makeHandle()
		registerReloadHandle("tok-1", handleOne)
		registerReloadHandle("tok-2", handleTwo)
		const conn = makeConn()

		const result = await handleReloadMcpConfig(
			{
				conn,
				sessions: [
					{ sessionId: "sess-1", turnActive: false, isCompacting: false, reloadToken: "tok-1" },
					{ sessionId: "sess-2", turnActive: false, isCompacting: false, reloadToken: "tok-2" },
				],
			},
			{ applyToken: "apply-7" },
		)

		expect(result.applyToken).toBe("apply-7")
		expect(result.applied).toBe(true)
		expect(result.fallbackReason).toBeNull()
		expect(result.sessions).toHaveLength(2)
		expect(result.sessions[0]).toMatchObject({ sessionId: "sess-1", status: "applied" })
		expect(handleOne.reload).toHaveBeenCalledWith(undefined)
		expect(handleTwo.reload).toHaveBeenCalledWith(undefined)
	})

	it("scopes the diff when servers is supplied", async () => {
		const handle = makeHandle()
		registerReloadHandle("tok-1", handle)
		await handleReloadMcpConfig(
			{
				conn: makeConn(),
				sessions: [{ sessionId: "s", turnActive: false, isCompacting: false, reloadToken: "tok-1" }],
			},
			{ servers: ["github"] },
		)
		expect(handle.reload).toHaveBeenCalledWith({ servers: ["github"] })
	})

	it("reports busy and zero mutations for a mid-turn session, and busy wins the aggregation", async () => {
		const busyHandle = makeHandle()
		const idleHandle = makeHandle()
		registerReloadHandle("tok-busy", busyHandle)
		registerReloadHandle("tok-idle", idleHandle)

		const result = await handleReloadMcpConfig(
			{
				conn: makeConn(),
				sessions: [
					{ sessionId: "sess-busy", turnActive: true, isCompacting: false, reloadToken: "tok-busy" },
					{ sessionId: "sess-idle", turnActive: false, isCompacting: false, reloadToken: "tok-idle" },
				],
			},
			{},
		)

		expect(busyHandle.reload).not.toHaveBeenCalled()
		expect(result.applied).toBe(false)
		expect(result.fallbackReason).toBe("sessions_busy")
		expect(result.sessions.find((s) => s.sessionId === "sess-busy")).toMatchObject({ status: "busy" })
		expect(result.sessions.find((s) => s.sessionId === "sess-idle")).toMatchObject({ status: "applied" })
	})

	it("reports busy for a mid-compaction session (compaction runs outside turn bookkeeping)", async () => {
		const handle = makeHandle()
		registerReloadHandle("tok-1", handle)

		const result = await handleReloadMcpConfig(
			{ conn: makeConn(), sessions: [{ sessionId: "s", turnActive: false, isCompacting: true, reloadToken: "tok-1" }] },
			{},
		)

		expect(handle.reload).not.toHaveBeenCalled()
		expect(result.sessions[0]).toMatchObject({ sessionId: "s", status: "busy" })
		expect(result.fallbackReason).toBe("sessions_busy")
	})

	it("treats a cancelled turn as idle (the turn is no longer active)", async () => {
		const handle = makeHandle()
		registerReloadHandle("tok-1", handle)

		const result = await handleReloadMcpConfig(
			{
				conn: makeConn(),
				sessions: [{ sessionId: "s", turnActive: false, isCompacting: false, reloadToken: "tok-1" }],
			},
			{},
		)

		expect(handle.reload).toHaveBeenCalled()
		expect(result.applied).toBe(true)
	})

	it("reports refused and aggregates direct_tools_frozen", async () => {
		const handle = makeHandle({
			outcome: {
				status: "refused",
				reason: "direct_tools_frozen",
				added: ["x"],
				removed: [],
				changed: [],
				unchanged: [],
				blocked: [],
				needsAuth: [],
				serverErrors: [],
			},
		})
		registerReloadHandle("tok-1", handle)

		const result = await handleReloadMcpConfig(
			{
				conn: makeConn(),
				sessions: [{ sessionId: "s", turnActive: false, isCompacting: false, reloadToken: "tok-1" }],
			},
			{},
		)

		expect(result.applied).toBe(false)
		expect(result.fallbackReason).toBe("direct_tools_frozen")
		expect(result.sessions[0]).toMatchObject({ sessionId: "s", status: "refused" })
		expect(result.sessions[0]?.servers?.added).toEqual(["x"])
	})

	it("aggregates per-session errors with fallbackReason error", async () => {
		const handle = makeHandle({ reject: new Error("re-read exploded") })
		registerReloadHandle("tok-1", handle)

		const result = await handleReloadMcpConfig(
			{
				conn: makeConn(),
				sessions: [{ sessionId: "s", turnActive: false, isCompacting: false, reloadToken: "tok-1" }],
			},
			{},
		)

		expect(result.applied).toBe(false)
		expect(result.fallbackReason).toBe("error")
		expect(result.sessions[0]).toMatchObject({ sessionId: "s", status: "error", error: "re-read exploded" })
	})

	it("reports no_extension for sessions without a handle and no_mcp_extension when none exists", async () => {
		const result = await handleReloadMcpConfig(
			{
				conn: makeConn(),
				sessions: [
					{ sessionId: "s1", turnActive: false, isCompacting: false },
					{ sessionId: "s2", turnActive: false, isCompacting: false, reloadToken: "tok-missing" },
				],
			},
			{},
		)

		expect(result.applied).toBe(false)
		expect(result.fallbackReason).toBe("no_mcp_extension")
		expect(result.sessions.map((s) => s.status)).toEqual(["no_extension", "no_extension"])
	})

	it("emits one applied notification per applied session after the response, with sessionId and token", async () => {
		const handleOne = makeHandle()
		const handleTwo = makeHandle()
		registerReloadHandle("tok-1", handleOne)
		registerReloadHandle("tok-2", handleTwo)
		const conn = makeConn()

		const result = await handleReloadMcpConfig(
			{
				conn,
				sessions: [
					{ sessionId: "sess-1", turnActive: false, isCompacting: false, reloadToken: "tok-1" },
					{ sessionId: "sess-2", turnActive: false, isCompacting: false, reloadToken: "tok-2" },
				],
			},
			{ applyToken: "apply-9" },
		)

		// The result resolves before the notifications fire (setImmediate after
		// the response), and busy/refused/error sessions do not notify.
		expect(conn.extNotification).not.toHaveBeenCalled()
		await flushNotifications()

		expect(conn.extNotification).toHaveBeenCalledTimes(2)
		expect(conn.extNotification).toHaveBeenCalledWith("_kimchi.dev/mcp_config_applied", {
			sessionId: "sess-1",
			applyToken: "apply-9",
			applied: {
				added: ["a"],
				removed: ["b"],
				changed: ["c"],
				unchanged: ["d"],
				blocked: [{ name: "e", blockedReason: "project server requires trust" }],
				needsAuth: ["f"],
			},
		})
		expect(conn.extNotification).toHaveBeenCalledWith("_kimchi.dev/mcp_config_applied", {
			sessionId: "sess-2",
			applyToken: "apply-9",
			applied: expect.objectContaining({ added: ["a"] }),
		})
		expect(result.applied).toBe(true)
	})

	it("does not notify for busy, refused, or error sessions", async () => {
		const busyToken = "tok-busy"
		const refusedToken = "tok-refused"
		const errorToken = "tok-error"
		registerReloadHandle(
			refusedToken,
			makeHandle({
				outcome: {
					status: "refused",
					reason: "direct_tools_frozen",
					added: [],
					removed: [],
					changed: [],
					unchanged: [],
					blocked: [],
					needsAuth: [],
					serverErrors: [],
				},
			}),
		)
		registerReloadHandle(errorToken, makeHandle({ reject: new Error("boom") }))
		const conn = makeConn()

		await handleReloadMcpConfig(
			{
				conn,
				sessions: [
					{ sessionId: "sess-busy", turnActive: true, isCompacting: false, reloadToken: busyToken },
					{ sessionId: "sess-refused", turnActive: false, isCompacting: false, reloadToken: refusedToken },
					{ sessionId: "sess-error", turnActive: false, isCompacting: false, reloadToken: errorToken },
				],
			},
			{ applyToken: "apply-3" },
		)
		await flushNotifications()

		expect(conn.extNotification).not.toHaveBeenCalled()
	})

	it("serializes concurrent calls FIFO with no overlap", async () => {
		let active = 0
		let maxActive = 0
		const gates: Array<() => void> = []
		const handle = {
			reload: vi.fn(async () => {
				active += 1
				maxActive = Math.max(maxActive, active)
				await new Promise<void>((resolve) => gates.push(resolve))
				active -= 1
				return {
					status: "applied",
					added: [],
					removed: [],
					changed: [],
					unchanged: [],
					blocked: [],
					needsAuth: [],
					serverErrors: [],
				} satisfies SessionReloadOutcome
			}),
		}
		registerReloadHandle("tok-1", handle)

		const first = handleReloadMcpConfig(
			{
				conn: makeConn(),
				sessions: [{ sessionId: "s1", turnActive: false, isCompacting: false, reloadToken: "tok-1" }],
			},
			{},
		)
		const second = handleReloadMcpConfig(
			{
				conn: makeConn(),
				sessions: [{ sessionId: "s2", turnActive: false, isCompacting: false, reloadToken: "tok-1" }],
			},
			{},
		)
		// Both queued; release them in order. vi.waitFor lets the FIFO chain's
		// microtask hops flush between releases — a bare await would count the
		// second call before it starts and leave the chain stuck.
		await vi.waitFor(() => expect(handle.reload).toHaveBeenCalledTimes(1))
		gates[0]?.()
		await vi.waitFor(() => expect(handle.reload).toHaveBeenCalledTimes(2))
		gates[1]?.()
		const [firstResult, secondResult] = await Promise.all([first, second])
		expect(firstResult.applied).toBe(true)
		expect(secondResult.applied).toBe(true)
		expect(maxActive).toBe(1)
	})

	it("unregistered handles mid-flight are picked up per call, not cached", async () => {
		const handle = makeHandle()
		registerReloadHandle("tok-1", handle)
		const conn = makeConn()
		const sessions = [{ sessionId: "s", turnActive: false, isCompacting: false, reloadToken: "tok-1" }]

		const first = await handleReloadMcpConfig({ conn, sessions }, {})
		expect(first.applied).toBe(true)

		unregisterReloadHandle("tok-1")
		const second = await handleReloadMcpConfig({ conn, sessions }, {})
		expect(second.fallbackReason).toBe("no_mcp_extension")
		expect(second.sessions[0]).toMatchObject({ status: "no_extension" })
	})
})
