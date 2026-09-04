import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	clearPlanReviewState,
	consumePlanReviewContext,
	emitPlanReviewDecision,
	emitPlanReviewRequest,
	emitPlanReviewResolved,
	getActivePlanReviewSource,
	onPlanReviewDecision,
	onPlanReviewRequest,
	onPlanReviewResolved,
	PLAN_REVIEW_DECISION_CHANNEL,
	PLAN_REVIEW_REQUEST_CHANNEL,
	PLAN_REVIEW_RESOLVED_CHANNEL,
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
	ctx: {
		sessionManager: { appendCustomEntry: vi.fn(), getSessionId: () => "session-a" },
	} as unknown as PlanReviewContext["ctx"],
	planText: "# Plan",
	planPath: "/plans/plan.md",
}

describe("emitPlanReviewRequest", () => {
	beforeEach(() => {
		clearPlanReviewState()
	})

	it("emits on the request channel with correct payload", () => {
		const { pi, emit } = createMockPi()

		emitPlanReviewRequest(
			pi,
			{
				planContent: "# My Plan",
				planFilePath: "/plans/my-plan.md",
				sessionId: "session-a",
				source: "adhoc",
			},
			fakeContext,
		)

		expect(emit).toHaveBeenCalledWith(
			PLAN_REVIEW_REQUEST_CHANNEL,
			expect.objectContaining({
				planContent: "# My Plan",
				planFilePath: "/plans/my-plan.md",
				sessionId: "session-a",
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
				sessionId: "session-a",
				source: "adhoc",
			},
			fakeContext,
		)

		expect(consumePlanReviewContext("session-a")).toBe(fakeContext)
	})

	it("resets previous pending state for the same session on new emission", () => {
		const { pi: pi1 } = createMockPi()
		const { pi: pi2 } = createMockPi()

		emitPlanReviewRequest(pi1, { sessionId: "session-a", planContent: "plan1", source: "adhoc" }, fakeContext)
		emitPlanReviewRequest(
			pi2,
			{ sessionId: "session-a", planContent: "plan2", source: "ferment" },
			{ ...fakeContext, fermentId: "f-1" },
		)

		const ctx = consumePlanReviewContext("session-a")
		expect(ctx?.fermentId).toBe("f-1")
	})

	it("keeps concurrent session review state isolated", () => {
		const { pi } = createMockPi()
		const contextB = { ...fakeContext, planText: "# B" }

		emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan a", source: "adhoc" }, fakeContext)
		emitPlanReviewRequest(pi, { sessionId: "session-b", planContent: "plan b", source: "ferment" }, contextB)

		expect(getActivePlanReviewSource("session-a")).toBe("adhoc")
		expect(getActivePlanReviewSource("session-b")).toBe("ferment")
		expect(consumePlanReviewContext("session-a")).toBe(fakeContext)
		expect(consumePlanReviewContext("session-b")).toBe(contextB)
	})
})

describe("emitPlanReviewDecision", () => {
	beforeEach(() => {
		clearPlanReviewState()
	})

	it("emits on the decision channel", () => {
		const { pi, emit } = createMockPi()
		emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "adhoc" }, fakeContext)

		emitPlanReviewDecision(pi, {
			sessionId: "session-a",
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
		emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "adhoc" }, fakeContext)

		emitPlanReviewDecision(pi, {
			sessionId: "session-a",
			decision: "execute",
			source: "plannotator",
			planReviewSource: "adhoc",
		})
		emitPlanReviewDecision(pi, {
			sessionId: "session-a",
			decision: "rework",
			source: "kimchi-tui",
			planReviewSource: "adhoc",
		})

		const decisionCalls = emit.mock.calls.filter((c: unknown[]) => c[0] === PLAN_REVIEW_DECISION_CHANNEL)
		expect(decisionCalls).toHaveLength(1)
		expect(decisionCalls[0][1]).toMatchObject({ decision: "execute" })
	})

	it("ignores decision when no review is active", () => {
		const { pi, emit } = createMockPi()

		emitPlanReviewDecision(pi, {
			sessionId: "session-a",
			decision: "execute",
			source: "kimchi-tui",
			planReviewSource: "adhoc",
		})

		const decisionCalls = emit.mock.calls.filter((c: unknown[]) => c[0] === PLAN_REVIEW_DECISION_CHANNEL)
		expect(decisionCalls).toHaveLength(0)
	})

	it("ignores decision with mismatched planReviewSource", () => {
		const { pi, emit } = createMockPi()
		emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "adhoc" }, fakeContext)

		emitPlanReviewDecision(pi, {
			sessionId: "session-a",
			decision: "execute",
			source: "plannotator",
			planReviewSource: "ferment",
		})

		const decisionCalls = emit.mock.calls.filter((c: unknown[]) => c[0] === PLAN_REVIEW_DECISION_CHANNEL)
		expect(decisionCalls).toHaveLength(0)
	})
})

