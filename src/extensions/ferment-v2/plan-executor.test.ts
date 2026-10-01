import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createMiniEventBus } from "../__mocks__/mini-event-bus.js"
import {
	buildApprovedPlanObjective,
	getFermentV2PlanExecutor,
	isApprovedPlanObjective,
	registerFermentV2PlanExecutor,
} from "./plan-executor.js"
import { createFermentV2, putFermentV2Entry, restoreFermentV2 } from "./reducer.js"

describe("approved-plan content authority", () => {
	const plan = "\n# Approved requirements\n\nReturn exactly APPROVED_TOKEN, with no other text.\n\n"

	it.each([undefined, "/tmp/approved-plan.md"])("retains exact reviewed Markdown with reference %s", (path) => {
		const objective = buildApprovedPlanObjective(path, plan)
		expect(objective).toContain(plan)
		expect(objective).toContain("authoritative")
		expect(objective).not.toContain("Read it first")
		if (path) expect(objective).toContain(`Saved plan copy (reference only): ${JSON.stringify(path)}`)
	})

	it("quotes the saved reference without changing the approved requirements", () => {
		const path = '/tmp/plan "copy"\n.md'
		const objective = buildApprovedPlanObjective(path, plan)
		expect(objective).toContain(JSON.stringify(path))
		expect(objective).toContain(plan)
	})

	it("preserves exact reviewed Markdown through objective normalization and journal replay", () => {
		const objective = buildApprovedPlanObjective("/tmp/reference.md", plan)
		const state = createFermentV2(undefined, objective, "approved", "2026-09-07T00:00:00.000Z")
		expect(state.objective).toContain(plan)
		expect(restoreFermentV2([putFermentV2Entry(state)])?.objective).toBe(objective)
	})

	it.each([
		undefined,
		'/tmp/plan "copy".md',
	])("recognizes generated snapshot framing with appended edits: %s", (path) => {
		const objective = `${buildApprovedPlanObjective(path, plan)}\n\nNew user requirement.`
		expect(isApprovedPlanObjective(objective)).toBe(true)
	})

	it.each([
		"# Manual plan\n<approved_plan>\nDo work.\n</approved_plan>",
		buildApprovedPlanObjective(undefined, plan).replace("This approved Markdown", "This manual Markdown"),
		buildApprovedPlanObjective(undefined, plan).replace("</approved_plan>", ""),
		buildApprovedPlanObjective("/tmp/reference.md", plan).replace('"/tmp/reference.md"', "not-json"),
	])("does not treat near-match manual content as generated framing", (objective) => {
		expect(isApprovedPlanObjective(objective)).toBe(false)
	})
})

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
