import { describe, expect, it, vi } from "vitest"
import { createFerment } from "./create.js"
import type { FermentRuntime } from "./runtime.js"

describe("createFerment", () => {
	it.each([
		{ hasUI: true, isOneShot: false, expected: "manual" },
		{ hasUI: true, isOneShot: true, expected: "automated" },
		{ hasUI: false, isOneShot: false, expected: "automated" },
		{ hasUI: false, isOneShot: true, expected: "automated" },
	] as const)("creates with $expected policy when hasUI=$hasUI and isOneShot=$isOneShot", (entry) => {
		const ferment = { id: "ferment-1", name: "Test" }
		const create = vi.fn(() => ferment)
		const setContinuationPolicy = vi.fn()
		const runtime = {
			getStorage: () => ({ create }),
			setContinuationPolicy,
		} as unknown as FermentRuntime

		const result = createFerment(runtime, {
			name: "Test",
			goal: "Ship it",
			hasUI: entry.hasUI,
			isOneShot: entry.isOneShot,
		})

		expect(create).toHaveBeenCalledWith("Test", "Ship it")
		expect(setContinuationPolicy).toHaveBeenCalledWith(entry.expected)
		expect(result).toBe(ferment)
	})

	it("does not change policy when storage creation fails", () => {
		const error = new Error("storage unavailable")
		const setContinuationPolicy = vi.fn()
		const runtime = {
			getStorage: () => ({
				create: vi.fn(() => {
					throw error
				}),
			}),
			setContinuationPolicy,
		} as unknown as FermentRuntime

		expect(() =>
			createFerment(runtime, {
				name: "Test",
				goal: "Ship it",
				hasUI: true,
				isOneShot: false,
			}),
		).toThrow(error)
		expect(setContinuationPolicy).not.toHaveBeenCalled()
	})
})
