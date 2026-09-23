/**
 * Plannotator-backed interactive browser review for the remote-run
 * completion menu.
 *
 * Replaces kimchi's self-hosted diff review (the retired ui/review-server.ts
 * + ui/diff-html.ts pair): instead of serving our own HTML page and
 * collecting the decision via a loopback POST, we hand the persisted patch
 * file to plannotator over the shared Pi event bus (`plannotator:request`,
 * action `code-review`, payload `patchFile`) and translate its decision back
 * into the menu's ReviewDecision vocabulary.
 *
 * Contract (plannotator pi-extension ≥0.27, plannotator-events.ts): each
 * emit's `respond` callback fires exactly once and only AFTER the human
 * settles the browser session — an explicit decision or exit. A bare tab
 * close NEVER fires it (the code-review gate has no client-lease tracker,
 * unlike plannotator's annotate gate), so the completion menu races this
 * promise against its open selector rather than blocking on it
 * (post-completion.ts). Plannotator hosts and closes its own review UI and
 * opens the browser itself — kimchi never touches a socket or browser here.
 *
 * Presence gating: unlike the fire-and-forget code-review emit used after
 * "push & pull locally" (post-completion.ts), this call BLOCKS on a human
 * decision — with no plannotator listener nobody ever answers and the menu
 * would hang. isPlannotatorReviewAvailable() probes the slash-command
 * registry for `/plannotator-review` up front so the menu can refuse
 * honestly instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request"
const PLANNOTATOR_REVIEW_COMMAND = "plannotator-review"

/** Unique id per emit so concurrent plannotator sessions never cross answers. */
export function newPlannotatorRequestId(): string {
	return `kimchi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export interface ReviewComment {
	file?: string
	line?: number
	side?: "old" | "new"
	code?: string
	text: string
}

export type ReviewDecision =
	| { kind: "approve" }
	| { kind: "request-changes"; summary?: string; comments: ReviewComment[] }
	| { kind: "closed" } // reviewer dismissed the session — return to the menu

export type PlannotatorReviewOutcome =
	| { outcome: "decision"; decision: ReviewDecision }
	| { outcome: "error"; message: string }

/** True when a loaded extension registered plannotator's `/plannotator-review` command. */
export function isPlannotatorReviewAvailable(pi: ExtensionAPI): boolean {
	return pi.getCommands().some((command) => command.name === PLANNOTATOR_REVIEW_COMMAND)
}

/**
 * Emits the static-patch code-review request and resolves on the human's
 * decision. `patchFile` is read by plannotator at request time and resolved
 * against `cwd` (absolute paths pass through verbatim).
 */
export function requestPlannotatorCodeReview(
	pi: ExtensionAPI,
	opts: { cwd: string; patchFile: string },
): Promise<PlannotatorReviewOutcome> {
	return new Promise((resolve) => {
		pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
			requestId: newPlannotatorRequestId(),
			action: "code-review",
			payload: { cwd: opts.cwd, patchFile: opts.patchFile },
			respond: (response: unknown) => resolve(mapPlannotatorResponse(response)),
		})
	})
}

/**
 * plannotator:request response → menu decision. Plannotator's decision
 * contract (server/serverReview.ts): `exit` → closed; `approved` → approve
 * (notes on an approval ride along as guidance, never a change request);
 * denied with feedback text and/or per-line annotations → request-changes
 * steered by both (a blank summary gets a fallback so the steer carries
 * text); denied with neither → closed (a bare dismissal).
 */
function mapPlannotatorResponse(response: unknown): PlannotatorReviewOutcome {
	if (!isRecord(response)) {
		return { outcome: "error", message: "plannotator returned a malformed response" }
	}
	if (response.status !== "handled") {
		const detail =
			typeof response.error === "string" && response.error.trim() ? response.error.trim() : String(response.status)
		return { outcome: "error", message: detail }
	}
	if (!isRecord(response.result)) {
		return { outcome: "error", message: "plannotator returned no review result" }
	}
	const result = response.result
	if (result.exit === true) return { outcome: "decision", decision: { kind: "closed" } }
	if (result.approved === true) return { outcome: "decision", decision: { kind: "approve" } }
	const feedback = typeof result.feedback === "string" ? result.feedback.trim() : ""
	const annotations = Array.isArray(result.annotations) ? result.annotations : []
	const comments = annotations.map(mapAnnotation).filter((c): c is ReviewComment => c !== undefined)
	if (feedback || comments.length > 0) {
		return {
			outcome: "decision",
			decision: { kind: "request-changes", summary: feedback || "Review feedback from browser", comments },
		}
	}
	return { outcome: "decision", decision: { kind: "closed" } }
}

/**
 * Best-effort plannotator annotation → ReviewComment. The decision payload
 * types annotations as unknown[] (server/serverReview.ts); the review UI's
 * CodeAnnotation carries filePath/lineStart/side/text (+originalCode etc.),
 * but unknown shapes and missing fields are tolerated — an annotation with
 * no usable text is dropped (there is nothing for the agent to act on).
 */
function mapAnnotation(annotation: unknown): ReviewComment | undefined {
	if (!isRecord(annotation)) return undefined
	const text = stringField(annotation.text) ?? stringField(annotation.comment)
	if (!text) return undefined
	const comment: ReviewComment = { text }
	const file = stringField(annotation.filePath) ?? stringField(annotation.file)
	if (file) comment.file = file
	const line = numberField(annotation.lineStart) ?? numberField(annotation.line)
	if (line !== undefined) comment.line = line
	if (annotation.side === "old" || annotation.side === "new") comment.side = annotation.side
	const code =
		stringField(annotation.originalCode) ?? stringField(annotation.code) ?? stringField(annotation.suggestedCode)
	if (code) comment.code = code
	return comment
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}
