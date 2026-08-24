import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { consumePlanReviewContext, emitPlanReviewRequest } from "../../shared/planning/plan-review-bus.js"
import plannotatorExtension from "./index.js"

interface MockCaptures {
	emitCalls: Array<{ channel: string; data: unknown }>
	requestHandler?: (data: unknown) => void
	resultHandler?: (data: unknown) => void
}

function createMockPi(captures: MockCaptures): ExtensionAPI {
	const emit = vi.fn((channel: string, data: unknown) => {
		captures.emitCalls.push({ channel, data })
		// If this is a plannotator:request, capture nothing — the adapter
		// doesn't need a respond callback result.
	})

	const on = vi.fn((channel: string, handler: (data: unknown) => void) => {
		if (channel === "kimchi:plan-review-request") {
			captures.requestHandler = handler
		} else if (channel === "plannotator:review-result") {
			captures.resultHandler = handler
		}
		return () => {}
	})

	const sessionStartHandlers: Array<() => Promise<void>> = []
	const piOn = vi.fn((event: string, handler: () => Promise<void>) => {
		if (event === "session_start") sessionStartHandlers.push(handler)
	})

	return {
		events: { emit, on },
		on: piOn,
		_sessionStartHandlers: sessionStartHandlers,
	} as unknown as ExtensionAPI
}

function setupExtension(): { pi: ExtensionAPI; captures: MockCaptures } {
	const captures: MockCaptures = { emitCalls: [] }
	const pi = createMockPi(captures)
	plannotatorExtension(pi)
	// Fire session_start to register listeners
	const piWithHandlers = pi as unknown as { _sessionStartHandlers: Array<() => Promise<void>> }
	piWithHandlers._sessionStartHandlers.forEach((h) => void h())
	return { pi, captures }
}

describe("plannotator adapter", () => {
	beforeEach(() => {
		consumePlanReviewContext()
	})

	describe("kimchi:plan-review-request → plannotator:request", () => {
		it("emits plannotator:request with plan-review action when a plan-review-request arrives", () => {
			const { pi, captures } = setupExtension()

			emitPlanReviewRequest(
				pi,
				{
					planContent: "# My Plan",
					planFilePath: "/plans/my-plan.md",
					source: "adhoc",
				},
				{ ctx: {} as never, planText: "# My Plan", planPath: "/plans/my-plan.md" },
			)

			// The adapter's onPlanReviewRequest handler should have been called
			expect(captures.requestHandler).toBeDefined()
			captures.requestHandler!({
				planContent: "# My Plan",
				planFilePath: "/plans/my-plan.md",
				source: "adhoc",
			})

			const plannotatorEmit = captures.emitCalls.find((c) => c.channel === "plannotator:request")
			expect(plannotatorEmit).toBeDefined()
			expect(plannotatorEmit!.data).toMatchObject({
				action: "plan-review",
				payload: {
					planContent: "# My Plan",
					planFilePath: "/plans/my-plan.md",
					origin: "adhoc",
				},
			})
			expect((plannotatorEmit!.data as { requestId: string }).requestId).toBeTypeOf("string")
		})

		it("passes ferment source as origin", () => {
			const { pi, captures } = setupExtension()

			emitPlanReviewRequest(
				pi,
				{
					planContent: "ferment plan",
					source: "ferment",
					fermentId: "f-1",
				},
				{ ctx: {} as never, planText: "ferment plan", fermentId: "f-1" },
			)

			captures.requestHandler!({
				planContent: "ferment plan",
				source: "ferment",
				fermentId: "f-1",
			})

			const plannotatorEmit = captures.emitCalls.find((c) => c.channel === "plannotator:request")
			expect(plannotatorEmit!.data).toMatchObject({
				payload: { origin: "ferment" },
			})
		})
	})

	describe("plannotator:review-result → kimchi:plan-review-decision", () => {
		it("emits plan-review-decision with execute when plannotator approves", () => {
			const { pi, captures } = setupExtension()

			// First, emit a request to set the active review source
			emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, { ctx: {} as never, planText: "plan" })
			captures.requestHandler!({ planContent: "plan", source: "adhoc" })

			// Simulate plannotator review-result: approved
			captures.resultHandler!({ approved: true })

			const decisionEmit = captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")
			expect(decisionEmit).toBeDefined()
			expect(decisionEmit!.data).toMatchObject({
				decision: "execute",
				source: "plannotator",
				planReviewSource: "adhoc",
			})
		})

		it("emits plan-review-decision with feedback when plannotator denies", () => {
			const { pi, captures } = setupExtension()

			emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, { ctx: {} as never, planText: "plan" })
			captures.requestHandler!({ planContent: "plan", source: "adhoc" })

			captures.resultHandler!({
				approved: false,
				feedback: "Add more detail to chunk 2",
			})

			const decisionEmit = captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")
			expect(decisionEmit!.data).toMatchObject({
				decision: "feedback",
				feedback: "Add more detail to chunk 2",
				source: "plannotator",
				planReviewSource: "adhoc",
			})
		})

		it("ignores review-result when no review is active", () => {
			const { captures } = setupExtension()

			captures.resultHandler!({ approved: true })

			const decisionEmit = captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")
			expect(decisionEmit).toBeUndefined()
		})

		it("ignores review-result with missing approved field", () => {
			const { pi, captures } = setupExtension()

			emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, { ctx: {} as never, planText: "plan" })
			captures.requestHandler!({ planContent: "plan", source: "adhoc" })

			captures.resultHandler!({ feedback: "some text" })

			const decisionEmit = captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")
			expect(decisionEmit).toBeUndefined()
		})

		it("uses the correct planReviewSource for ferment reviews", () => {
			const { pi, captures } = setupExtension()

			emitPlanReviewRequest(
				pi,
				{ planContent: "plan", source: "ferment", fermentId: "f-1" },
				{ ctx: {} as never, planText: "plan", fermentId: "f-1" },
			)
			captures.requestHandler!({ planContent: "plan", source: "ferment", fermentId: "f-1" })

			captures.resultHandler!({ approved: true })

			const decisionEmit = captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")
			expect(decisionEmit!.data).toMatchObject({
				planReviewSource: "ferment",
			})
		})
	})

	describe("first-decision-wins", () => {
		it("second plannotator decision is ignored after first is consumed", () => {
			const { pi, captures } = setupExtension()

			emitPlanReviewRequest(pi, { planContent: "plan", source: "adhoc" }, { ctx: {} as never, planText: "plan" })
			captures.requestHandler!({ planContent: "plan", source: "adhoc" })

			// First decision
			captures.resultHandler!({ approved: true })

			// Consume the context (simulating the decision handler acting)
			consumePlanReviewContext()

			// Second decision — should be ignored
			captures.resultHandler!({ approved: false, feedback: "too late" })

			const decisionEmits = captures.emitCalls.filter((c) => c.channel === "kimchi:plan-review-decision")
			expect(decisionEmits).toHaveLength(1)
		})
	})
})
