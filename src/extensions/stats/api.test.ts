import { describe, expect, it, vi } from "vitest"
import { CastAiStatsApi } from "./api.js"

const calls = vi.hoisted(() => [] as Array<{ url: string; headers: Headers }>)

vi.mock("../../utils/http.js", () => ({
	fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, headers: new Headers(init?.headers) })
		return { ok: true, json: async () => ({}) }
	}),
}))

vi.mock("../../config.js", () => ({
	resolveEndpoints: () => ({ castApiUrl: "https://api.test" }),
}))

function lastCall(): { url: string; headers: Headers } {
	const call = calls.at(-1)
	if (!call) throw new Error("no request was made")
	return call
}

describe("CastAiStatsApi", () => {
	it("sends the SSO organization header when the credential carries one", async () => {
		const api = new CastAiStatsApi({ apiKey: "oauth-token", organizationId: "org-7" })
		await api.generateAnalytics(new Date("2026-01-01"), new Date("2026-01-02"))
		const { headers } = lastCall()
		expect(headers.get("authorization")).toBe("Bearer oauth-token")
		expect(headers.get("x-castai-organization-id")).toBe("org-7")
	})

	it("omits the organization header for API-key credentials", async () => {
		const api = new CastAiStatsApi({ apiKey: "castai_v1_key" })
		await api.generateAnalytics(new Date("2026-01-01"), new Date("2026-01-02"))
		const { headers } = lastCall()
		expect(headers.get("authorization")).toBe("Bearer castai_v1_key")
		expect(headers.get("x-castai-organization-id")).toBeNull()
	})
})
