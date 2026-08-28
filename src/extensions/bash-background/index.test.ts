/**
 * Regression test for shutdown drain ordering (post-merge review on #988).
 *
 * bashBackgroundExtension is registered before bashControlExtension in
 * src/cli.ts, and shutdown handlers run in registration order. Draining the
 * registry kills pending processes, which settles their `whenExited`
 * promises — if the registry were still published at that point, the
 * control extension's exit watcher could emit an "exited on its own"
 * steer into the closing session. The extension must UNPUBLISH the
 * session registry before awaiting the drain.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import bashBackgroundExtension from "./index.js"
import type { ProcessRegistry } from "./process-registry.js"
import { getSessionRegistry, setSessionRegistry } from "./session-registry.js"

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown

interface RegisteredTool {
	name: string
	description: string
	execute: unknown
}

function makeFakePi(): ExtensionAPI & {
	registeredTools: Map<string, RegisteredTool>
	emit(event: string, payload: unknown, ctx?: unknown): Promise<void>
} {
	const handlers = new Map<string, AnyHandler[]>()
	const registeredTools = new Map<string, RegisteredTool>()
	const fake = {
		handlers,
		registeredTools,
		on(event: string, handler: AnyHandler) {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
		registerTool(tool: RegisteredTool) {
			registeredTools.set(tool.name, tool)
		},
		async emit(event: string, payload: unknown, ctx?: unknown) {
			for (const h of handlers.get(event) ?? []) {
				await h(payload, ctx as ExtensionContext)
			}
		},
	}
	return fake as unknown as ExtensionAPI & {
		registeredTools: Map<string, RegisteredTool>
		emit(event: string, payload: unknown, ctx?: unknown): Promise<void>
	}
}

describe("bashBackgroundExtension — shutdown drain ordering", () => {
	afterEach(() => {
		// The session registry is a module singleton — never leak it.
		setSessionRegistry(undefined)
	})

	it("unpublishes the session registry before awaiting the drain", async () => {
		const pi = makeFakePi()
		bashBackgroundExtension(pi)
		await pi.emit("session_start", {}, { cwd: "/tmp" })
		expect(getSessionRegistry()).toBeDefined()

		// Swap in a sentinel that records what the accessor returns while the
		// drain is in progress.
		const observed: { publishedDuringDrain: ProcessRegistry | undefined | "unset" } = {
			publishedDuringDrain: "unset",
		}
		const sentinel = {
			async shutdown(): Promise<void> {
				observed.publishedDuringDrain = getSessionRegistry()
			},
		} as unknown as ProcessRegistry
		setSessionRegistry(sentinel)

		await pi.emit("session_shutdown", {})

		expect(observed.publishedDuringDrain).toBeUndefined()
		expect(getSessionRegistry()).toBeUndefined()
	})

	it("session_start installs a fresh registry that callers can resolve", async () => {
		const pi = makeFakePi()
		bashBackgroundExtension(pi)

		await pi.emit("session_start", {}, { cwd: "/tmp" })
		const first = getSessionRegistry()
		expect(first).toBeDefined()

		await pi.emit("session_shutdown", {})
		expect(getSessionRegistry()).toBeUndefined()
	})
})

describe("bashBackgroundExtension — production description composition", () => {
	afterEach(() => {
		setSessionRegistry(undefined)
	})

	it("registers the bash tool with the non-blocking guidance from bashToolDescription", async () => {
		const pi = makeFakePi()
		bashBackgroundExtension(pi)

		await pi.emit("session_start", {}, { cwd: "/tmp" })

		const bash = pi.registeredTools.get("bash")
		expect(bash).toBeDefined()
		// The production-registered description must carry the non-blocking
		// guidance so the model knows other tools stay available while a
		// process runs.
		expect(bash?.description).toContain("other tools stay available")
		expect(bash?.description).toContain("do independent work")
		expect(bash?.description).toContain("instead of calling bash_control just to wait")
		expect(bash?.description).toContain("avoid commands or edits that could conflict")

		await pi.emit("session_shutdown", {})
	})

	it("registers the bash tool with the background-execute function", async () => {
		const pi = makeFakePi()
		bashBackgroundExtension(pi)

		await pi.emit("session_start", {}, { cwd: "/tmp" })

		const bash = pi.registeredTools.get("bash")
		expect(bash).toBeDefined()
		expect(typeof bash?.execute).toBe("function")

		await pi.emit("session_shutdown", {})
	})
})
