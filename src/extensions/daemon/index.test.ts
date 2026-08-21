/**
 * Extension-level tests for the daemon extension factory.
 *
 * The factory is thin: register both tools on session_start, and on
 * session_shutdown notify (TUI only) when detached daemons are still
 * running. The shutdown notice uses the REAL default state dir by
 * default, which would leak `~/.config/kimchi` into tests — the current
 * API gives no seam for it. Test what's testable without that seam:
 * registration wiring.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { setExperimentalFeaturesEnabled, withExperimentalFeatures } from "../experimental.js"
import daemonExtension from "./index.js"

afterEach(() => {
	setExperimentalFeaturesEnabled(false)
})

describe("daemonExtension", () => {
	it("registers daemon and daemon_control tools on session_start", () => {
		setExperimentalFeaturesEnabled(true)
		const { api, getHandler } = createExtensionApi()
		const registerTool = vi.mocked(api.registerTool)

		daemonExtension(api)
		getHandler("session_start")({} as never, createContext())

		const names = registerTool.mock.calls.map(([tool]) => tool.name)
		expect(names).toContain("daemon")
		expect(names).toContain("daemon_control")
	})

	it("registers no tools when experimental features are disabled", () => {
		setExperimentalFeaturesEnabled(false)
		const { api, getHandler } = createExtensionApi()
		const registerTool = vi.mocked(api.registerTool)

		daemonExtension(api)
		getHandler("session_start")({} as never, createContext())

		expect(registerTool).not.toHaveBeenCalled()
	})

	it("registers a session_shutdown handler (honesty notice, no killing)", () => {
		const { api } = createExtensionApi()
		daemonExtension(api)
		const on = vi.mocked(api.on)
		const events = on.mock.calls.map(([event]) => event)
		expect(events).toContain("session_shutdown")
	})

	it("session_shutdown is a no-op in headless sessions", () => {
		const { api, getHandler } = createExtensionApi()
		daemonExtension(api)
		const ctx = createContext({ hasUI: false })
		const notify = vi.mocked(ctx.ui.notify)

		// State dir interference would only matter with a UI; headless
		// must never touch the UI.
		getHandler("session_shutdown")({} as never, ctx)
		expect(notify).not.toHaveBeenCalled()
	})

	describe("before_agent_start steering (long-lived services clause)", () => {
		async function callBeforeAgentStart(
			{ api, getHandler }: ReturnType<typeof createExtensionApi>,
			ctxOverrides: Parameters<typeof createContext>[0],
		): Promise<{ systemPrompt: string } | undefined> {
			daemonExtension(api)
			const handler = getHandler<unknown, { systemPrompt: string }>("before_agent_start")
			const result = await handler({ systemPrompt: "BASE" } as never, createContext(ctxOverrides))
			return result as { systemPrompt: string } | undefined
		}

		it("injects the daemon clause in headless sessions with the flag on", () =>
			withExperimentalFeatures(true, async () => {
				const result = await callBeforeAgentStart(createExtensionApi(), { hasUI: false })
				expect(result?.systemPrompt).toContain("BASE")
				expect(result?.systemPrompt).toContain("## Long-lived services")
				expect(result?.systemPrompt).toContain("`daemon`")
			}))

		it("does NOT name the daemon tool when experimental features are disabled", () =>
			withExperimentalFeatures(false, async () => {
				const result = await callBeforeAgentStart(createExtensionApi(), { hasUI: false })
				expect(result).toBeUndefined()
			}))

		it("stays silent when a UI is attached", () =>
			withExperimentalFeatures(true, async () => {
				const result = await callBeforeAgentStart(createExtensionApi(), { hasUI: true })
				expect(result).toBeUndefined()
			}))

		it("stays silent in ferment-oneshot sessions", () =>
			withExperimentalFeatures(true, async () => {
				const fresh = createExtensionApi()
				;(fresh.api as { getFlag?: (f: string) => unknown }).getFlag = () => true
				const result = await callBeforeAgentStart(fresh, { hasUI: false })
				expect(result).toBeUndefined()
			}))
	})
})
