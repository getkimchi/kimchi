import { describe, expect, it } from "vitest"
import {
	isFermentOneshotRequested,
	isPrintModeEnabled,
	setPrintGate,
	shouldSuppressFermentModeTools,
	shouldSuppressInteractiveTools,
	withPrintGate,
} from "./print-mode.js"

describe("print-mode gates (token-optimization Phase 1 Chunk 7)", () => {
	it("defaults to interactive: nothing suppressed", () => {
		expect(isPrintModeEnabled()).toBe(false)
		expect(isFermentOneshotRequested()).toBe(false)
		expect(shouldSuppressInteractiveTools()).toBe(false)
		expect(shouldSuppressFermentModeTools()).toBe(false)
	})

	it("plain print run suppresses both gates", () => {
		return withPrintGate({ print: true }, async () => {
			expect(shouldSuppressInteractiveTools()).toBe(true)
			expect(shouldSuppressFermentModeTools()).toBe(true)
		})
	})

	it("print + ferment-oneshot composes: interactive gate stays on, ferment gate lifts", () => {
		return withPrintGate({ print: true, fermentOneshot: true }, async () => {
			expect(isPrintModeEnabled()).toBe(true)
			expect(isFermentOneshotRequested()).toBe(true)
			expect(shouldSuppressInteractiveTools()).toBe(true)
			expect(shouldSuppressFermentModeTools()).toBe(false)
		})
	})

	it("oneshot without print suppresses nothing", () => {
		return withPrintGate({ print: false, fermentOneshot: true }, async () => {
			expect(shouldSuppressInteractiveTools()).toBe(false)
			expect(shouldSuppressFermentModeTools()).toBe(false)
		})
	})

	it("withPrintGate restores previous flags even when fn throws", async () => {
		setPrintGate(false, false)
		await expect(
			withPrintGate({ print: true, fermentOneshot: true }, async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")
		expect(isPrintModeEnabled()).toBe(false)
		expect(isFermentOneshotRequested()).toBe(false)
	})
})
