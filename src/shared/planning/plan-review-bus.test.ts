import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	consumePlanReviewContext,
	emitPlanReviewDecision,
	emitPlanReviewRequest,
	getActivePlanReviewSource,
	onPlanReviewDecision,
	onPlanReviewRequest,
	PLAN_REVIEW_DECISION_CHANNEL,
	PLAN_REVIEW_REQUEST_CHANNEL,
	type PlanReviewContext,
} from "./plan-review-bus.js"

function createMockPi(): {
	pi: ExtensionAPI
	emit: ReturnType<typeof vi.fn>
	on: ReturnType<typeof vi.fn>
} {
	const emit = vi.fn()
	const on = vi.fn((_channel: string, _handler: (data: unknown) => void) => () => {})
	return { pi: { events: { emit, on } } as unknown as ExtensionAPI, emit, on }
}

const fakeContext: PlanReviewContext = {
	ctx: {} as PlanReviewContext["ctx"],
	planText: "# Plan",
	planPath: "/plans/plan.md",
}

describe("emitPlanReviewRequest", () => {
	beforeEach(() => {
		consumePlanReviewContext()
	})

	it("emits on the request channel with correct payload", () => {
		const { pi, emit } = createMockPi()

		emitPlanReviewRequest(
			pi,
			{
				planContent: "# My Plan",
				planFilePath: "/plans/my-plan.md",
				source: "adhoc",
			},
			fakeContext,
		)

		expect(emit).toHaveBeenCalledWith(
			PLAN_REVIEW_REQUEST_CHANNEL,
			expect.objectContaining({
				planContent: "# My Plan",
				planFilePath: "/plans/my-plan.md",
				source: "adhoc",
			}),
		)
	})

	it("stores context for the decision handler", () => {
		const { pi } = createMockPi()

		emitPlanReviewRequest(
			pi,
			{
				planContent: "plan",
				source: "adhoc",
			},
			fakeContext,
		)

		expect(consumePlanReviewContext()).toBe(fakeContext)
	})

	it("resets previous pending state on new emission", () => {
		const { pi: pi1 } = createMockPi()
		const { pi: pi2 } = createMockPi()

		emitPlanReviewRequest(pi1, { planContent: "plan1", source: "adhoc" }, fakeContext)
		emitPlanReviewRequest(pi2, { planContent: "plan2", source: "ferment" }, { ...fakeContext, fermentId: "f-1" })

		const ctx = consumePlanReviewContext()
		expect(ctx?.fermentId).toBe("f-1")
	})
})

describe("emitPlanReviewDecision", () => {
	beforeEach(() => {
		consumePlanReviewContext()
	})

	it("emits on the decision channel", () => {
		const { pi, emit } = createMockPi()
		emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, fakeContext)

		emitPlanReviewDecision(pi, {
			decision: "execute",
			source: "kimchi-tui",
			planReviewSource: "adhoc",
		})

		expect(emit).toHaveBeenCalledWith(
			PLAN_REVIEW_DECISION_CHANNEL,
			expect.objectContaining({ decision: "execute", source: "kimchi-tui" }),
		)
	})

	it("first decision wins — second emission is ignored", () => {
		const { pi, emit } = createMockPi()
		emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, fakeContext)

		emitPlanReviewDecision(pi, { decision: "execute", source: "plannotator", planReviewSource: "adhoc" })
		emitPlanReviewDecision(pi, { decision: "rework", source: "kimchi-tui", planReviewSource: "adhoc" })

		const decisionCalls = emit.mock.calls.filter((c: unknown[]) => c[0] === PLAN_REVIEW_DECISION_CHANNEL)
		expect(decisionCalls).toHaveLength(1)
		expect(decisionCalls[0][1]).toMatchObject({ decision: "execute" })
	})

	it("ignores decision when no review is active", () => {
		const { pi, emit } = createMockPi()

		emitPlanReviewDecision(pi, { decision: "execute", source: "kimchi-tui", planReviewSource: "adhoc" })

		const decisionCalls = emit.mock.calls.filter((c: unknown[]) => c[0] === PLAN_REVIEW_DECISION_CHANNEL)
		expect(decisionCalls).toHaveLength(0)
	})

	it("ignores decision with mismatched planReviewSource", () => {
		const { pi, emit } = createMockPi()
		emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, fakeContext)

		emitPlanReviewDecision(pi, { decision: "execute", source: "plannotator", planReviewSource: "ferment" })

		const decisionCalls = emit.mock.calls.filter((c: unknown[]) => c[0] === PLAN_REVIEW_DECISION_CHANNEL)
		expect(decisionCalls).toHaveLength(0)
	})
})

