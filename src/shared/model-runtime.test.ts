import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { requireModelRuntime } from "./model-runtime.js"

describe("requireModelRuntime", () => {
	it("returns the registry's private runtime", () => {
		const runtime = { id: "runtime" }
		const registry = { runtime } as unknown as ModelRegistry

		expect(requireModelRuntime(registry)).toBe(runtime)
	})
})

describe("requireModelRuntime errors", () => {
	it("throws when the registry has no runtime", () => {
		expect(() => requireModelRuntime({} as unknown as ModelRegistry)).toThrow(
			"Pi model registry runtime is unavailable",
		)
	})
})
