/**
 * Regression test for shutdown drain ordering (post-merge review on #988).
 *
 * bashBackgroundExtension is registered before bashControlExtension in
 * src/cli.ts, and shutdown handlers run in registration order. Draining the
 * registry kills pending processes, which settles their `whenExited`
 * promises — if the state were still published at that point, the
 * control extension's exit watcher could emit an "exited on its own"
 * steer into the closing session. The extension must UNPUBLISH the
 * session state before awaiting the drain.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import bashBackgroundExtension from "./index.js"
import { DEFAULT_BASH_PROCESS_LIMIT_SECONDS } from "./process-registry.js"
import { type BashSessionState, getSessionState, setSessionState } from "./session-registry.js"

const sessionCtx = { cwd: "/tmp" } as unknown as ExtensionContext

interface RegisteredTool {
	name: string
	description: string
	execute: unknown
}

function registeredTools(
	registerTool: ReturnType<typeof createExtensionApi>["registerTool"],
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>()
	for (const call of registerTool.mock.calls) {
		const tool = call[0] as unknown as RegisteredTool
		tools.set(tool.name, tool)
	}
	return tools
}

describe("bashBackgroundExtension — shutdown drain ordering", () => {
	afterEach(() => {
		// The session state is a module singleton — never leak it.
		setSessionState(undefined)
	})

	it("unpublishes the session state before awaiting the drain", async () => {
		const { api, emit } = createExtensionApi()
		bashBackgroundExtension(api)
		await emit("session_start", {}, sessionCtx)
		expect(getSessionState()).toBeDefined()

		// Swap in a sentinel that records what the accessor returns while the
		// drain is in progress.
		const observed: { publishedDuringDrain: unknown } = {
			publishedDuringDrain: "unset",
		}
		const sentinel = {
			coordinator: {
				dispose() {
					// sentinel: no timers to clear in this test double
				},
			},
			registry: {
				async shutdown(): Promise<void> {
					observed.publishedDuringDrain = getSessionState()?.registry
				},
			},
		}
		setSessionState(sentinel as unknown as BashSessionState)

		await emit("session_shutdown", {})

		expect(observed.publishedDuringDrain).toBeUndefined()
		expect(getSessionState()).toBeUndefined()
	})

	it("session_start installs fresh state that callers can resolve", async () => {
		const { api, emit } = createExtensionApi()
		bashBackgroundExtension(api)

		await emit("session_start", {}, sessionCtx)
		const first = getSessionState()
		expect(first).toBeDefined()
		expect(first?.limitSeconds).toBe(DEFAULT_BASH_PROCESS_LIMIT_SECONDS)
		expect(first?.cwd).toBe("/tmp")

		// A resumed/forked session gets a fresh cohort: handles from the old
		// session are not reusable (the registry is rebuilt).
		const firstRegistry = first?.registry
		await emit("session_start", {}, sessionCtx)
		const second = getSessionState()
		expect(second).toBeDefined()
		expect(second?.registry).not.toBe(firstRegistry)

		await emit("session_shutdown", {})
		expect(getSessionState()).toBeUndefined()
	})
})

describe("bashBackgroundExtension — production description composition", () => {
	afterEach(() => {
		setSessionState(undefined)
	})

	it("registers the bash tool with the cohort guidance from bashToolDescription", async () => {
		const { api, emit, registerTool } = createExtensionApi()
		bashBackgroundExtension(api)

		await emit("session_start", {}, sessionCtx)

		const bash = registeredTools(registerTool).get("bash")
		expect(bash).toBeDefined()
		// The production-registered description must carry the cohort
		// contract so the model knows processes continue by default and are
		// reviewed automatically.
		expect(bash?.description).toContain("continues by default")
		expect(bash?.description).toContain("bash_control")
		expect(bash?.description).toContain("stop_handles")
		// ...and no model-facing timing knobs.
		expect(bash?.description).not.toContain("checkin_interval")
		expect(bash?.description).not.toContain("extend_seconds")

		await emit("session_shutdown", {})
	})

	it("registers the bash tool with the background-execute function", async () => {
		const { api, emit, registerTool } = createExtensionApi()
		bashBackgroundExtension(api)

		await emit("session_start", {}, sessionCtx)

		const bash = registeredTools(registerTool).get("bash")
		expect(bash).toBeDefined()
		expect(typeof bash?.execute).toBe("function")

		await emit("session_shutdown", {})
	})
})
