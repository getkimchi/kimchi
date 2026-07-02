import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { getReadOnlyToolNames, registerReadOnlyToolProvider } from "./read-only-tool-registry.js"

/**
 * Build a fresh mock ExtensionAPI. Each call returns a new object so the
 * WeakMap keys are distinct per test — providers registered in one test never
 * leak into another, even without an explicit clear().
 */
const makeMockPi = (): ExtensionAPI => {
	const on = vi.fn()
	return { on } as unknown as ExtensionAPI
}

describe("read-only-tool-registry", () => {
	beforeEach(() => {
		// Each test constructs its own mock pi, so the WeakMap starts empty for
		// that key. No module-level reset is required.
	})

	it("returns an empty array when no providers are registered", () => {
		const pi = makeMockPi()

		expect(getReadOnlyToolNames(pi)).toEqual([])
	})

	it("returns the union of names from two registered providers", () => {
		const pi = makeMockPi()
		registerReadOnlyToolProvider(pi, () => ["server_get_record", "server_search_items"])
		registerReadOnlyToolProvider(pi, () => ["server_list_things", "server_read_doc"])

		const result = getReadOnlyToolNames(pi)

		expect(result).toEqual(["server_get_record", "server_search_items", "server_list_things", "server_read_doc"])
	})

	it("deduplicates names that appear in multiple providers", () => {
		const pi = makeMockPi()
		registerReadOnlyToolProvider(pi, () => ["server_get_record", "server_shared_tool"])
		registerReadOnlyToolProvider(pi, () => ["server_shared_tool", "server_list_things"])

		const result = getReadOnlyToolNames(pi)

		// "server_shared_tool" must appear exactly once.
		expect(result.filter((n) => n === "server_shared_tool")).toHaveLength(1)
		expect(result).toEqual(["server_get_record", "server_shared_tool", "server_list_things"])
	})

	it("reflects the latest state when a provider is called lazily", () => {
		const pi = makeMockPi()
		let current: string[] = ["server_get_record"]
		registerReadOnlyToolProvider(pi, () => current)

		expect(getReadOnlyToolNames(pi)).toEqual(["server_get_record"])

		// Mutate the provider's data source — the next read should reflect it.
		current = ["server_get_record", "server_search_items"]
		expect(getReadOnlyToolNames(pi)).toEqual(["server_get_record", "server_search_items"])
	})

	it("ignores providers registered under a different pi instance", () => {
		const piA = makeMockPi()
		const piB = makeMockPi()
		registerReadOnlyToolProvider(piA, () => ["server_get_record"])

		// piB has no providers — must return empty even though piA has one.
		expect(getReadOnlyToolNames(piB)).toEqual([])
	})

	it("registers a session_shutdown listener on first registration", () => {
		const pi = makeMockPi()
		registerReadOnlyToolProvider(pi, () => ["server_get_record"])

		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function))
	})

	it("does not double-register the same provider reference", () => {
		const pi = makeMockPi()
		const provider = (): string[] => ["server_get_record"]
		registerReadOnlyToolProvider(pi, provider)
		registerReadOnlyToolProvider(pi, provider)

		// Even after two registrations of the same fn, only one call site —
		// but getReadOnlyToolNames should still return the names once.
		expect(getReadOnlyToolNames(pi)).toEqual(["server_get_record"])
	})

	it("handles a provider that returns an empty array", () => {
		const pi = makeMockPi()
		registerReadOnlyToolProvider(pi, () => [])
		registerReadOnlyToolProvider(pi, () => ["server_get_record"])

		expect(getReadOnlyToolNames(pi)).toEqual(["server_get_record"])
	})
})
