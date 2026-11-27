import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import fermentV2Extension from "../ferment-v2/index.js"
import { registerFermentCommands } from "./commands.js"

function registeredNames(api: ReturnType<typeof createExtensionApi>): string[] {
	return api.registerCommand.mock.calls.map((call) => call[0])
}

describe("Ferment command names", () => {
	it("registers V2 as /ferment and never as /ferment-v2", () => {
		const api = createExtensionApi()
		fermentV2Extension(api.api)
		expect(registeredNames(api)).toContain("ferment")
		expect(registeredNames(api)).not.toContain("ferment-v2")
	})

	it("registers V1 as /ferment-legacy and not /ferment", () => {
		const api = createExtensionApi()
		registerFermentCommands(api.api)
		expect(registeredNames(api)).toEqual(["ferment-legacy"])
		expect(api.getRegisteredCommand("ferment-legacy").description).toBe(
			'Legacy Ferment (V1): /ferment-legacy list, /ferment-legacy new "Name", /ferment-legacy switch <id>',
		)
	})

	it("leaves exactly one /ferment registration, owned by V2, when both load", () => {
		const api = createExtensionApi()
		registerFermentCommands(api.api)
		fermentV2Extension(api.api)
		const names = registeredNames(api)
		expect(names.filter((name) => name === "ferment")).toHaveLength(1)
		expect(names).toContain("ferment-legacy")
		expect(api.getRegisteredCommand("ferment").description).not.toContain("Legacy")
		expect(api.getRegisteredCommand("ferment-legacy").description).toContain("Legacy Ferment (V1)")
	})
})
