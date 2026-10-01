// extensions/powershell-gate.test.ts
//
// The gate hides powershell on non-Windows hosts whenever the builtin is
// registered — regardless of whether it is currently active. Voting on
// registration (not activation) is what prevents the tool-profile snapshot
// layer (which rebuilds the active set from the registered list) from
// resurrecting powershell into the API payload mid-session. On Windows the
// extension must be a no-op.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import powershellGateExtension from "./powershell-gate.js"
import { getDisabledToolNames } from "./prompt-construction/tool-visibility.js"

interface ToolLike {
	name: string
}

function withRegisteredTools(api: ExtensionAPI, names: string[]): void {
	const tools: ToolLike[] = names.map((name) => ({ name }))
	api.getAllTools = () => tools as never
}

describe("powershellGateExtension", () => {
	it.skipIf(process.platform === "win32")("hides powershell when the builtin is registered but inactive", () => {
		const { api, getHandler } = createExtensionApi()
		powershellGateExtension(api)
		withRegisteredTools(api, ["read", "bash", "powershell"])

		const active = new Set(["read", "bash"])
		api.getActiveTools = () => [...active]
		api.setActiveTools = (names: string[]) => {
			active.clear()
			for (const n of names) active.add(n)
		}

		getHandler("session_start")({} as never, createContext())
		// The vote must be registered with the visibility layer even though
		// powershell was never in the active list — this is what keeps the
		// profile snapshot layer from re-adding it later.
		expect([...getDisabledToolNames(api)]).toContain("powershell")
	})

	it.skipIf(process.platform === "win32")("does nothing when powershell is not registered", () => {
		const { api, getHandler } = createExtensionApi()
		powershellGateExtension(api)
		withRegisteredTools(api, ["read", "bash", "edit", "write"])

		getHandler("session_start")({} as never, createContext())
		expect([...getDisabledToolNames(api)]).not.toContain("powershell")
	})

	it.skipIf(process.platform === "win32")("vote survives a full registered-toolset profile snapshot", () => {
		const { api, getHandler } = createExtensionApi()
		powershellGateExtension(api)
		withRegisteredTools(api, ["read", "bash", "powershell"])

		const active = new Set(["read", "bash"])
		api.getActiveTools = () => [...active]
		api.setActiveTools = (names: string[]) => {
			active.clear()
			for (const n of names) active.add(n)
		}

		getHandler("session_start")({} as never, createContext())
		// Simulate the idle-profile snapshot: every registered tool except
		// those hidden by visibility votes (tool-profile-manager filters
		// getDisabledToolNames out of its snapshot).
		const disabled = getDisabledToolNames(api)
		const snapshot = ["read", "bash", "powershell"].filter((n) => !disabled.has(n))
		expect(snapshot).not.toContain("powershell")
	})

	it.skipIf(process.platform !== "win32")("is a no-op on Windows", () => {
		const { api } = createExtensionApi()
		powershellGateExtension(api)
		expect(api.on).not.toHaveBeenCalled()
	})
})
