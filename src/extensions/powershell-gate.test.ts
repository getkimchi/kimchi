// extensions/powershell-gate.test.ts
//
// The gate hides powershell on non-Windows hosts when (and only when) a
// config actually activated it. On Windows the extension must be a no-op.
import { describe, expect, it } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import powershellGateExtension from "./powershell-gate.js"

describe("powershellGateExtension", () => {
	it.skipIf(process.platform === "win32")("hides powershell when it is active at session_start", () => {
		const { api, getHandler } = createExtensionApi()
		powershellGateExtension(api)

		const active = new Set(["read", "bash", "powershell"])
		api.getActiveTools = () => [...active]
		api.setActiveTools = (names: string[]) => {
			active.clear()
			for (const n of names) active.add(n)
		}

		getHandler("session_start")({} as never, createContext())
		expect(active.has("powershell")).toBe(false)
	})

	it.skipIf(process.platform === "win32")("does nothing when powershell was never activated", () => {
		const { api, getHandler } = createExtensionApi()
		powershellGateExtension(api)

		let setActiveCalls = 0
		api.getActiveTools = () => ["read", "bash"]
		api.setActiveTools = () => {
			setActiveCalls++
		}

		getHandler("session_start")({} as never, createContext())
		expect(setActiveCalls).toBe(0)
	})

	it.skipIf(process.platform === "win32")("hides powershell when it only becomes active before the first turn", () => {
		const { api, getHandler, getHandlers } = createExtensionApi()
		powershellGateExtension(api)

		// Upstream activates builtins asynchronously: powershell may not be in
		// the active list at session_start but lands there before the first
		// before_agent_start prompt build.
		const active = new Set(["read", "bash"])
		api.getActiveTools = () => [...active]
		api.setActiveTools = (names: string[]) => {
			active.clear()
			for (const n of names) active.add(n)
		}

		getHandler("session_start")({} as never, createContext())
		active.add("powershell") // late upstream activation
		for (const handler of getHandlers("before_agent_start")) handler({} as never, createContext())
		expect(active.has("powershell")).toBe(false)
	})

	it.skipIf(process.platform !== "win32")("is a no-op on Windows", () => {
		const { api } = createExtensionApi()
		powershellGateExtension(api)
		const on = api.on
		expect(on).not.toHaveBeenCalled()
	})
})
