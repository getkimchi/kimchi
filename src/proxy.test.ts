import { EnvHttpProxyAgent, getGlobalDispatcher } from "undici"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	installProxyAgent,
	resolveStreamIdleTimeoutMs,
	STREAM_IDLE_TIMEOUT_MS_ENV,
} from "./proxy.js"

describe("installProxyAgent", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("installs EnvHttpProxyAgent when KIMCHI_PROXY is set", () => {
		vi.stubEnv("KIMCHI_PROXY", "http://localhost:8080")

		installProxyAgent()

		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
	})

	it("installs EnvHttpProxyAgent when HTTP_PROXY is set", () => {
		vi.stubEnv("HTTP_PROXY", "http://proxy.local:3128")

		installProxyAgent()

		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
	})

	it("prefers KIMCHI_PROXY over HTTP_PROXY", () => {
		vi.stubEnv("KIMCHI_PROXY", "http://kimchi-proxy:9090")
		vi.stubEnv("HTTP_PROXY", "http://wrong-proxy:3128")

		installProxyAgent()

		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
	})
})

describe("resolveStreamIdleTimeoutMs", () => {
	it("returns the default (180000) when the env var is unset", () => {
		expect(resolveStreamIdleTimeoutMs({})).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
	})

	it("returns 0 (disabled) when the env var is explicitly '0'", () => {
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_MS_ENV]: "0" })).toBe(0)
	})

	it("returns the default for empty, non-numeric, or negative values", () => {
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_MS_ENV]: "" })).toBe(
			DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_MS_ENV]: "banana" })).toBe(
			DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_MS_ENV]: "-1" })).toBe(
			DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		)
	})

	it("returns the parsed positive value when set", () => {
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_MS_ENV]: "180000" })).toBe(180000)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_MS_ENV]: "60000" })).toBe(60000)
	})

	it("exposes the documented default constant", () => {
		expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(180000)
	})
})
