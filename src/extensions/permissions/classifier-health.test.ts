import { describe, expect, it } from "vitest"
import { createModel } from "../__mocks__/model-registry.js"
import { classifierHealth } from "./classifier-health.js"
import { DEFAULT_CLASSIFIER_CANDIDATE_REFS } from "./classifier-models.js"
import { PERMISSION_EVENTS } from "./permissions-events.js"
import type { ClassifierFailureCode, ClassifierResult } from "./types.js"

const primary = createModel("deepseek-v4-flash-0731")
const fallback = createModel("minimax-m3")
const healthy: ClassifierResult = { verdict: "safe", ok: true, reason: "fine", usedModelId: primary.id }

describe("classifierHealth", () => {
	it.each(["safe", "requires-confirmation"] as const)("treats primary %s as healthy", (verdict) => {
		expect(classifierHealth({ ...healthy, verdict }, [primary, fallback], [])).toBeUndefined()
	})

	it.each([
		{ candidates: [primary, fallback], missingRefs: [], usedModelId: fallback.id },
		{ candidates: [fallback], missingRefs: [DEFAULT_CLASSIFIER_CANDIDATE_REFS[0]], usedModelId: fallback.id },
		{ candidates: [primary], missingRefs: [DEFAULT_CLASSIFIER_CANDIDATE_REFS[1]], usedModelId: primary.id },
	])("reports successful fallback or reduced availability: $usedModelId", ({
		candidates,
		missingRefs,
		usedModelId,
	}) => {
		expect(classifierHealth({ ...healthy, usedModelId }, candidates, missingRefs)).toMatchObject({
			channel: PERMISSION_EVENTS.CLASSIFIER_DEGRADED,
			notifyKey: PERMISSION_EVENTS.CLASSIFIER_DEGRADED,
			payload: { usedModelId, missingRefs },
		})
	})

	it("reports only unavailable when all models are missing", () => {
		expect(
			classifierHealth(
				{ ...healthy, ok: false, usedModelId: undefined, failureCode: "no_candidates" },
				[],
				[...DEFAULT_CLASSIFIER_CANDIDATE_REFS],
			),
		).toMatchObject({
			channel: PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE,
			payload: { failureCode: "no_candidates", missingRefs: [...DEFAULT_CLASSIFIER_CANDIDATE_REFS] },
		})
	})

	it("does not label cancellation as an outage", () => {
		expect(classifierHealth({ ...healthy, ok: false, failureCode: "aborted" }, [], [])).toBeUndefined()
		const controller = new AbortController()
		controller.abort()
		expect(classifierHealth({ ...healthy, ok: false }, [], [], controller.signal)).toBeUndefined()
	})

	it.each<ClassifierFailureCode>([
		"no_api_key",
		"provider_error",
		"invalid_output",
		"auth_unavailable",
		"auth_timeout",
		"timeout",
		"budget_exhausted",
	])("never emits diagnostics containing secrets for %s", (failureCode) => {
		const health = classifierHealth(
			{ ...healthy, ok: false, reason: "SENTINEL_SECRET", failureCode },
			[primary],
			[DEFAULT_CLASSIFIER_CANDIDATE_REFS[1]],
		)
		expect(health?.payload).toEqual({ failureCode, missingRefs: [DEFAULT_CLASSIFIER_CANDIDATE_REFS[1]] })
		expect(JSON.stringify(health)).not.toContain("SENTINEL_SECRET")
	})

	it("selects actionable copy for no_api_key and generic copy otherwise", () => {
		const noKey = classifierHealth({ ...healthy, ok: false, failureCode: "no_api_key" }, [primary], [])
		expect(noKey?.message).toContain("KIMCHI_API_KEY")
		expect(noKey?.notifyKey).toBe(`${PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE}:no_api_key`)
		const other = classifierHealth({ ...healthy, ok: false, failureCode: "provider_error" }, [primary], [])
		expect(other?.message).not.toContain("KIMCHI_API_KEY")
		expect(other?.notifyKey).toBe(PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE)
		expect(other?.message).toBe(
			"Permissions classifier unavailable. Calls requiring classification need confirmation or are blocked without a UI.",
		)
	})
})
