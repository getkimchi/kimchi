/**
 * Pending scoping-proposal persistence — disk-backed sidecar for the
 * in-memory `pendingScope` / `pendingPlanReview` state that drives the
 * interactive (TUI) plan-review flow.
 *
 * What's persisted (per ferment, at `.kimchi/ferments/{fermentId}/pending-proposal.json`):
 *   - the full proposed plan payload (title, goal, successCriteria, constraints,
 *     assumptions, phases, planMarkdown) plus the proposeIterations counter
 *     and a savedAt timestamp.
 *
 * Why a sidecar and not an event: pending proposals are transient runtime
 * state — the plan has NOT been confirmed yet. Adding them to the immutable
 * FermentEvent stream would pollute the domain log with unconfirmed drafts.
 * This mirrors `runtime-state-store.ts` (temp + rename atomic write, silent
 * failure via `onError`, schemaVersion field) for the same reasons.
 *
 * Lifecycle:
 *   - written by `propose_ferment_scoping` when arming the deferred plan
 *     review (zero-questions, interactive/TUI path only)
 *   - read by `resumeFerment` to re-arm the review dialog across a session
 *     restart instead of re-nudging the LLM to re-scope
 *   - deleted by `confirmPendingScope` (confirm) and the cancelled branch of
 *     `runPendingPlanReview` (cancel). NOT deleted by `session_shutdown`,
 *     which only clears the in-memory plan-review map — the disk file must
 *     survive so a later resume can re-arm the review.
 *
 * `loadPendingProposal` returns `undefined` (not an empty default) on missing
 * file, corrupted JSON, or schema mismatch, because the absence of a pending
 * proposal is meaningful: it tells `resumeFerment` to fall through to the
 * existing scoping-nudge behavior.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import { resolveFermentsDir } from "../../ferment/store.js"

export const PENDING_PROPOSAL_SCHEMA_VERSION = 1

export interface PendingProposalData {
	schemaVersion: typeof PENDING_PROPOSAL_SCHEMA_VERSION
	fermentId: string
	title: string
	goal: string
	successCriteria: string[]
	constraints: string[]
	assumptions: string
	phases: ScopePhaseInput[]
	planMarkdown: string
	proposeIterations: number
	savedAt: string
}

function fermentSidecarDir(fermentId: string, root?: string): string {
	const base = root ?? resolveFermentsDir()
	return resolve(base, fermentId)
}

function pendingProposalPath(fermentId: string, root?: string): string {
	return resolve(fermentSidecarDir(fermentId, root), "pending-proposal.json")
}

/**
 * Read the persisted pending scoping proposal for a ferment.
 *
 * Returns `undefined` (NOT an empty default) when the file is missing,
 * unparseable, or carries a mismatched `schemaVersion`. The undefined return
 * is the signal to `resumeFerment` that there is no pending review to
 * re-arm — it must fall through to the existing scoping-nudge behavior.
 * Failures are intentionally silent so corruption cannot crash the hot path.
 */
export function loadPendingProposal(fermentId: string, root?: string): PendingProposalData | undefined {
	const path = pendingProposalPath(fermentId, root)
	if (!existsSync(path)) return undefined
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<PendingProposalData>
		if (raw.schemaVersion !== PENDING_PROPOSAL_SCHEMA_VERSION) return undefined
		// Defensive: the load-bearing fields must be present and correctly
		// typed, otherwise we treat the file as absent rather than risk
		// re-arming a review from a malformed payload.
		if (typeof raw.fermentId !== "string" || raw.fermentId !== fermentId) return undefined
		if (typeof raw.title !== "string") return undefined
		if (typeof raw.goal !== "string") return undefined
		if (!Array.isArray(raw.successCriteria) || !raw.successCriteria.every((x) => typeof x === "string"))
			return undefined
		if (!Array.isArray(raw.constraints) || !raw.constraints.every((x) => typeof x === "string")) return undefined
		if (typeof raw.assumptions !== "string") return undefined
		if (!Array.isArray(raw.phases) || !raw.phases.every((x) => x !== null && typeof x === "object")) return undefined
		if (typeof raw.planMarkdown !== "string") return undefined
		if (typeof raw.proposeIterations !== "number") return undefined
		if (typeof raw.savedAt !== "string") return undefined
		return raw as PendingProposalData
	} catch {
		return undefined
	}
}

/**
 * Atomically write the pending scoping proposal for a ferment. Writes to a
 * temp file then renames over the target so a crash during write cannot
 * leave a truncated file. Best-effort: failures call `onError` if provided
 * and return false; never throw.
 */
export function savePendingProposal(
	fermentId: string,
	data: PendingProposalData,
	options?: { root?: string; onError?: (err: unknown) => void },
): boolean {
	let tmp: string | undefined
	try {
		const dir = fermentSidecarDir(fermentId, options?.root)
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
		const path = pendingProposalPath(fermentId, options?.root)
		tmp = `${path}.tmp.${process.pid}.${Date.now()}`
		writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8")
		renameSync(tmp, path)
		return true
	} catch (err) {
		// Clean up orphaned temp file so failed writes don't accumulate.
		try {
			if (tmp && existsSync(tmp)) unlinkSync(tmp)
		} catch {
			// Ignore — best-effort cleanup.
		}
		options?.onError?.(err)
		return false
	}
}

/**
 * Delete the persisted pending scoping proposal for a ferment. Called when
 * the plan review is confirmed or cancelled. Best-effort — missing file is
 * a no-op; failures are silent so cleanup cannot crash the hot path.
 */
export function deletePendingProposal(fermentId: string, root?: string): void {
	try {
		const path = pendingProposalPath(fermentId, root)
		if (existsSync(path)) unlinkSync(path)
	} catch {
		// Silent — cleanup failures shouldn't propagate.
	}
}
