import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import {
	createAcpWorkerUIContext,
	registerAcpChildInteraction,
	registerAcpRootUIContext,
	registerAcpWorkerSession,
	resetAcpInteractionRegistriesForTests,
	resolveAcpInteractionPrompter,
	withAcpInteraction,
} from "./child-interaction-registry.js"
import { registerAcpPrompter, unregisterAcpPrompter } from "./permission-prompter-registry.js"

const prompter = (tag: string) => ({ tag }) as unknown as ToolPermissionPrompter
const ui = (tag: string) => ({ tag, input: vi.fn(async () => tag) }) as unknown as ExtensionUIContext

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => (resolve = r))
	return { promise, resolve }
}

beforeEach(() => {
	resetAcpInteractionRegistriesForTests()
	unregisterAcpPrompter("parent")
	unregisterAcpPrompter("parent-b")
})

describe("child interaction ownership", () => {
	it("uses an announced child's prompter, and the correct owning root before announcement", () => {
		const root = prompter("root")
		const otherRoot = prompter("other-root")
		const child = prompter("child")
		registerAcpPrompter("parent", root)
		registerAcpPrompter("parent-b", otherRoot)
		const cleanupWorker = registerAcpWorkerSession("child-id", "parent")
		expect(resolveAcpInteractionPrompter("child-id")).toBe(root)
		expect(resolveAcpInteractionPrompter("unrelated-worker")).toBeUndefined()

		const cleanupChild = registerAcpChildInteraction({
			childSessionId: "child-id",
			parentSessionId: "parent",
			permissionPrompter: child,
			uiContext: ui("child-ui"),
		})
		expect(resolveAcpInteractionPrompter("child-id")).toBe(child)
		cleanupChild()
		expect(resolveAcpInteractionPrompter("child-id")).toBe(root)
		cleanupWorker()
		expect(resolveAcpInteractionPrompter("child-id")).toBeUndefined()
	})

	it("lazily switches new UI calls after announcement without moving an in-flight call", async () => {
		const rootUi = ui("root-answer")
		const childUi = ui("child-answer")
		registerAcpRootUIContext("parent", rootUi)
		registerAcpWorkerSession("child-id", "parent")
		const worker = createAcpWorkerUIContext("child-id")
		expect(worker).toBeDefined()
		await expect(worker?.input("before")).resolves.toBe("root-answer")

		const rootPending = deferred<string | undefined>()
		vi.mocked(rootUi.input).mockImplementationOnce(() => rootPending.promise)
		const pending = worker?.input("pinned")
		registerAcpChildInteraction({
			childSessionId: "child-id",
			parentSessionId: "parent",
			permissionPrompter: prompter("child"),
			uiContext: childUi,
		})
		await expect(worker?.input("after")).resolves.toBe("child-answer")
		rootPending.resolve("root-pinned")
		await expect(pending).resolves.toBe("root-pinned")
		expect(vi.mocked(childUi.input)).toHaveBeenCalledTimes(1)
	})

	it("returns no proxy when no ACP owner exists", () => {
		registerAcpWorkerSession("child-id", "plain-cli-parent")
		expect(createAcpWorkerUIContext("child-id")).toBeUndefined()
	})
})

describe("requires_action interaction lifecycle", () => {
	it("aggregates concurrent waits and clears exactly once", async () => {
		const states: boolean[] = []
		const first = deferred<void>()
		const second = deferred<void>()
		registerAcpChildInteraction({
			childSessionId: "child-id",
			parentSessionId: "parent",
			permissionPrompter: prompter("child"),
			uiContext: ui("child"),
			onRequiresActionChange: (state) => states.push(state),
		})
		const one = withAcpInteraction("child-id", () => first.promise)
		const two = withAcpInteraction("child-id", () => second.promise)
		expect(states).toEqual([true])
		first.resolve()
		await one
		expect(states).toEqual([true])
		second.resolve()
		await two
		expect(states).toEqual([true, false])
	})

	it("cleanup clears a live wait once and later settlement cannot emit again", async () => {
		const states: boolean[] = []
		const pending = deferred<void>()
		const cleanup = registerAcpChildInteraction({
			childSessionId: "child-id",
			parentSessionId: "parent",
			permissionPrompter: prompter("child"),
			uiContext: ui("child"),
			onRequiresActionChange: (state) => states.push(state),
		})
		const request = withAcpInteraction("child-id", () => pending.promise)
		cleanup()
		cleanup()
		pending.resolve()
		await request
		expect(states).toEqual([true, false])
	})
})
