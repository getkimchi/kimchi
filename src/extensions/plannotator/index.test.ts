import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	clearPlanReviewState,
	consumePlanReviewContext,
	emitPlanReviewRequest,
} from "../../shared/planning/plan-review-bus.js"
import plannotatorExtension from "./index.js"

interface MockCaptures {
	emitCalls: Array<{ channel: string; data: unknown }>
	requestHandler?: (data: unknown) => void
	resultHandler?: (data: unknown) => void
}

function createMockPi(captures: MockCaptures, opts?: { hasUI?: boolean; oneshot?: boolean }): ExtensionAPI {
	const emit = vi.fn((channel: string, data: unknown) => {
		captures.emitCalls.push({ channel, data })
	})

	const on = vi.fn((channel: string, handler: (data: unknown) => void) => {
		if (channel === "kimchi:plan-review-request") {
			captures.requestHandler = handler
		} else if (channel === "plannotator:review-result") {
			captures.resultHandler = handler
		}
		return () => {}
	})

	const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = []
	const piOn = vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
		if (event === "session_start") sessionStartHandlers.push(handler)
	})

	const getFlag = vi.fn((flag: string) => !!(flag === "ferment-oneshot" && opts?.oneshot))

	return {
		events: { emit, on },
		on: piOn,
		getFlag,
		_sessionStartHandlers: sessionStartHandlers,
		_hasUI: opts?.hasUI ?? true,
	} as unknown as ExtensionAPI
}

function setupExtension(opts?: { hasUI?: boolean; oneshot?: boolean }): { pi: ExtensionAPI; captures: MockCaptures } {
	const captures: MockCaptures = { emitCalls: [] }
	const pi = createMockPi(captures, opts)
	plannotatorExtension(pi)
	const piWithHandlers = pi as unknown as {
		_sessionStartHandlers: Array<(event: unknown, ctx: unknown) => Promise<void>>
		_hasUI: boolean
	}
	const mockCtx = { hasUI: piWithHandlers._hasUI, mode: "tui" }
	piWithHandlers._sessionStartHandlers.forEach((h) => void h({}, mockCtx))
	return { pi, captures }
}

function reviewContext(sessionId = "session-a") {
	return {
		ctx: { sessionManager: { getSessionId: () => sessionId, appendCustomEntry: vi.fn() } } as never,
		planText: "plan",
	}
}

function emitReview(
	pi: ExtensionAPI,
	captures: MockCaptures,
	payload: { fermentId?: string; planContent?: string; sessionId?: string; source?: "adhoc" | "ferment" } = {},
): string {
	const sessionId = payload.sessionId ?? "session-a"
	const source = payload.source ?? "adhoc"
	const requestPayload = {
		sessionId,
		planContent: payload.planContent ?? "plan",
		source,
		fermentId: payload.fermentId,
	}
	emitPlanReviewRequest(pi, requestPayload, { ...reviewContext(sessionId), fermentId: payload.fermentId })
	captures.requestHandler?.(requestPayload)
	const request = captures.emitCalls.filter((c) => c.channel === "plannotator:request").at(-1)?.data as {
		requestId: string
	}
	return request.requestId
}

