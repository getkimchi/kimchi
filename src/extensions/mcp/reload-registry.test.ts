import type { SessionReloadOutcome } from "pi-mcp-adapter/types"
import { afterEach, describe, expect, it } from "vitest"
import { clearReloadHandles, getReloadHandle, registerReloadHandle, unregisterReloadHandle } from "./reload-registry.js"

function stubHandle(name: string) {
	return {
		reload: async (): Promise<SessionReloadOutcome> => ({
			status: "applied",
			added: [],
			removed: [],
			changed: [],
			unchanged: [name],
			blocked: [],
			needsAuth: [],
			serverErrors: [],
		}),
	}
}

describe("MCP reload-handle registry", () => {
	afterEach(() => {
		clearReloadHandles()
	})

	it("registers, gets, and unregisters handles by token", () => {
		const handle = stubHandle("a")
		expect(getReloadHandle("token-1")).toBeUndefined()
		registerReloadHandle("token-1", handle)
		expect(getReloadHandle("token-1")).toBe(handle)
		unregisterReloadHandle("token-1")
		expect(getReloadHandle("token-1")).toBeUndefined()
	})

	it("replaces the handle on re-registration (session replacement re-registers the new state)", () => {
		const first = stubHandle("a")
		const second = stubHandle("b")
		registerReloadHandle("token-1", first)
		registerReloadHandle("token-1", second)
		expect(getReloadHandle("token-1")).toBe(second)
	})

	it("keeps tokens independent", () => {
		const handleA = stubHandle("a")
		const handleB = stubHandle("b")
		registerReloadHandle("token-a", handleA)
		registerReloadHandle("token-b", handleB)
		expect(getReloadHandle("token-a")).toBe(handleA)
		expect(getReloadHandle("token-b")).toBe(handleB)
		unregisterReloadHandle("token-a")
		expect(getReloadHandle("token-a")).toBeUndefined()
		expect(getReloadHandle("token-b")).toBe(handleB)
	})

	it("unregister of an unknown token is a no-op", () => {
		expect(() => unregisterReloadHandle("never-registered")).not.toThrow()
	})
})
