import { describe, expect, it, vi } from "vitest"
import {
	cancelEscalatedRequests,
	getParentSurface,
	type ParentSurface,
	registerEscalationAbort,
	registerParentSurface,
	unregisterParentSurface,
} from "./parent-surface-registry.js"

function makeSurface(): ParentSurface & { calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = []
	return {
		calls,
		notify: (message, level) => {
			calls.push([message, level])
		},
	}
}

describe("parent surface registry", () => {
	it("returns the latest registered surface for a session", () => {
		const first = makeSurface()
		const second = makeSurface()
		registerParentSurface("session-a", first)
		registerParentSurface("session-a", second)
		expect(getParentSurface("session-a")).toBe(second)
		expect(unregisterParentSurface("session-a", second)).toBe(false)
		expect(getParentSurface("session-a")).toBe(first)
		expect(unregisterParentSurface("session-a", first)).toBe(true)
		expect(getParentSurface("session-a")).toBeUndefined()
	})

	it("keeps sessions isolated — two parents in one process do not cross", () => {
		const parentA = makeSurface()
		const parentB = makeSurface()
		registerParentSurface("session-a", parentA)
		registerParentSurface("session-b", parentB)
		expect(getParentSurface("session-a")).toBe(parentA)
		expect(getParentSurface("session-b")).toBe(parentB)
		getParentSurface("session-a")?.notify("blocked", "warning")
		expect(parentA.calls).toEqual([["blocked", "warning"]])
		expect(parentB.calls).toEqual([])
		unregisterParentSurface("session-a", parentA)
		unregisterParentSurface("session-b", parentB)
	})

	it("identity-checked removal ignores unknown surfaces and keeps live entries", () => {
		const live = makeSurface()
		const stranger = makeSurface()
		registerParentSurface("session-c", live)
		expect(unregisterParentSurface("session-c", stranger)).toBe(false)
		expect(getParentSurface("session-c")).toBe(live)
		expect(unregisterParentSurface("session-d", live)).toBe(true)
		expect(getParentSurface("session-c")).toBe(live)
		unregisterParentSurface("session-c", live)
	})

	it("unregisters by key when no expected surface is given", () => {
		const surface = makeSurface()
		registerParentSurface("session-e", surface)
		expect(unregisterParentSurface("session-e")).toBe(true)
		expect(getParentSurface("session-e")).toBeUndefined()
	})

	it("cancels requests with one controller and cleans up its own registration", () => {
		const controller = new AbortController()
		const unregister = registerEscalationAbort("session-cancel", "tc-1", controller)
		cancelEscalatedRequests("session-cancel", "mode changed")
		expect(controller.signal.aborted).toBe(true)
		unregister()
		cancelEscalatedRequests("session-cancel", "another change")
		expect(controller.signal.aborted).toBe(true)
		unregisterParentSurface("session-cancel")
	})

	it("keeps same-call prompts from different workers independently cancellable", () => {
		const first = new AbortController()
		const second = new AbortController()
		const unregisterFirst = registerEscalationAbort("session-shared-call", "shared-call", first, "worker-a")
		const unregisterSecond = registerEscalationAbort("session-shared-call", "shared-call", second, "worker-b")
		unregisterFirst()
		cancelEscalatedRequests("session-shared-call", "mode changed")
		expect(first.signal.aborted).toBe(false)
		expect(second.signal.aborted).toBe(true)
		unregisterSecond()
	})

	it("forwards the notice level to the surface", () => {
		const surface = makeSurface()
		const notifySpy = vi.spyOn(surface, "notify")
		registerParentSurface("session-f", surface)
		getParentSurface("session-f")?.notify("Permission classifier is back.", "info")
		expect(notifySpy).toHaveBeenCalledWith("Permission classifier is back.", "info")
		unregisterParentSurface("session-f", surface)
	})

	it("carries an optional requestPermission route for escalated prompts", () => {
		const surface: ParentSurface = {
			notify: () => {},
			requestPermission: () => Promise.resolve({ kind: "allow-once" }),
		}
		registerParentSurface("session-g", surface)
		expect(getParentSurface("session-g")?.requestPermission).toBeDefined()
		unregisterParentSurface("session-g")
	})
})