describe("plannotator adapter", () => {
	beforeEach(() => {
		clearPlanReviewState()
	})

	describe("kimchi:plan-review-request -> plannotator:request", () => {
		it("emits plannotator:request with plan-review action when a plan-review-request arrives", () => {
			const { pi, captures } = setupExtension()

			const requestId = emitReview(pi, captures, {
				planContent: "# My Plan",
				sessionId: "session-a",
			})

			const plannotatorEmit = captures.emitCalls.find((c) => c.channel === "plannotator:request")
			expect(plannotatorEmit?.data).toMatchObject({
				action: "plan-review",
				payload: {
					planContent: "# My Plan",
					origin: "adhoc",
					sessionId: "session-a",
				},
			})
			expect(requestId).toBeTypeOf("string")
		})

		it("passes ferment source as origin", () => {
			const { pi, captures } = setupExtension()

			emitReview(pi, captures, { source: "ferment", fermentId: "f-1" })

			const plannotatorEmit = captures.emitCalls.find((c) => c.channel === "plannotator:request")
			expect(plannotatorEmit?.data).toMatchObject({
				payload: { origin: "ferment" },
			})
		})
	})

	describe("subscribe-side gating", () => {
		it("does not subscribe when hasUI is false", () => {
			const { pi, captures } = setupExtension({ hasUI: false })

			emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "adhoc" }, reviewContext())

			expect(captures.requestHandler).toBeUndefined()
			expect(captures.emitCalls.find((c) => c.channel === "plannotator:request")).toBeUndefined()
		})

		it("does not subscribe when ferment-oneshot flag is set", () => {
			const { pi, captures } = setupExtension({ oneshot: true })

			emitPlanReviewRequest(pi, { sessionId: "session-a", planContent: "plan", source: "adhoc" }, reviewContext())

			expect(captures.requestHandler).toBeUndefined()
			expect(captures.emitCalls.find((c) => c.channel === "plannotator:request")).toBeUndefined()
		})
	})

	describe("plannotator:review-result -> kimchi:plan-review-decision", () => {
		it("emits execute when plannotator approves", () => {
			const { pi, captures } = setupExtension()
			emitReview(pi, captures)

			captures.resultHandler?.({ approved: true })

			expect(captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")?.data).toMatchObject({
				sessionId: "session-a",
				decision: "execute",
				source: "plannotator",
				planReviewSource: "adhoc",
			})
		})

		it("emits feedback when plannotator denies with feedback", () => {
			const { pi, captures } = setupExtension()
			emitReview(pi, captures)

			captures.resultHandler?.({ approved: false, feedback: "Add more detail to chunk 2" })

			expect(captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")?.data).toMatchObject({
				sessionId: "session-a",
				decision: "feedback",
				feedback: "Add more detail to chunk 2",
				source: "plannotator",
				planReviewSource: "adhoc",
			})
		})

		it("emits rework when plannotator denies without feedback", () => {
			const { pi, captures } = setupExtension()
			emitReview(pi, captures)

			captures.resultHandler?.({ approved: false, feedback: "  " })

			expect(captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")?.data).toMatchObject({
				sessionId: "session-a",
				decision: "rework",
				source: "plannotator",
				planReviewSource: "adhoc",
			})
		})

		it("ignores review-result when no review is active", () => {
			const { captures } = setupExtension()

			captures.resultHandler?.({ approved: true })

			expect(captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")).toBeUndefined()
		})

		it("ignores review-result with missing approved field", () => {
			const { pi, captures } = setupExtension()
			emitReview(pi, captures)

			captures.resultHandler?.({ feedback: "some text" })

			expect(captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")).toBeUndefined()
		})

		it("uses the correct planReviewSource for ferment reviews", () => {
			const { pi, captures } = setupExtension()
			emitReview(pi, captures, { source: "ferment", fermentId: "f-1" })

			captures.resultHandler?.({ approved: true })

			expect(captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")?.data).toMatchObject({
				sessionId: "session-a",
				planReviewSource: "ferment",
				fermentId: "f-1",
			})
		})

		it("uses requestId to keep concurrent review results session-scoped", () => {
			const { pi, captures } = setupExtension()
			const requestA = emitReview(pi, captures, { sessionId: "session-a", planContent: "plan a" })
			const requestB = emitReview(pi, captures, {
				sessionId: "session-b",
				planContent: "plan b",
				source: "ferment",
				fermentId: "f-b",
			})

			captures.resultHandler?.({ requestId: requestB, approved: true })

			expect(requestA).not.toBe(requestB)
			expect(captures.emitCalls.find((c) => c.channel === "kimchi:plan-review-decision")?.data).toMatchObject({
				sessionId: "session-b",
				planReviewSource: "ferment",
				fermentId: "f-b",
			})
			expect(consumePlanReviewContext("session-a")).toBeDefined()
			expect(consumePlanReviewContext("session-b")).toBeDefined()
		})
	})

	describe("first-decision-wins", () => {
		it("second plannotator decision is ignored after first is consumed", () => {
			const { pi, captures } = setupExtension()
			emitReview(pi, captures)

			captures.resultHandler?.({ approved: true })
			consumePlanReviewContext("session-a")
			captures.resultHandler?.({ approved: false, feedback: "too late" })

			const decisionEmits = captures.emitCalls.filter((c) => c.channel === "kimchi:plan-review-decision")
			expect(decisionEmits).toHaveLength(1)
		})
	})
})
