import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it } from "vitest"
import {
	prepareAgentWorkerSession,
	registerAgentWorkerSessionAdapter,
	resetAgentWorkerSessionAdaptersForTests,
} from "./agent-worker-session.js"

const ui = (tag: string) => ({ tag }) as unknown as ExtensionUIContext

describe("agent worker session adapters", () => {
	beforeEach(() => resetAgentWorkerSessionAdaptersForTests())

	it("keeps workers without a host headless", () => {
		const worker = prepareAgentWorkerSession("child", "parent")
		expect(worker.bindings).toEqual({})
		expect(() => worker.cleanup()).not.toThrow()
	})

	it("uses the latest adapter for the exact root and preserves its bindings", () => {
		const removeOld = registerAgentWorkerSessionAdapter("parent", () => ({
			bindings: { uiContext: ui("old"), mode: "rpc" },
			cleanup: () => {},
		}))
		let cleanups = 0
		const children: string[] = []
		registerAgentWorkerSessionAdapter("parent", (child, parent) => {
			children.push(child)
			expect(parent).toBe("parent")
			return {
				bindings: { uiContext: ui("new"), mode: "rpc" },
				cleanup: () => {
					cleanups++
				},
			}
		})
		registerAgentWorkerSessionAdapter("other", () => ({
			bindings: { uiContext: ui("other"), mode: "print" },
			cleanup: () => {},
		}))

		const worker = prepareAgentWorkerSession("child", "parent")
		expect(children).toEqual(["child"])
		expect(worker.bindings.uiContext).toEqual(ui("new"))
		expect(worker.bindings.mode).toBe("rpc")
		expect(prepareAgentWorkerSession("other-child", "parent").bindings).toEqual(worker.bindings)
		expect(prepareAgentWorkerSession("unowned", "unrelated").bindings).toEqual({})
		worker.cleanup()
		worker.cleanup()
		expect(cleanups).toBe(1)

		removeOld()
		removeOld()
		expect(prepareAgentWorkerSession("after-old-removal", "parent").bindings).toEqual(worker.bindings)
	})

	it("stops routing workers to a root after its adapter is removed", () => {
		const remove = registerAgentWorkerSessionAdapter("parent", () => ({
			bindings: { uiContext: ui("root"), mode: "rpc" },
			cleanup: () => {},
		}))
		remove()
		expect(prepareAgentWorkerSession("child", "parent").bindings).toEqual({})
	})
})
