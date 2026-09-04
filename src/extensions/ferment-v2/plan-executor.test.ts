import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createMiniEventBus } from "../__mocks__/mini-event-bus.js"
import { getFermentV2PlanExecutor, registerFermentV2PlanExecutor } from "./plan-executor.js"

describe("Ferment V2 approved-plan executor registry", () => {
	it("resolves an executor registered by another ExtensionAPI on the same event bus", async () => {
		const { events } = createMiniEventBus()
		const fermentPi = { events } as unknown as ExtensionAPI
		const permissionsPi = { events } as unknown as ExtensionAPI
		const executor = vi.fn(async () => "started" as const)
		const unregister = registerFermentV2PlanExecutor(fermentPi, executor)

		try {
			const routed = getFermentV2PlanExecutor(permissionsPi)
			expect(routed).toBeDefined()

			await expect(
				routed?.(
					{
						objective: 'Read the approved plan at "/tmp/plan.md" before continuing.',
						title: "Plan",
						planText: "# Plan",
						planPath: "/tmp/plan.md",
					},
					{ hasUI: true } as ExtensionContext,
				),
			).resolves.toBe("started")
			expect(executor).toHaveBeenCalledOnce()
		} finally {
			unregister()
		}
	})

	it("keeps runtimes isolated and removes a responder when unregistered", () => {
		const firstBus = createMiniEventBus()
		const secondBus = createMiniEventBus()
		const firstPi = { events: firstBus.events } as unknown as ExtensionAPI
		const secondPi = { events: secondBus.events } as unknown as ExtensionAPI
		const unregister = registerFermentV2PlanExecutor(
			firstPi,
			vi.fn(async () => "started" as const),
		)

		expect(getFermentV2PlanExecutor(firstPi)).toBeDefined()
		expect(getFermentV2PlanExecutor(secondPi)).toBeUndefined()

		unregister()
		expect(getFermentV2PlanExecutor(firstPi)).toBeUndefined()
	})

	it("uses the first executor when more than one responder is present", () => {
		const { events } = createMiniEventBus()
		const pi = { events } as unknown as ExtensionAPI
		const first = vi.fn(async () => "started" as const)
		const second = vi.fn(async () => "kept-existing" as const)
		const unregisterFirst = registerFermentV2PlanExecutor(pi, first)
		const unregisterSecond = registerFermentV2PlanExecutor(pi, second)

		try {
			expect(getFermentV2PlanExecutor(pi)).toBe(first)
		} finally {
			unregisterFirst()
			unregisterSecond()
		}
	})
})
