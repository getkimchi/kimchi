import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { textResult } from "../agents/tool-result.js"

export const RECORD_REQUIREMENTS_TOOL = "record_requirements"
export const REQUIREMENT_CATEGORIES = ["behavior", "constraint", "delivery"] as const

const field = () => Type.String({ minLength: 1, maxLength: 4_000 })
const requirementSchema = Type.Object({
	id: Type.String({ pattern: "^r[1-9][0-9]*$" }),
	requirement: field(),
	source: field(),
	acceptance: field(),
	category: Type.Union(REQUIREMENT_CATEGORIES.map((category) => Type.Literal(category))),
})
const parameters = Type.Object({
	requirements: Type.Array(requirementSchema, { minItems: 1, maxItems: 64 }),
	reason: Type.Optional(field()),
})

export interface VerifierRequirement {
	id: string
	requirement: string
	/** Objective quotation or repository contract establishing the obligation. */
	source: string
	/** Observable condition that would establish satisfaction. */
	acceptance: string
	category: (typeof REQUIREMENT_CATEGORIES)[number]
}

export interface RequirementSnapshot {
	requirements: readonly VerifierRequirement[]
	/** Required for revisions, including additions and removals. */
	reason?: string
}

/** One evaluator session owns the list; the host preserves its history and checks coverage. */
export function createRequirementLedger(validationContext: string) {
	const history: RequirementSnapshot[] = []
	const extension: InlineExtension = (pi) => {
		pi.registerTool(
			defineTool({
				name: RECORD_REQUIREMENTS_TOOL,
				label: "Record Requirements",
				description:
					"Record observable requirements before validating the implementation. Use stable r1, r2, … IDs. Later calls replace the complete list and require a source-grounded reason for every revision. Acceptance continues this same session and supplies implementation context.",
				parameters,
				execute: async (_id, params) => {
					const requirements = params.requirements.map((item) => ({
						id: item.id,
						requirement: item.requirement.trim(),
						source: item.source.trim(),
						acceptance: item.acceptance.trim(),
						category: item.category,
					}))
					const reason = params.reason?.trim()
					if (
						requirements.some((item) => !item.requirement || !item.source || !item.acceptance) ||
						new Set(requirements.map((item) => item.id)).size !== requirements.length
					) {
						return {
							...textResult(
								"Requirements rejected: provide distinct IDs and nonempty requirement, source, and acceptance fields.",
							),
							isError: true,
						}
					}
					const previous = history.at(-1)
					if (previous && JSON.stringify(previous.requirements) === JSON.stringify(requirements)) {
						return textResult("Requirements already recorded. Continue validating them; cite their IDs in your checks.")
					}
					if (previous && !reason) {
						return {
							...textResult(
								"Revision rejected: explain the task or repository evidence requiring this change, including removed requirements. Preserve IDs for unchanged obligations.",
							),
							isError: true,
						}
					}
					history.push({ requirements, ...(reason ? { reason } : {}) })
					return textResult(
						[
							`Requirements recorded (revision ${history.length}). Validate every requirement against its source and acceptance condition. Include requirementId in every final check.`,
							JSON.stringify(requirements),
							...(previous ? [] : [validationContext]),
						].join("\n\n"),
					)
				},
			}),
		)
	}
	return {
		extension,
		history,
		category: (id: string | undefined) => history.at(-1)?.requirements.find((item) => item.id === id)?.category,
		coverageGap(
			checks: readonly { requirementId?: string; category?: string; kind?: string }[] | undefined,
		): string | undefined {
			const current = history.at(-1)?.requirements
			if (!current)
				return "Call record_requirements with the task's sourced acceptance conditions before returning a verdict, then validate them."
			const unknown = checks?.find((check) => !current.some((item) => item.id === check.requirementId))
			const gaps: string[] = []
			if (unknown)
				gaps.push(
					"Every check must reference a current recorded requirement using requirementId; record newly discovered obligations before checking them.",
				)
			const missing = current.filter((item) => !checks?.some((check) => check.requirementId === item.id))
			if (missing.length)
				gaps.push(
					`${missing.map((item) => `Recorded requirement ${item.id} (${item.requirement.slice(0, 120)}) has no outcome.`).join(" ")} Validate every missing requirement and include cited checks.`,
				)
			return gaps.length ? gaps.join(" ") : undefined
		},
	}
}
