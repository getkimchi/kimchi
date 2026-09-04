import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetAuthEntry = vi.fn()

vi.mock("./mcp-auth.js", () => ({
	getAuthEntry: (...args: unknown[]) => mockGetAuthEntry(...args),
}))

import { resolveProbeName } from "./resolve-probe-name.js"

const URL_SERVER = { url: "https://example.com/mcp" }

beforeEach(() => {
	vi.clearAllMocks()
})

describe("resolveProbeName", () => {
	it("uses the real name when no auth entry exists (new server)", () => {
		mockGetAuthEntry.mockReturnValue(undefined)

		expect(resolveProbeName("my-server", URL_SERVER)).toBe("my-server")
		expect(mockGetAuthEntry).toHaveBeenCalledWith("my-server")
	})

	it("uses the real name when the entry is residue from an incomplete OAuth flow (no serverUrl)", () => {
		// Only oauthState/codeVerifier were saved — no tokens, no serverUrl.
		// The real name must be reused so the flow can complete and save
		// tokens to the correct entry.
		mockGetAuthEntry.mockReturnValue({ oauthState: "state-123", codeVerifier: "verifier-456" })

		expect(resolveProbeName("my-server", URL_SERVER)).toBe("my-server")
	})

	it("uses the real name when the stored URL matches (repeat probe)", () => {
		mockGetAuthEntry.mockReturnValue({ serverUrl: URL_SERVER.url, tokens: { accessToken: "tok" } })

		expect(resolveProbeName("my-server", URL_SERVER)).toBe("my-server")
	})

	it("uses a throwaway name when the stored URL differs (server URL edited)", () => {
		mockGetAuthEntry.mockReturnValue({ serverUrl: "https://old.example.com/mcp" })

		const probeName = resolveProbeName("my-server", URL_SERVER)

		expect(probeName).toMatch(/^__probe_[0-9a-f-]{36}$/)
		expect(probeName).not.toBe("my-server")
	})
})