describe("consumePlanReviewContext", () => {
	beforeEach(() => {
		clearPlanReviewState()
	})

	it("returns undefined when no review is active", () => {
		expect(consumePlanReviewContext("session-a")).toBeUndefined()
	})

	it("returns context and clears state", () => {
		const { pi } = createMockPi()
		emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "adhoc" }, fakeContext)

		expect(consumePlanReviewContext("session-a")).toBe(fakeContext)
		expect(consumePlanReviewContext("session-a")).toBeUndefined()
	})
})

describe("getActivePlanReviewSource", () => {
	beforeEach(() => {
		clearPlanReviewState()
	})

	it("returns undefined when no review is active", () => {
		expect(getActivePlanReviewSource("session-a")).toBeUndefined()
	})

	it("returns the source after a request is emitted", () => {
		const { pi } = createMockPi()
		emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "ferment" }, fakeContext)
		expect(getActivePlanReviewSource("session-a")).toBe("ferment")
	})

	it("returns undefined after decision is consumed", () => {
		const { pi } = createMockPi()
		emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "adhoc" }, fakeContext)
		consumePlanReviewContext("session-a")
		expect(getActivePlanReviewSource("session-a")).toBeUndefined()
	})

	it("returns undefined after first decision is emitted", () => {
		const { pi } = createMockPi()
		emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "adhoc" }, fakeContext)
		emitPlanReviewDecision(pi, {
			sessionId: "session-a",
			decision: "execute",
			source: "kimchi-tui",
			planReviewSource: "adhoc",
		})
		expect(getActivePlanReviewSource("session-a")).toBeUndefined()
	})
})

describe("onPlanReviewRequest / onPlanReviewDecision", () => {
	beforeEach(() => {
		clearPlanReviewState()
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

		registeredHandler?.({ sessionId: "session-a", planContent: "plan", source: "adhoc" })
		expect(handler).toHaveBeenCalledWith({ sessionId: "session-a", planContent: "plan", source: "adhoc" })
	})

	it("onPlanReviewDecision registers a handler that receives payloads", () => {
		const { pi, on } = createMockPi()
		const handler = vi.fn()

		onPlanReviewDecision(pi, handler)

		const registeredHandler = on.mock.calls.find((c: unknown[]) => c[0] === PLAN_REVIEW_DECISION_CHANNEL)?.[1] as
			| ((data: unknown) => void)
			| undefined
		expect(registeredHandler).toBeDefined()

		registeredHandler?.({
			sessionId: "session-a",
			decision: "execute",
			source: "kimchi-tui",
			planReviewSource: "adhoc",
		})
		expect(handler).toHaveBeenCalledWith({
			sessionId: "session-a",
			decision: "execute",
			source: "kimchi-tui",
			planReviewSource: "adhoc",
		})
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
		registeredHandler?.({ planContent: "plan", source: "adhoc" }) // missing sessionId

		expect(handler).not.toHaveBeenCalled()
	})

	it("onPlanReviewResolved registers a handler that receives resolved payloads", () => {
		const { pi, on } = createMockPi()
		const handler = vi.fn()

		onPlanReviewResolved(pi, handler)

		const registeredHandler = on.mock.calls.find((c: unknown[]) => c[0] === PLAN_REVIEW_RESOLVED_CHANNEL)?.[1] as
			| ((data: unknown) => void)
			| undefined
		expect(registeredHandler).toBeDefined()

		registeredHandler?.({
			sessionId: "session-a",
			decision: "execute",
			planReviewSource: "adhoc",
			outcome: "accepted",
		})
		expect(handler).toHaveBeenCalledWith({
			sessionId: "session-a",
			decision: "execute",
			planReviewSource: "adhoc",
			outcome: "accepted",
		})
	})

	it("emits resolved payloads after handlers accept a review transition", () => {
		const { pi, emit } = createMockPi()

		emitPlanReviewResolved(pi, {
			sessionId: "session-a",
			decision: "execute",
			planReviewSource: "adhoc",
			outcome: "accepted",
		})

		expect(emit).toHaveBeenCalledWith(PLAN_REVIEW_RESOLVED_CHANNEL, {
			sessionId: "session-a",
			decision: "execute",
			planReviewSource: "adhoc",
			outcome: "accepted",
		})
	})
})
