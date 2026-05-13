import { EnvHttpProxyAgent, getGlobalDispatcher } from "undici"
import { describe, expect, it } from "vitest"

describe("installProxyAgent", () => {
	it("installs EnvHttpProxyAgent when KIMCHI_PROXY is set", async () => {
		process.env.KIMCHI_PROXY = "http://localhost:8080"
		process.env.HTTP_PROXY = undefined
		process.env.HTTPS_PROXY = undefined
		process.env.NO_PROXY = undefined

		const { installProxyAgent } = await import("./proxy.js")
		installProxyAgent()

		const dispatcher = getGlobalDispatcher()
		expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent)
	})

	it("installs EnvHttpProxyAgent when HTTP_PROXY is set", async () => {
		process.env.HTTP_PROXY = "http://proxy.local:3128"
		process.env.KIMCHI_PROXY = undefined
		process.env.HTTPS_PROXY = undefined
		process.env.NO_PROXY = undefined

		const { installProxyAgent } = await import("./proxy.js")
		installProxyAgent()

		const dispatcher = getGlobalDispatcher()
		expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent)
	})

	it("prefers KIMCHI_PROXY over HTTP_PROXY", async () => {
		process.env.KIMCHI_PROXY = "http://kimchi-proxy:9090"
		process.env.HTTP_PROXY = "http://wrong-proxy:3128"
		process.env.HTTPS_PROXY = undefined
		process.env.NO_PROXY = undefined

		const { installProxyAgent } = await import("./proxy.js")
		installProxyAgent()

		const dispatcher = getGlobalDispatcher()
		expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent)
	})
})
