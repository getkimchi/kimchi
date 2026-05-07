import { describe, expect, it } from "vitest"
import { registerCuratorExtension } from "./index.js"

describe("registerCuratorExtension", () => {
	it("is a function", () => {
		expect(typeof registerCuratorExtension).toBe("function")
	})

	it("returns an Extension object", () => {
		const result = registerCuratorExtension()
		expect(result).toBeDefined()
		expect(typeof result).toBe("object")
		expect(result).not.toBeInstanceOf(Promise)
	})

	it("Extension.path is 'curator'", () => {
		const result = registerCuratorExtension()
		expect(result.path).toBe("curator")
	})

	it("Extension.tools is empty", () => {
		const result = registerCuratorExtension()
		expect(result.tools).toBeDefined()
		expect(result.tools.size).toBe(0)
	})
})