describe("consumePlanReviewContext", () => {
	beforeEach(() => {
		consumePlanReviewContext()
	})

	it("returns undefined when no review is active", () => {
		expect(consumePlanReviewContext()).toBeUndefined()
	})

	it("returns context and clears state", () => {
		const { pi } = createMockPi()
		emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, fakeContext)

		expect(consumePlanReviewContext()).toBe(fakeContext)
		expect(consumePlanReviewContext()).toBeUndefined()
	})
})

describe("getActivePlanReviewSource", () => {
	beforeEach(() => {
		consumePlanReviewContext()
	})

	it("returns undefined when no review is active", () => {
		expect(getActivePlanReviewSource()).toBeUndefined()
	})

	it("returns the source after a request is emitted", () => {
		const { pi } = createMockPi()
		emitPlanReviewRequest(pi, { planContent: "plan", source: "ferment" }, fakeContext)
		expect(getActivePlanReviewSource()).toBe("ferment")
	})

	it("returns undefined after decision is consumed", () => {
		const { pi } = createMockPi()
		emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, fakeContext)
		consumePlanReviewContext()
		expect(getActivePlanReviewSource()).toBeUndefined()
	})

	it("returns undefined after first decision is emitted", () => {
		const { pi } = createMockPi()
		emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, fakeContext)
		emitPlanReviewDecision(pi, { decision: "execute", source: "kimchi-tui", planReviewSource: "adhoc" })
		expect(getActivePlanReviewSource()).toBeUndefined()
	})
})

describe("onPlanReviewRequest / onPlanReviewDecision", () => {
	beforeEach(() => {
		consumePlanReviewContext()
	})

	it("onPlanReviewRequest registers a handler that receives payloads", () => {
		const { pi, on } = createMockPi()
		const handler = vi.fn()

		onPlanReviewRequest(pi, handler)

		// Simulate the event bus calling the registered handler
		const registeredHandler = on.mock.calls.find((c: unknown[]) => c[0] === PLAN_REVIEW_REQUEST_CHANNEL)?.[1] as
			| ((data: unknown) => void)
			| undefined
		expect(registeredHandler).toBeDefined()

		registeredHandler?.({ planContent: "plan", source: "adhoc" })
		expect(handler).toHaveBeenCalledWith({ planContent: "plan", source: "adhoc" })
	})

	it("onPlanReviewDecision registers a handler that receives payloads", () => {
		const { pi, on } = createMockPi()
		const handler = vi.fn()

		onPlanReviewDecision(pi, handler)

		const registeredHandler = on.mock.calls.find((c: unknown[]) => c[0] === PLAN_REVIEW_DECISION_CHANNEL)?.[1] as
			| ((data: unknown) => void)
			| undefined
		expect(registeredHandler).toBeDefined()

		registeredHandler?.({ decision: "execute", source: "kimchi-tui", planReviewSource: "adhoc" })
		expect(handler).toHaveBeenCalledWith({ decision: "execute", source: "kimchi-tui", planReviewSource: "adhoc" })
	})

	it("onPlanReviewRequest ignores malformed payloads", () => {
		const { pi, on } = createMockPi()
		const handler = vi.fn()

		onPlanReviewRequest(pi, handler)

		const registeredHandler = on.mock.calls.find((c: unknown[]) => c[0] === PLAN_REVIEW_REQUEST_CHANNEL)?.[1] as
			| ((data: unknown) => void)
			| undefined

		registeredHandler?.(null)
		registeredHandler?.({})
		registeredHandler?.({ source: "adhoc" }) // missing planContent

		expect(handler).not.toHaveBeenCalled()
	})
})
