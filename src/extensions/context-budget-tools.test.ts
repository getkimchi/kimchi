import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { createCaptureApi } from "./context-budget-tools.js"

describe("context-budget capture flags", () => {
	it("captures tools enabled by registered defaults in a session without CLI overrides", () => {
		const { api, tools } = createCaptureApi()
		api.registerFlag("enabled", { type: "boolean", default: true })
		api.registerFlag("mode", { type: "string", default: "full" })
		if (api.getFlag("enabled") && api.getFlag("mode") === "full") {
			api.registerTool({
				name: "default_enabled_tool",
				label: "Default enabled tool",
				description: "Tool enabled by extension flag defaults.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			})
		}
		expect([...tools.keys()]).toEqual(["default_enabled_tool"])
	})

	it("preserves false and empty string defaults", () => {
		const { api } = createCaptureApi()
		api.registerFlag("disabled", { type: "boolean", default: false })
		api.registerFlag("empty", { type: "string", default: "" })
		expect(api.getFlag("disabled")).toBe(false)
		expect(api.getFlag("empty")).toBe("")
	})

	it("leaves unknown flags and flags without defaults unset", () => {
		const { api } = createCaptureApi()
		api.registerFlag("unset", { type: "boolean" })
		expect(api.getFlag("unset")).toBeUndefined()
		expect(api.getFlag("unknown")).toBeUndefined()
	})

	it("keeps flag values isolated between capture instances", () => {
		const first = createCaptureApi()
		const second = createCaptureApi()
		first.api.registerFlag("enabled", { type: "boolean", default: true })
		expect(second.api.getFlag("enabled")).toBeUndefined()
		second.api.registerFlag("enabled", { type: "boolean", default: false })
		expect(first.api.getFlag("enabled")).toBe(true)
		expect(second.api.getFlag("enabled")).toBe(false)
	})
})
