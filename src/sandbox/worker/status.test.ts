import { describe, expect, it, vi } from "vitest"
import type { WorkspaceCredentials } from "../cloud/types.js"
import { WorkerClient } from "./client.js"
import { getStatus } from "./status.js"
import type { SandboxStatus } from "./types.js"
import { WorkerError } from "./types.js"

const CREDS: WorkspaceCredentials = {
	wsUrl: "wss://ws-1.remote.kimchi.dev",
	host: "ws-1.remote.kimchi.dev",
	connectToken: "jwt-tok",
	expiresAt: "2026-12-01T00:00:00Z",
}

const BASE = "https://ws-1.remote.kimchi.dev"

describe("getStatus", () => {
	it("returns the SandboxStatus shape verbatim", async () => {
		const fixture: SandboxStatus = {
			sessionStatus: {
				alpha: {
					alive: true,
					agentRunning: false,
					clientConnected: true,
					connectedThroughBridge: true,
					startedAt: "2026-05-30T10:00:00Z",
					finishedAt: null,
					lastActivityAt: "2026-05-30T10:05:00Z",
				},
			},
			lastActivityAt: "2026-05-30T10:05:00Z",
			anyAgentRunning: false,
		}
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(fixture), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		const client = new WorkerClient(CREDS, { fetch: mockFetch })

		const result = await getStatus(client)

		expect(result).toEqual(fixture)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/status`)
		expect(mockFetch.mock.calls[0][1]).toMatchObject({
			method: "GET",
			headers: expect.objectContaining({ Authorization: "Bearer jwt-tok" }),
		})
	})

	it("surfaces 5xx as WorkerError", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }))
		const client = new WorkerClient(CREDS, { fetch: mockFetch })
		await expect(getStatus(client)).rejects.toBeInstanceOf(WorkerError)
	})
})
