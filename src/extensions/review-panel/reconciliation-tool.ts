import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { REVIEW_RECONCILIATION_VERSION, type SemanticReconciliation } from "./types.js"

export const REVIEW_RECONCILIATION_TOOL = "submit_reconciliation"

const severity = Type.Union([Type.Literal("critical"), Type.Literal("warning"), Type.Literal("info")])
const verdict = Type.Union([
	Type.Literal("fixed"),
	Type.Literal("not_fixed"),
	Type.Literal("partially_fixed"),
	Type.Literal("no_longer_applicable"),
	Type.Literal("regressed"),
	Type.Literal("unverified"),
])
const evidenceKind = Type.Union([
	Type.Literal("code_reference"),
	Type.Literal("existing_test"),
	Type.Literal("new_test"),
	Type.Literal("none"),
])

export interface ReconciliationSubmissionBridge {
	value?: SemanticReconciliation
}

/** Result-only schema guidance. The tool never writes an artifact; the panel's
 * strict validator and atomic publication boundary remain authoritative. */
export function createReconciliationSubmissionExtension(
	bridge: ReconciliationSubmissionBridge,
): (pi: ExtensionAPI) => void {
	return function registerReconciliationSubmission(pi: ExtensionAPI): void {
		pi.registerTool({
			name: REVIEW_RECONCILIATION_TOOL,
			label: "Submit Reconciliation Result",
			description:
				"Return the completed semantic reconciliation as structured fields. The coordinator strictly validates and publishes it. Use this tool exactly once instead of describing the result in prose or emitting ad-hoc JSON fields.",
			parameters: Type.Object(
				{
					schema_version: Type.Literal(REVIEW_RECONCILIATION_VERSION),
					findings: Type.Array(
						Type.Object(
							{
								id: Type.String(),
								path: Type.String(),
								line: Type.Integer({ minimum: 1 }),
								severity,
								type: Type.String(),
								description: Type.String(),
								suggestion: Type.String(),
								candidate_ids: Type.Array(Type.String(), { minItems: 1 }),
							},
							{ additionalProperties: false },
						),
					),
					decisions: Type.Array(
						Type.Object(
							{
								candidate_id: Type.String(),
								disposition: Type.Union([Type.Literal("retained"), Type.Literal("merged"), Type.Literal("rejected")]),
								finding: Type.Optional(Type.String()),
								reason: Type.String(),
							},
							{ additionalProperties: false },
						),
					),
					threads: Type.Array(
						Type.Object(
							{
								thread_id: Type.String(),
								body: Type.String(),
								action: Type.Union([Type.Literal("resolve"), Type.Literal("reopen"), Type.Literal("none")]),
								verdict: Type.Optional(verdict),
								evidence_kind: Type.Optional(evidenceKind),
								evidence: Type.Optional(Type.String()),
								equivalent_candidate_ids: Type.Optional(Type.Array(Type.String())),
							},
							{ additionalProperties: false },
						),
					),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params) {
				bridge.value = params
				return {
					content: [{ type: "text", text: "Structured reconciliation submitted for coordinator validation." }],
					details: { schema_version: REVIEW_RECONCILIATION_VERSION },
				}
			},
		})
	}
}
