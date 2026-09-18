import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createMiniEventBus } from "../../extensions/__mocks__/mini-event-bus.js"
import { getToolSessionScope } from "./tool-session-scope.js"

describe("getToolSessionScope", () => {
	it("shares an identity across extension APIs on the same event bus", () => {
		const { events } = createMiniEventBus()
		const first = { events } as unknown as ExtensionAPI
		const second = { events } as unknown as ExtensionAPI

		expect(getToolSessionScope(second)).toBe(getToolSessionScope(first))
	})

	it("does not share identities across sessions", () => {
		const first = { events: createMiniEventBus().events } as unknown as ExtensionAPI
		const second = { events: createMiniEventBus().events } as unknown as ExtensionAPI

		expect(getToolSessionScope(second)).not.toBe(getToolSessionScope(first))
	})
})
