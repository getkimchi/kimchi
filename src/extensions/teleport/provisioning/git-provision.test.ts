import { describe, expect, it, vi } from "vitest"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { gitTokenSecretName, provisionGitCredential, provisionGitIdentity } from "./git-provision.js"

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

describe("gitTokenSecretName", () => {
	it("sanitizes characters not allowed in secret names", () => {
		expect(gitTokenSecretName("github.com")).toBe("git-token-github_com")
		expect(gitTokenSecretName("gitlab.example.co.uk")).toBe("git-token-gitlab_example_co_uk")
		expect(gitTokenSecretName("bitbucket.org")).toBe("git-token-bitbucket_org")
	})
})

describe("provisionGitIdentity", () => {
	it("sets the global git config", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await provisionGitIdentity(client, { name: "Alice", email: "a@example.com" })

		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/gitidentity`)
		expect(JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
			user: { name: "Alice", email: "a@example.com" },
		})
	})
})

describe("provisionGitCredential", () => {
	it("writes the secret before binding the git identity", async () => {
		const seen: Array<{ url: string; method: string }> = []
		const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
			seen.push({ url, method: init.method ?? "GET" })
			if (url.endsWith("/secrets")) return Promise.resolve(new Response(null, { status: 204 }))
			return Promise.resolve(jsonResponse({ host: "github.com", user: "oauth2", secretRef: "git-token-github_com" }))
		})
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await provisionGitCredential(client, { gitHost: "github.com", gitToken: "ghp_x" })

		expect(seen[0]).toEqual({ url: `${BASE}/secrets`, method: "PUT" })
		expect(seen[1]).toEqual({ url: `${BASE}/gitidentity/github.com`, method: "POST" })

		const secretBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
		expect(secretBody.name).toBe("git-token-github_com")
		expect(secretBody.value).toBe(Buffer.from("ghp_x", "utf-8").toString("base64"))

		const identityBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string)
		expect(identityBody).toEqual({ user: "oauth2", secretRef: "git-token-github_com" })
	})

	it("honors a custom git user", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(jsonResponse({ host: "github.com", user: "alice", secretRef: "git-token-github_com" }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await provisionGitCredential(client, { gitHost: "github.com", gitToken: "ghp_x", gitUser: "alice" })

		const identityBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string)
		expect(identityBody.user).toBe("alice")
	})
})
