import { describe, expect, it } from "vitest"
import { RemoteNetworkError } from "./types.js"
import { normalizeWsUri } from "./uri.js"

describe("normalizeWsUri", () => {
	it("adds wss:// scheme to a bare hostname and defaults port to 443", () => {
		expect(normalizeWsUri("h.example.com")).toEqual({
			wsUrl: "wss://h.example.com",
			host: "h.example.com",
			port: 443,
		})
	})

	it("preserves a non-default port", () => {
		expect(normalizeWsUri("wss://h.example.com:9443")).toEqual({
			wsUrl: "wss://h.example.com:9443",
			host: "h.example.com",
			port: 9443,
		})
	})

	it("strips :443 from a fully qualified wss URI", () => {
		expect(normalizeWsUri("wss://h.example.com:443")).toEqual({
			wsUrl: "wss://h.example.com",
			host: "h.example.com",
			port: 443,
		})
	})

	it("strips :80 from a fully qualified ws URI", () => {
		expect(normalizeWsUri("ws://h.example.com:80")).toEqual({
			wsUrl: "ws://h.example.com",
			host: "h.example.com",
			port: 80,
		})
	})

	it("preserves a non-root path", () => {
		const result = normalizeWsUri("wss://h.example.com/connect")
		expect(result.wsUrl).toBe("wss://h.example.com/connect")
		expect(result.host).toBe("h.example.com")
	})

	it("rejects an http(s) URI with RemoteNetworkError", () => {
		expect(() => normalizeWsUri("https://h.example.com")).toThrow(RemoteNetworkError)
	})

	it("rejects a totally invalid URI with RemoteNetworkError", () => {
		expect(() => normalizeWsUri("wss://")).toThrow(RemoteNetworkError)
	})
})
