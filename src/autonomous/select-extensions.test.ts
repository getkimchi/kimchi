import { describe, expect, it, vi } from "vitest"
import type { AutonomousExtensions } from "./select-extensions.js"
import { selectExtensionFactories } from "./select-extensions.js"

function makeFactory() {
	return vi.fn()
}

function makeAutonomousExtensions(overrides?: Partial<AutonomousExtensions>): AutonomousExtensions {
	return {
		resultWriter: vi.fn(),
		...overrides,
	}
}

describe("selectExtensionFactories", () => {
	it("returns a shallow copy (not the same array reference) when autonomous is false", () => {
		const base = [makeFactory(), makeFactory()]
		const result = selectExtensionFactories(base, { autonomous: false })
		expect(result).not.toBe(base)
	})

	it("returned array has the same length and same elements as base when autonomous is false", () => {
		const f1 = makeFactory()
		const f2 = makeFactory()
		const base = [f1, f2]
		const result = selectExtensionFactories(base, { autonomous: false })
		expect(result).toHaveLength(2)
		expect(result[0]).toBe(f1)
		expect(result[1]).toBe(f2)
	})

	it("when autonomous is true with only resultWriter, returns base + resultWriter", () => {
		const f1 = makeFactory()
		const f2 = makeFactory()
		const base = [f1, f2]
		const autonomousExtensions = makeAutonomousExtensions()
		const result = selectExtensionFactories(base, { autonomous: true, autonomousExtensions })
		expect(result).toHaveLength(3)
		expect(result[0]).toBe(f1)
		expect(result[1]).toBe(f2)
		expect(result[2]).toBe(autonomousExtensions.resultWriter)
	})

	it("when autonomous is true with resultWriter + timeoutGuard, appends both in order", () => {
		const base = [makeFactory()]
		const timeoutGuard = makeFactory()
		const autonomousExtensions = makeAutonomousExtensions({ timeoutGuard })
		const result = selectExtensionFactories(base, { autonomous: true, autonomousExtensions })
		expect(result).toHaveLength(3)
		expect(result[1]).toBe(autonomousExtensions.resultWriter)
		expect(result[2]).toBe(timeoutGuard)
	})

	it("when autonomous is true with resultWriter + maxIterations, appends both in order", () => {
		const base = [makeFactory()]
		const maxIterations = makeFactory()
		const autonomousExtensions = makeAutonomousExtensions({ maxIterations })
		const result = selectExtensionFactories(base, { autonomous: true, autonomousExtensions })
		expect(result).toHaveLength(3)
		expect(result[1]).toBe(autonomousExtensions.resultWriter)
		expect(result[2]).toBe(maxIterations)
	})

	it("when autonomous is true with all three optional extensions, appends all three after resultWriter", () => {
		const base = [makeFactory(), makeFactory()]
		const timeoutGuard = makeFactory()
		const maxIterations = makeFactory()
		const autonomousExtensions = makeAutonomousExtensions({ timeoutGuard, maxIterations })
		const result = selectExtensionFactories(base, { autonomous: true, autonomousExtensions })
		expect(result).toHaveLength(5)
		expect(result[2]).toBe(autonomousExtensions.resultWriter)
		expect(result[3]).toBe(timeoutGuard)
		expect(result[4]).toBe(maxIterations)
	})

	it("does not mutate the base array after the call", () => {
		const f1 = makeFactory()
		const f2 = makeFactory()
		const base = [f1, f2]
		const autonomousExtensions = makeAutonomousExtensions()
		selectExtensionFactories(base, { autonomous: true, autonomousExtensions })
		expect(base).toHaveLength(2)
	})

	it("when autonomous is true and base is empty, returns just resultWriter", () => {
		const autonomousExtensions = makeAutonomousExtensions()
		const result = selectExtensionFactories([], { autonomous: true, autonomousExtensions })
		expect(result).toHaveLength(1)
		expect(result[0]).toBe(autonomousExtensions.resultWriter)
	})

	it("does not invoke any of the factories when called", () => {
		const f1 = makeFactory()
		const f2 = makeFactory()
		const base = [f1, f2]
		const timeoutGuard = makeFactory()
		const maxIterations = makeFactory()
		const autonomousExtensions = makeAutonomousExtensions({ timeoutGuard, maxIterations })

		selectExtensionFactories(base, { autonomous: true, autonomousExtensions })
		selectExtensionFactories(base, { autonomous: false })

		expect(f1).not.toHaveBeenCalled()
		expect(f2).not.toHaveBeenCalled()
		expect(autonomousExtensions.resultWriter).not.toHaveBeenCalled()
		expect(timeoutGuard).not.toHaveBeenCalled()
		expect(maxIterations).not.toHaveBeenCalled()
	})
})
