import type { VerifierRequirement } from "../../../../src/extensions/ferment-v2/requirements.js"
import type { FakeResponseRequest, FakeResponseScript } from "./fake-openai-server.js"

export function isVerifierRequest(request: FakeResponseRequest): boolean {
	return (
		request.url.startsWith("/openai/v1/chat/completions") &&
		JSON.stringify(request.body).includes("<ferment_v2_verifier>")
	)
}

export function isImplementerRequest(request: FakeResponseRequest): boolean {
	return (
		request.url.startsWith("/openai/v1/chat/completions") &&
		!isVerifierRequest(request) &&
		!isRequirementsDraftRequest(request)
	)
}

/** A tool-accepted draft must precede the first implementer request anywhere in the trace. */
export function draftPrecedesImplementation(requests: readonly FakeResponseRequest[]): boolean {
	const firstImplementer = requests.findIndex(isImplementerRequest)
	const acceptedDraft = requests.findIndex((request) => {
		if (!isRequirementsDraftRequest(request) || request.body === null || typeof request.body !== "object") return false
		const messages = Reflect.get(request.body, "messages")
		return (
			Array.isArray(messages) &&
			messages.some(
				(message) =>
					message?.role === "tool" && JSON.stringify(message.content).includes("Draft requirements recorded."),
			)
		)
	})
	return acceptedDraft >= 0 && firstImplementer > acceptedDraft
}

/**
 * The evaluator session's initial requirements turn: before it recorded its own
 * list (legacy) and before it acknowledged the persisted contract (seeded).
 */
export function isRequirementsRequest(request: FakeResponseRequest): boolean {
	return (
		isVerifierRequest(request) &&
		!JSON.stringify(request.body).includes("Requirements recorded (revision") &&
		!JSON.stringify(request.body).includes("Persisted requirements contract acknowledged")
	)
}

export function verifierRequirements(
	requirement: string | VerifierRequirement[],
	category: VerifierRequirement["category"] = "behavior",
): FakeResponseScript {
	return {
		match: isRequirementsRequest,
		toolCalls: [
			{
				id: "record-requirements",
				function: {
					name: "record_requirements",
					arguments: JSON.stringify({
						requirements:
							typeof requirement === "string"
								? [{ id: "r1", requirement, source: `Objective: ${requirement}`, acceptance: requirement, category }]
								: requirement,
					}),
				},
			},
		],
	}
}

/** The source-only requirements drafter's request (before any candidate exists). */
export function isRequirementsDraftRequest(request: FakeResponseRequest): boolean {
	return (
		request.url.startsWith("/openai/v1/chat/completions") &&
		JSON.stringify(request.body).includes("<ferment_v2_requirements_draft>")
	)
}

/**
 * The drafter records the complete initial list through record_requirements.
 * Pass the exact items the seeded verifier must later acknowledge.
 */
export function draftRequirements(requirements: VerifierRequirement[]): FakeResponseScript {
	return {
		match: isRequirementsDraftRequest,
		toolCalls: [
			{
				id: "draft-requirements",
				function: {
					name: "record_requirements",
					arguments: JSON.stringify({ requirements }),
				},
			},
		],
	}
}
