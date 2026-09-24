import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	isPlannotatorReviewAvailable,
	type PlannotatorReviewOutcome,
	requestPlannotatorCodeReview,
} from "./plannotator-review.js"

interface EmittedRequest {
	requestId: string
	action: string
	payload?: { cwd?: string; patchFile?: string }
	respond: (response: unknown) => void
}

/** Fires the request, grabs the emitted bus payload, responds, returns the outcome. */
async function roundTrip(response: unknown): Promise<{ outcome: PlannotatorReviewOutcome; request: EmittedRequest }> {
	const { api, emitEvent } = createExtensionApi()
	const promise = requestPlannotatorCodeReview(api, { cwd: "/repo", patchFile: "/tmp/remote-diff.diff" })
	expect(emitEvent).toHaveBeenCalledOnce()
	const [channel, request] = emitEvent.mock.calls[0] as [string, EmittedRequest]
	expect(channel).toBe("plannotator:request")
	request.respond(response)
	return { outcome: await promise, request }
}

describe("isPlannotatorReviewAvailable", () => {
	it("is false when no extension registered the review command", () => {
		const { api } = createExtensionApi()
		expect(isPlannotatorReviewAvailable(api)).toBe(false)
	})

	it("is true when /plannotator-review is registered", () => {
		const { api, getCommands } = createExtensionApi()
		getCommands.mockReturnValue([{ name: "plannotator-review" } as ReturnType<typeof api.getCommands>[number]])
		expect(isPlannotatorReviewAvailable(api)).toBe(true)
	})
})

describe("requestPlannotatorCodeReview", () => {
	it("emits a code-review request carrying cwd + patchFile", async () => {
		const { request } = await roundTrip({ status: "handled", result: { approved: true } })
		expect(request.action).toBe("code-review")
		expect(request.payload).toEqual({ cwd: "/repo", patchFile: "/tmp/remote-diff.diff" })
		expect(request.requestId).toMatch(/^kimchi-/)
	})

	it("maps an approval to approve", async () => {
		const { outcome } = await roundTrip({ status: "handled", result: { approved: true } })
		expect(outcome).toEqual({ outcome: "decision", decision: { kind: "approve" } })
	})

	it("maps a denial with feedback to request-changes carrying the summary and annotations", async () => {
		const feedback = "1. [src/login.ts:42] make this 5\n\nOverall: tighten the retry loop"
		const { outcome } = await roundTrip({
			status: "handled",
			result: { approved: false, feedback, annotations: [{ file: "src/login.ts", line: 42, text: "make this 5" }] },
		})
		expect(outcome).toEqual({
			outcome: "decision",
			decision: {
				kind: "request-changes",
				summary: feedback,
				comments: [{ file: "src/login.ts", line: 42, text: "make this 5" }],
			},
		})
	})

	it("maps an annotation-only denial to request-changes with a fallback summary", async () => {
		const { outcome } = await roundTrip({
			status: "handled",
			result: {
				approved: false,
				feedback: "",
				annotations: [
					{
						id: "a1",
						type: "comment",
						filePath: "src/login.ts",
						lineStart: 42,
						lineEnd: 42,
						side: "new",
						text: "make this 5",
						originalCode: "const attempts = 3",
					},
					// Tolerated and dropped: no recognizable text to act on.
					{ bogus: true },
					"not-an-annotation",
				],
			},
		})
		expect(outcome).toEqual({
			outcome: "decision",
			decision: {
				kind: "request-changes",
				summary: "Review feedback from browser",
				comments: [
					{
						file: "src/login.ts",
						line: 42,
						side: "new",
						code: "const attempts = 3",
						text: "make this 5",
					},
				],
			},
		})
	})

	it("maps a blank denial with empty annotations to closed (a bare dismissal)", async () => {
		const { outcome } = await roundTrip({
			status: "handled",
			result: { approved: false, feedback: "", annotations: [] },
		})
		expect(outcome).toEqual({ outcome: "decision", decision: { kind: "closed" } })
	})

	it("maps a contentless denial to closed", async () => {
		const { outcome } = await roundTrip({ status: "handled", result: { approved: false, feedback: "  " } })
		expect(outcome).toEqual({ outcome: "decision", decision: { kind: "closed" } })
	})

	it("maps an exit decision to closed", async () => {
		const { outcome } = await roundTrip({
			status: "handled",
			result: { approved: false, feedback: "", annotations: [], exit: true },
		})
		expect(outcome).toEqual({ outcome: "decision", decision: { kind: "closed" } })
	})

	it("surfaces plannotator-side errors", async () => {
		const { outcome } = await roundTrip({
			status: "error",
			error: "Static patch review requires non-empty unified-diff content.",
		})
		expect(outcome).toEqual({
			outcome: "error",
			message: "Static patch review requires non-empty unified-diff content.",
		})
	})

	it("surfaces the unavailable status with no error text of its own", async () => {
		const { outcome } = await roundTrip({ status: "unavailable" })
		expect(outcome).toEqual({ outcome: "error", message: "unavailable" })
	})

	it("rejects malformed responses instead of hanging", async () => {
		const { outcome } = await roundTrip("not-a-response")
		expect(outcome).toEqual({ outcome: "error", message: "plannotator returned a malformed response" })
	})
})
