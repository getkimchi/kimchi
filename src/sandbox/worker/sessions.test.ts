import { describe, expect, it, vi } from "vitest"
import type { WorkspaceCredentials } from "../cloud/types.js"
import { WorkerClient } from "./client.js"
import { createSession, deleteSession, getSession, listSessions } from "./sessions.js"
import type { CreateSessionRequest } from "./types.js"
import { WorkerError } from "./types.js"

const CREDS: WorkspaceCredentials = {
	wsUrl: "wss://ws-1.remote.kimchi.dev",
	host: "ws-1.remote.kimchi.dev",
	connectToken: "jwt-tok",
	expiresAt: "2026-12-01T00:00:00Z",
}

const BASE = "https://ws-1.remote.kimchi.dev"

function sessionFixture(overrides: Record<string, unknown> = {}) {
	return {
		agentMode: "PTY" as const,
		alive: true,
		agentRunning: false,
		clientConnected: false,
		connectedThroughBridge: true,
		startedAt: "2026-05-30T10:00:00Z",
		finishedAt: null,
		lastActivityAt: "2026-05-30T10:05:00Z",
		...overrides,
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	})
}

describe("listSessions", () => {
	it("flattens the map into an array with name lifted from the key", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			jsonResponse({
				alpha: sessionFixture({ agentMode: "PTY" }),
				beta: sessionFixture({ agentMode: "RPC", alive: false }),
			}),
		)
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		const result = await listSessions(client)

		expect(result).toHaveLength(2)
		expect(result.map((s) => s.name).sort()).toEqual(["alpha", "beta"])
		const alpha = result.find((s) => s.name === "alpha")
		expect(alpha).toMatchObject({ name: "alpha", agentMode: "PTY", alive: true })
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/session`)
	})

	it("returns an empty array when the worker has no sessions", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({}))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })
		expect(await listSessions(client)).toEqual([])
	})

	it("round-trips through getSession with equivalent fields", async () => {
		const fixture = sessionFixture({ agentMode: "PTY", cwd: "/workspace" })
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ foo: fixture }))
			.mockResolvedValueOnce(jsonResponse(fixture))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		const list = await listSessions(client)
		const got = await getSession(client, "foo")

		expect(list[0]).toEqual(got)
	})
})

describe("getSession", () => {
	it("hits /session/{name} and embeds the name", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse(sessionFixture()))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		const result = await getSession(client, "foo")

		expect(result.name).toBe("foo")
		expect(result.agentMode).toBe("PTY")
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/session/foo`)
	})

	it("URL-encodes the session name", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse(sessionFixture()))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })
		await getSession(client, "a b/c")
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/session/a%20b%2Fc`)
	})

	it("surfaces 404 as WorkerError with status preserved", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ message: "not found" }, 404))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })
		await expect(getSession(client, "missing")).rejects.toMatchObject({
			name: "WorkerError",
			status: 404,
		})
		await expect(getSession(client, "missing")).rejects.toBeInstanceOf(WorkerError)
	})
})

describe("createSession", () => {
	it("POSTs the CreateSessionRequest body verbatim with agentMode: PTY", async () => {
		const fixture = sessionFixture({ agentMode: "PTY", cwd: "/x" })
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse(fixture, 201))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		const req: CreateSessionRequest = {
			agentMode: "PTY",
			cwd: "/x",
			yolo: true,
			details: { git: { repo: "https://github.com/x/y", branch: "main" } },
		}
		const result = await createSession(client, "foo", req)

		expect(result.name).toBe("foo")
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/session/foo`)
		const init = mockFetch.mock.calls[0][1] as RequestInit
		expect(init.method).toBe("POST")
		expect(JSON.parse(init.body as string)).toEqual(req)
	})

	it("supports agentMode RPC and ACP", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(sessionFixture({ agentMode: "RPC" }), 201))
			.mockResolvedValueOnce(jsonResponse(sessionFixture({ agentMode: "ACP" }), 201))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await createSession(client, "r", { agentMode: "RPC" })
		await createSession(client, "a", { agentMode: "ACP" })

		expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual({ agentMode: "RPC" })
		expect(JSON.parse(mockFetch.mock.calls[1][1].body as string)).toEqual({ agentMode: "ACP" })
	})

	it("propagates 409 as WorkerError with status preserved", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ message: "exists" }, 409))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })
		await expect(createSession(client, "foo", { agentMode: "PTY" })).rejects.toMatchObject({
			name: "WorkerError",
			status: 409,
		})
	})
})

describe("deleteSession", () => {
	it("DELETEs /session/{name}", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await deleteSession(client, "foo")

		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/session/foo`)
		expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: "DELETE" })
	})

	it("surfaces 404 as WorkerError", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })
		await expect(deleteSession(client, "foo")).rejects.toBeInstanceOf(WorkerError)
	})
})
