// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { EnvHttpProxyAgent, getGlobalDispatcher } from "undici"
import { afterEach, describe, expect, it, vi } from "vitest"

describe("installProxyAgent", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("installs EnvHttpProxyAgent when KIMCHI_PROXY is set", async () => {
		vi.stubEnv("KIMCHI_PROXY", "http://localhost:8080")

		const { installProxyAgent } = await import("./proxy.js")
		installProxyAgent()

		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
	})

	it("installs EnvHttpProxyAgent when HTTP_PROXY is set", async () => {
		vi.stubEnv("HTTP_PROXY", "http://proxy.local:3128")

		const { installProxyAgent } = await import("./proxy.js")
		installProxyAgent()

		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
	})

	it("prefers KIMCHI_PROXY over HTTP_PROXY", async () => {
		vi.stubEnv("KIMCHI_PROXY", "http://kimchi-proxy:9090")
		vi.stubEnv("HTTP_PROXY", "http://wrong-proxy:3128")

		const { installProxyAgent } = await import("./proxy.js")
		installProxyAgent()

		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
