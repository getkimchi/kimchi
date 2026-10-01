import { afterEach, describe, expect, it, vi } from "vitest"
import {
	consumePlanReviewContext,
	emitPlanReviewDecision,
	emitPlanReviewRequest,
} from "../../shared/planning/plan-review-bus.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createMiniEventBus } from "../__mocks__/mini-event-bus.js"
import plannotatorExtension from "./index.js"

function setup() {
	const harness = createExtensionApi()
	const { events } = createMiniEventBus()
	harness.api.events = events
	harness.api.getFlag = vi.fn(() => false)
	const ctx = createContext()
	let sequence = 0
	const responses: Array<(value: unknown) => void> = []
	events.on("plannotator:request", (request: { respond(value: unknown): void }) => {
		responses.push(request.respond)
		request.respond({ status: "handled", result: { status: "pending", reviewId: `review-${++sequence}` } })
	})
	plannotatorExtension(harness.api)
	return {
		...harness,
		events,
		ctx,
		responses,
		start: () => harness.getHandler("session_start")({}, ctx),
		request(source: "adhoc" | "ferment" = "adhoc") {
			emitPlanReviewRequest(
				harness.api,
				{ planContent: "# Plan", planFilePath: "/tmp/plan.md", source },
				{ ctx, planText: "# Plan", planPath: "/tmp/plan.md" },
			)
		},
		decisions: () => events.emit.mock.calls.filter(([channel]) => channel === "kimchi:plan-review-decision"),
	}
}

describe("Plannotator review adapter", () => {
	afterEach(() => {
		consumePlanReviewContext()
		vi.unstubAllEnvs()
	})

	it.each([
		[true, undefined, "execute"],
		[false, "change the design", "feedback"],
		[false, " ", "rework"],
	] as const)("routes the matching browser decision: %s / %s", async (approved, feedback, decision) => {
		const h = setup()
		await h.start()
		h.request()
		expect(h.events.emit).toHaveBeenCalledWith(
			"plannotator:request",
			expect.objectContaining({
				action: "plan-review",
				payload: { planContent: "# Plan", planFilePath: "/tmp/plan.md", origin: "adhoc" },
			}),
		)
		h.events.emit("plannotator:review-result", { reviewId: "review-1", approved, feedback })
		expect(h.decisions()).toEqual([
			[
				"kimchi:plan-review-decision",
				expect.objectContaining({ decision, source: "plannotator", planReviewSource: "adhoc" }),
			],
		])
	})

	it("does not approve a newer plan from an old browser tab or delayed request response", async () => {
		const h = setup()
		await h.start()
		h.request()
		h.request()
		h.responses[0]({ status: "handled", result: { reviewId: "review-1" } })
		h.events.emit("plannotator:review-result", { reviewId: "review-1", approved: true })
		h.events.emit("plannotator:review-result", { approved: true })
		expect(h.decisions()).toHaveLength(0)
		h.events.emit("plannotator:review-result", { reviewId: "review-2", approved: true })
		expect(h.decisions()).toHaveLength(1)
	})

	it("keeps one listener per session and removes listeners on shutdown", async () => {
		const h = setup()
		await h.start()
		await h.start()
		h.request("ferment")
		expect(h.responses).toHaveLength(1)
		h.events.emit("plannotator:review-result", { reviewId: "review-1", approved: true })
		expect(h.decisions()[0]?.[1]).toMatchObject({ planReviewSource: "ferment" })
		await h.getHandler("session_shutdown")({}, h.ctx)
		h.request()
		expect(h.responses).toHaveLength(1)
	})

	it("honors a TUI decision first and ignores a late browser result", async () => {
		const h = setup()
		await h.start()
		h.request()
		emitPlanReviewDecision(h.api, { decision: "execute", source: "kimchi-tui", planReviewSource: "adhoc" })
		h.events.emit("plannotator:review-result", { reviewId: "review-1", approved: false })
		expect(h.decisions()).toHaveLength(1)
	})

	it.each([
		"headless",
		"oneshot",
		"worker",
	])("skips %s sessions, including after an interactive session", async (mode) => {
		const h = setup()
		await h.start()
		if (mode === "headless") h.ctx.hasUI = false
		if (mode === "oneshot") h.api.getFlag = vi.fn(() => true)
		if (mode === "worker") vi.stubEnv("KIMCHI_PARENT_SESSION_ID", "parent")
		await h.start()
		h.request()
		expect(h.responses).toHaveLength(0)
	})
})
