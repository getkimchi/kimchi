import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { disableFermentTools, enableFermentTools } from "./tool-scope.js"

function createPi(activeTools: string[], allTools: string[]) {
	return {
		getActiveTools: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => allTools.map((name) => ({ name }))),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
}

describe("ferment tool scope", () => {
	it("removes ferment tools from the active set", () => {
		const pi = createPi(
			["read", "create_ferment", "bash", "start_step"],
			["read", "bash", "create_ferment", "start_step"],
		)

		disableFermentTools(pi)

		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"])
	})

	it("enables registered ferment tools without duplicating active tools", () => {
		const pi = createPi(["read", "create_ferment", "bash"], ["read", "bash", "create_ferment", "start_step"])

		enableFermentTools(pi)

		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "create_ferment", "start_step"])
	})
})
