import { afterEach, describe, expect, it } from "vitest"
import type { SideChatAcpBridge } from "./acp-bridge.js"
import { getSideChatBridge, registerSideChatBridge, resetSideChatBridges } from "./registry.js"

const fakeBridge = (id: string) => ({ id }) as unknown as SideChatAcpBridge

describe("side chat ACP registry", () => {
	afterEach(() => {
		resetSideChatBridges()
	})

	it("registers and looks up a bridge by session id", () => {
		const bridge = fakeBridge("a")
		registerSideChatBridge("session-1", bridge)

		expect(getSideChatBridge("session-1")).toBe(bridge)
		expect(getSideChatBridge("session-2")).toBeUndefined()
	})

	it("unregisters only the bridge it returned the handle for", () => {
		const first = fakeBridge("a")
		const second = fakeBridge("b")
		const removeFirst = registerSideChatBridge("session-1", first)
		registerSideChatBridge("session-1", second)

		// Stale handle (from an already-replaced registration) must not remove the live bridge.
		removeFirst()
		expect(getSideChatBridge("session-1")).toBe(second)
	})

	it("removes the live bridge when its handle runs", () => {
		registerSideChatBridge("session-1", fakeBridge("a"))
		const remove = registerSideChatBridge("session-1", fakeBridge("b"))

		remove()
		expect(getSideChatBridge("session-1")).toBeUndefined()
	})

	it("keeps sessions isolated", () => {
		const first = fakeBridge("a")
		const second = fakeBridge("b")
		registerSideChatBridge("session-1", first)
		registerSideChatBridge("session-2", second)

		expect(getSideChatBridge("session-1")).toBe(first)
		expect(getSideChatBridge("session-2")).toBe(second)
	})
})
