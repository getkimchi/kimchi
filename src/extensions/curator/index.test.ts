import { describe, expect, it } from "vitest"
import curatorExtension from "./index.js"

describe("curatorExtension", () => {
	it("is a function", () => {
		expect(typeof curatorExtension).toBe("function")
	})

	it("returns a Promise", async () => {
		const result = curatorExtension({} as unknown as Parameters<typeof curatorExtension>[0])
		expect(result).toBeInstanceOf(Promise)
		await result
	})

	it("resolves without error when called", async () => {
		// No-op extension - should resolve regardless of input
		const pi = {
			on: () => {},
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => {},
			sendMessage: () => {},
			getcwd: () => "/tmp",
		} as unknown as Parameters<typeof curatorExtension>[0]

		await expect(curatorExtension(pi)).resolves.toBeUndefined()
	})
})
