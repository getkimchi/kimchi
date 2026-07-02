import { describe, expect, it, vi } from "vitest"
import type { WorkspaceCredentials } from "../cloud/types.js"
import { WorkerClient } from "./client.js"
import { deleteSecret, putSecret } from "./secrets.js"
import { WorkerError } from "./types.js"

const CREDS: WorkspaceCredentials = {
	wsUrl: "wss://ws-1.remote.kimchi.dev",
	host: "ws-1.remote.kimchi.dev",
	connectToken: "jwt-tok",
	expiresAt: "2026-12-01T00:00:00Z",
}

const BASE = "https://ws-1.remote.kimchi.dev"

describe("putSecret", () => {
	it("PUTs /secrets with a base64-encoded value", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await putSecret(client, { name: "git-token-github-com", value: "ghp_secret" })

		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/secrets`)
		const init = mockFetch.mock.calls[0][1] as RequestInit
		expect(init.method).toBe("PUT")
		const body = JSON.parse(init.body as string)
		expect(body.name).toBe("git-token-github-com")
		expect(body.value).toBe(Buffer.from("ghp_secret", "utf-8").toString("base64"))
		expect(body).not.toHaveProperty("injectIntoEnv")
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-tok")
	})

	it("includes injectIntoEnv when set", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await putSecret(client, { name: "s", value: "v", injectIntoEnv: true })

		const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
		expect(body.injectIntoEnv).toBe(true)
	})

	it("surfaces non-2xx as WorkerError", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response("bad name", { status: 400 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })
		await expect(putSecret(client, { name: "bad name", value: "v" })).rejects.toBeInstanceOf(WorkerError)
	})
})

describe("deleteSecret", () => {
	it("DELETEs /secrets/{name} URL-encoded", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		await deleteSecret(client, "git-token-github-com")

		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/secrets/git-token-github-com`)
		expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: "DELETE" })
	})
})
