import { describe, expect, it, vi } from "vitest"
import type { WorkspaceCredentials } from "../cloud/types.js"
import { WorkerClient, deriveBaseUrl } from "./client.js"
import { WorkerError } from "./types.js"

function creds(overrides: Partial<WorkspaceCredentials> = {}): WorkspaceCredentials {
	return {
		wsUrl: "wss://ws-1.remote.kimchi.dev",
		host: "ws-1.remote.kimchi.dev",
		connectToken: "jwt-tok",
		expiresAt: "2026-12-01T00:00:00Z",
		...overrides,
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	})
}

describe("deriveBaseUrl", () => {
	it("converts wss:// → https://", () => {
		expect(deriveBaseUrl("wss://ws-1.remote.kimchi.dev")).toBe("https://ws-1.remote.kimchi.dev")
	})
	it("converts ws:// → http:// preserving port", () => {
		expect(deriveBaseUrl("ws://localhost:8080")).toBe("http://localhost:8080")
	})
	it("preserves a port on wss://", () => {
		expect(deriveBaseUrl("wss://ws-1.example.com:9443")).toBe("https://ws-1.example.com:9443")
	})
	it("strips trailing slashes", () => {
		expect(deriveBaseUrl("wss://ws-1.example.com/")).toBe("https://ws-1.example.com")
	})
	it("passes through https:// untouched", () => {
		expect(deriveBaseUrl("https://ws-1.example.com")).toBe("https://ws-1.example.com")
	})
	it("rejects unexpected schemes", () => {
		expect(() => deriveBaseUrl("ftp://x")).toThrow(WorkerError)
	})
})

describe("WorkerClient", () => {
	it("derives baseUrl from wsUrl", () => {
		const client = new WorkerClient(creds({ wsUrl: "wss://host.example.com:9443/" }))
		expect(client.baseUrl).toBe("https://host.example.com:9443")
	})

	it("attaches Bearer token to GET", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
		const client = new WorkerClient(creds({ connectToken: "tok-abc" }), { fetch: mockFetch })

		const result = await client.get<{ ok: boolean }>("/status")

		expect(result).toEqual({ ok: true })
		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(mockFetch.mock.calls[0][0]).toBe("https://ws-1.remote.kimchi.dev/status")
		expect(mockFetch.mock.calls[0][1]).toMatchObject({
			method: "GET",
			headers: expect.objectContaining({
				Authorization: "Bearer tok-abc",
				Accept: "application/json",
			}),
		})
	})

	it("attaches Bearer + JSON body to POST", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ created: true }, 201))
		const client = new WorkerClient(creds({ connectToken: "tok-xyz" }), { fetch: mockFetch })

		const result = await client.post<{ created: boolean }>("/session/foo", { agentMode: "PTY" })

		expect(result).toEqual({ created: true })
		const [, init] = mockFetch.mock.calls[0]
		expect(init).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				Authorization: "Bearer tok-xyz",
				"Content-Type": "application/json",
			}),
		})
		expect(JSON.parse(init.body as string)).toEqual({ agentMode: "PTY" })
	})

	it("attaches Bearer to DELETE and returns void", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
		const client = new WorkerClient(creds(), { fetch: mockFetch })

		await expect(client.del("/session/foo")).resolves.toBeUndefined()
		expect(mockFetch.mock.calls[0][1]).toMatchObject({
			method: "DELETE",
			headers: expect.objectContaining({ Authorization: "Bearer jwt-tok" }),
		})
	})

	it("prefixes paths missing a leading slash", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({}))
		const client = new WorkerClient(creds(), { fetch: mockFetch })
		await client.get("status")
		expect(mockFetch.mock.calls[0][0]).toBe("https://ws-1.remote.kimchi.dev/status")
	})

	it("throws WorkerError with status + parsed JSON body on 4xx", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ message: "session not found" }, 404))
		const client = new WorkerClient(creds(), { fetch: mockFetch })

		await expect(client.get("/session/missing")).rejects.toMatchObject({
			name: "WorkerError",
			status: 404,
			body: { message: "session not found" },
		})
	})

	it("throws WorkerError with text body on non-JSON 5xx", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			new Response("kaboom", {
				status: 500,
				headers: { "Content-Type": "text/plain" },
			}),
		)
		const client = new WorkerClient(creds(), { fetch: mockFetch })

		await expect(client.get("/status")).rejects.toMatchObject({
			name: "WorkerError",
			status: 500,
			body: "kaboom",
		})
	})

	it("propagates an external AbortSignal", async () => {
		const ctrl = new AbortController()
		const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
			expect(init.signal).toBeInstanceOf(AbortSignal)
			ctrl.abort()
			if (init.signal?.aborted) {
				throw new DOMException("Aborted", "AbortError")
			}
			return jsonResponse({})
		})
		const client = new WorkerClient(creds(), { fetch: mockFetch })

		await expect(client.get("/status", ctrl.signal)).rejects.toThrow()
	})

	it("times out via timeoutMs (signal becomes aborted)", async () => {
		const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
			})
		})
		const client = new WorkerClient(creds(), { fetch: mockFetch, timeoutMs: 5 })

		await expect(client.get("/status")).rejects.toThrow()
	})
})
