import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

import superpowersExtension from "./superpowers.js"

describe("superpowersExtension", () => {
	it("registers without error", () => {
		const onSpy = vi.fn()
		expect(() => superpowersExtension({ on: onSpy } as unknown as ExtensionAPI)).not.toThrow()
	})

	it("registers no event handlers", () => {
		const onSpy = vi.fn()
		superpowersExtension({ on: onSpy } as unknown as ExtensionAPI)
		expect(onSpy).not.toHaveBeenCalled()
	})
})
