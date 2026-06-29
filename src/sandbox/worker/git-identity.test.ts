import { describe, expect, it, vi } from "vitest"
import type { WorkspaceCredentials } from "../cloud/types.js"
import { WorkerClient } from "./client.js"
import { setGitGlobalConfig, upsertGitIdentity } from "./git-identity.js"
import type { GitIdentity } from "./types.js"
import { WorkerError } from "./types.js"

const CREDS: WorkspaceCredentials = {
	wsUrl: "wss://ws-1.remote.kimchi.dev",
	host: "ws-1.remote.kimchi.dev",
	connectToken: "jwt-tok",
	expiresAt: "2026-12-01T00:00:00Z",
}

const BASE = "https://ws-1.remote.kimchi.dev"

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const IDENTITY: GitIdentity = { host: "github.com", user: "oauth2", secretRef: "git-token-github-com" }

describe("setGitGlobalConfig", () => {
	it("PUTs /gitidentity with the user name/email", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await setGitGlobalConfig(client, { name: "Alice", email: "a@example.com" })

		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/gitidentity`)
		const init = mockFetch.mock.calls[0][1] as RequestInit
		expect(init.method).toBe("PUT")
		expect(JSON.parse(init.body as string)).toEqual({ user: { name: "Alice", email: "a@example.com" } })
	})

	it("omits unset fields", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await setGitGlobalConfig(client, { name: "Alice" })

		expect(JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
			user: { name: "Alice" },
		})
	})

	it("is a no-op when both are empty", async () => {
		const mockFetch = vi.fn()
		const client = new WorkerClient(CREDS, { fetch: mockFetch })
		await setGitGlobalConfig(client, {})
		expect(mockFetch).not.toHaveBeenCalled()
	})
})

describe("upsertGitIdentity", () => {
	it("POSTs to create when the identity does not exist", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse(IDENTITY, 200))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		const result = await upsertGitIdentity(client, "github.com", {
			user: "oauth2",
			secretRef: "git-token-github-com",
		})

		expect(result).toEqual(IDENTITY)
		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/gitidentity/github.com`)
		expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe("POST")
	})

	it("falls back to PUT (update) on a 409 conflict", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ message: "exists" }, 409))
			.mockResolvedValueOnce(jsonResponse(IDENTITY, 200))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		const result = await upsertGitIdentity(client, "github.com", {
			user: "oauth2",
			secretRef: "git-token-github-com",
		})

		expect(result).toEqual(IDENTITY)
		expect(mockFetch).toHaveBeenCalledTimes(2)
		expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe("POST")
		expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe("PUT")
		expect(mockFetch.mock.calls[1][0]).toBe(`${BASE}/gitidentity/github.com`)
	})

	it("rethrows non-409 errors without retrying", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, 500))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await expect(
			upsertGitIdentity(client, "github.com", { user: "oauth2", secretRef: "git-token-github-com" }),
		).rejects.toBeInstanceOf(WorkerError)
		expect(mockFetch).toHaveBeenCalledTimes(1)
	})
})
