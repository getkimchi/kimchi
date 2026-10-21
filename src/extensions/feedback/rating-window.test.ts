import { describe, expect, it } from "vitest"
import { armRatingWindow, clearRatingWindow, consumeRatingWindow, getRatingWindow } from "./rating-window.js"

describe("rating window registry", () => {
	it("returns undefined for a session that was never armed", () => {
		expect(getRatingWindow("sess-missing")).toBeUndefined()
	})

	it("arm round-trips through get for the session", () => {
		armRatingWindow("sess-1", { autoModelUsed: true, routedModelId: "glm-5.3" })
		expect(getRatingWindow("sess-1")).toEqual({ autoModelUsed: true, routedModelId: "glm-5.3" })
		clearRatingWindow("sess-1")
	})

	it("stores routedModelId undefined for a non-auto settle", () => {
		armRatingWindow("sess-1", { autoModelUsed: false, routedModelId: undefined })
		expect(getRatingWindow("sess-1")).toEqual({ autoModelUsed: false, routedModelId: undefined })
		clearRatingWindow("sess-1")
	})

	it("consume returns the window and removes it — one rating per settled response", () => {
		armRatingWindow("sess-1", { autoModelUsed: true, routedModelId: "glm-5.3" })
		expect(consumeRatingWindow("sess-1")).toEqual({ autoModelUsed: true, routedModelId: "glm-5.3" })
		expect(getRatingWindow("sess-1")).toBeUndefined()
		expect(consumeRatingWindow("sess-1")).toBeUndefined()
	})

	it("clear removes the window without recording a submission", () => {
		armRatingWindow("sess-1", { autoModelUsed: false, routedModelId: undefined })
		clearRatingWindow("sess-1")
		expect(getRatingWindow("sess-1")).toBeUndefined()
	})

	it("a new settle re-arms over the previous window", () => {
		armRatingWindow("sess-1", { autoModelUsed: true, routedModelId: "glm-5.3" })
		armRatingWindow("sess-1", { autoModelUsed: false, routedModelId: undefined })
		expect(getRatingWindow("sess-1")).toEqual({ autoModelUsed: false, routedModelId: undefined })
		clearRatingWindow("sess-1")
	})

	it("concurrent sessions are isolated — ACP runs multiple sessions in one process", () => {
		armRatingWindow("sess-1", { autoModelUsed: true, routedModelId: "glm-5.3" })
		armRatingWindow("sess-2", { autoModelUsed: false, routedModelId: undefined })

		expect(consumeRatingWindow("sess-1")).toEqual({ autoModelUsed: true, routedModelId: "glm-5.3" })
		expect(getRatingWindow("sess-2")).toEqual({ autoModelUsed: false, routedModelId: undefined })

		clearRatingWindow("sess-2")
		expect(getRatingWindow("sess-2")).toBeUndefined()
	})
})
