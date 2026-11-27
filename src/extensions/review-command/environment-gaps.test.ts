import { describe, expect, it } from "vitest"
import { headlessEnvironmentGaps } from "./environment-gaps.js"

describe("headless environment gaps", () => {
	it("reports configured sandbox limitations without leaking proxy values", () => {
		expect(
			headlessEnvironmentGaps({
				GOTOOLCHAIN: "local",
				CARGO_NET_OFFLINE: "true",
				GOPROXY: "off",
			}),
		).toEqual([
			expect.objectContaining({ kind: "unsupported_toolchain_download", name: "Go toolchain downloads" }),
			expect.objectContaining({ kind: "registry_offline", name: "Cargo registry access" }),
			expect.objectContaining({
				kind: "constrained_module_proxy",
				name: "Go module retrieval",
				note: expect.stringContaining("GOPROXY=off"),
			}),
		])
	})

	it("reports nothing when the sandbox does not impose these settings", () => {
		expect(headlessEnvironmentGaps({})).toEqual([])
	})
})
