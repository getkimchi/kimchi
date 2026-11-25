import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { ReviewCoverage } from "../review-submit/store.js"
import type { ResolvedReviewTarget } from "../review-targets/types.js"
import {
	isReviewLensId,
	type RequiredReviewLens,
	type ResolvedReviewPanel,
	type ReviewLensId,
	type ReviewPanelArguments,
} from "./lenses.js"
import { reviewPanelPaths, writeReviewJson } from "./output.js"
import {
	REVIEW_PANEL_STATE_VERSION,
	type ReviewPanelIdentity,
	type ReviewPanelPhase,
	type ReviewPanelProgress,
	type ReviewPanelRunState,
} from "./types.js"

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertState(value: unknown): asserts value is ReviewPanelRunState {
	if (!object(value) || value.schema_version !== REVIEW_PANEL_STATE_VERSION) {
		throw new Error(`Review panel state must use ${REVIEW_PANEL_STATE_VERSION}.`)
	}
	if (!object(value.scope) || !object(value.scope.pinned)) throw new Error("Review panel state has no pinned scope.")
	for (const field of ["checkoutPath", "contextDir"] as const) {
		if (typeof value.scope[field] !== "string" || !value.scope[field]) {
			throw new Error(`Review panel state has no scope.${field}.`)
		}
	}
	for (const field of ["baseSha", "headSha"] as const) {
		if (typeof value.scope.pinned[field] !== "string" || !value.scope.pinned[field]) {
			throw new Error(`Review panel state has no pinned ${field}.`)
		}
	}
	for (const field of ["contextDir", "outputDir"] as const) {
		if (typeof value[field] !== "string" || !value[field]) throw new Error(`Review panel state has no ${field}.`)
	}
	if (!object(value.panel) || !Array.isArray(value.lenses) || !Array.isArray(value.candidates)) {
		throw new Error("Review panel state has no panel configuration, lenses, or candidates.")
	}
	if (!Array.isArray(value.panel.requiredLenses) || !Array.isArray(value.panel.resolved)) {
		throw new Error("Review panel state has no resolved lens metadata.")
	}
	const configured = new Set<ReviewLensId>()
	for (const lens of value.lenses) {
		if (!object(lens)) throw new Error("Review panel state has an invalid lens.")
		const lensId = String(lens.id)
		if (!isReviewLensId(lensId) || configured.has(lensId)) {
			throw new Error("Review panel state has an invalid or duplicate lens.")
		}
		if (!["queued", "running", "submitted", "failed", "cancelled"].includes(String(lens.status))) {
			throw new Error(`Review panel lens ${lens.id} has an invalid status.`)
		}
		if (!Array.isArray(lens.candidateIds) || !Array.isArray(lens.reasons)) {
			throw new Error(`Review panel lens ${lens.id} has no reasons or candidate list.`)
		}
		configured.add(lensId)
	}
	const ids = new Set<string>()
	for (const candidate of value.candidates) {
		if (!object(candidate) || typeof candidate.id !== "string" || ids.has(candidate.id)) {
			throw new Error("Review panel state has an invalid or duplicate candidate ID.")
		}
		const lensId = String(candidate.lens)
		if (!isReviewLensId(lensId) || !configured.has(lensId) || !object(candidate.finding)) {
			throw new Error(`Review panel candidate ${candidate.id} has no valid source lens or finding.`)
		}
		if (candidate.finding.id !== candidate.id || candidate.finding.writer !== candidate.lens) {
			throw new Error(`Review panel candidate ${candidate.id} has an inconsistent writer identity.`)
		}
		ids.add(candidate.id)
	}
	if (
		!object(value.reconciliation) ||
		!["pending", "fallback", "reconciled"].includes(String(value.reconciliation.status))
	) {
		throw new Error("Review panel state has invalid reconciliation metadata.")
	}
	if (!object(value.coverage)) throw new Error("Review panel state has no coverage.")
}

// A separate coverage check keeps the large structural assertion readable.
function assertCoverage(coverage: ReviewCoverage): void {
	if (
		(coverage.status !== "complete" && coverage.status !== "partial") ||
		!Array.isArray(coverage.unfinished_lenses) ||
		!coverage.unfinished_lenses.every((lens) => typeof lens === "string")
	) {
		throw new Error("Review panel state has invalid coverage.")
	}
	for (const field of [
		"selected_lenses",
		"submitted_lenses",
		"failed_lenses",
		"cancelled_lenses",
		"candidate_count",
		"final_finding_count",
		"provenance_truncated_count",
	] as const) {
		if (!Number.isSafeInteger(coverage[field]) || coverage[field] < 0) {
			throw new Error(`Review panel coverage has an invalid ${field}.`)
		}
	}
}

export function coverageFor(state: ReviewPanelRunState, finalFindingCount: number): ReviewCoverage {
	const count = (status: ReviewPanelRunState["lenses"][number]["status"]) =>
		state.lenses.filter((lens) => lens.status === status).length
	const unfinished = state.lenses.filter((lens) => lens.status !== "submitted").map((lens) => lens.id)
	return {
		status: unfinished.length === 0 ? "complete" : "partial",
		unfinished_lenses: unfinished,
		selected_lenses: state.lenses.length,
		submitted_lenses: count("submitted"),
		failed_lenses: count("failed"),
		cancelled_lenses: count("cancelled"),
		candidate_count: state.candidates.length,
		final_finding_count: finalFindingCount,
		provenance_truncated_count: state.reconciliation.provenanceTruncatedCount ?? 0,
	}
}

export function progressFor(state: ReviewPanelRunState, phase: ReviewPanelPhase): ReviewPanelProgress {
	return {
		phase,
		lenses: state.lenses.map((lens) => ({
			id: lens.id,
			writer: lens.writer,
			status: lens.status,
			reasons: [...lens.reasons],
			candidateCount: lens.candidateIds.length,
			...(lens.error === undefined ? {} : { error: lens.error }),
		})),
		counts: {
			queued: state.lenses.filter((lens) => lens.status === "queued").length,
			running: state.lenses.filter((lens) => lens.status === "running").length,
			submitted: state.lenses.filter((lens) => lens.status === "submitted").length,
			failed: state.lenses.filter((lens) => lens.status === "failed").length,
			cancelled: state.lenses.filter((lens) => lens.status === "cancelled").length,
			candidates: state.candidates.length,
		},
		coverage: structuredClone(state.coverage),
		reconciliation: { status: state.reconciliation.status, reason: state.reconciliation.reason },
	}
}

export function createInitialPanelState(
	target: ResolvedReviewTarget,
	selection: ResolvedReviewPanel,
	args: ReviewPanelArguments,
	requiredLenses: readonly RequiredReviewLens[],
	outputDir: string,
): ReviewPanelRunState {
	return {
		schema_version: REVIEW_PANEL_STATE_VERSION,
		scope: structuredClone(target.scope),
		contextDir: target.scope.contextDir,
		outputDir: resolve(outputDir),
		panel: {
			lenses: [...args.lenses],
			all: args.all,
			concurrency: args.concurrency,
			resolved: selection.lenses.map((lens) => structuredClone(lens)),
			requestedConcurrency: selection.requestedConcurrency,
			slotCount: selection.slotCount,
			requiredLenses: requiredLenses.map((lens) => ({ ...lens })),
		},
		lenses: selection.lenses.map((lens) => ({
			id: lens.id,
			writer: lens.writer,
			status: "queued",
			reasons: [...lens.reasons],
			candidateIds: [],
		})),
		candidates: [],
		reconciliation: {
			status: "pending",
			reason: "Waiting for reviewer candidates.",
			provenance: {},
			provenanceTruncatedCount: 0,
		},
		coverage: {
			status: "partial",
			unfinished_lenses: selection.lenses.map((lens) => lens.id),
			selected_lenses: selection.lenses.length,
			submitted_lenses: 0,
			failed_lenses: 0,
			cancelled_lenses: 0,
			candidate_count: 0,
			final_finding_count: 0,
			provenance_truncated_count: 0,
		},
	}
}

export async function loadReviewPanelState(outputDir: string): Promise<ReviewPanelRunState> {
	const value: unknown = JSON.parse(await readFile(reviewPanelPaths(outputDir).statePath, "utf8"))
	assertState(value)
	assertCoverage(value.coverage)
	return value
}

export function assertReviewPanelIdentity(state: ReviewPanelRunState, expected: ReviewPanelIdentity | undefined): void {
	if (!expected) return
	const actual: ReviewPanelIdentity = {
		baseSha: state.scope.pinned.baseSha,
		headSha: state.scope.pinned.headSha,
		checkoutPath: state.scope.checkoutPath,
		contextDir: state.contextDir,
		outputDir: state.outputDir,
	}
	for (const [field, expectedValue] of Object.entries(expected) as Array<[keyof ReviewPanelIdentity, string]>) {
		const matches =
			field === "baseSha" || field === "headSha"
				? actual[field] === expectedValue
				: resolve(actual[field]) === resolve(expectedValue)
		if (!matches) {
			throw new Error(
				`Review wrap-up identity mismatch for ${field}: expected ${expectedValue}, found ${actual[field]}.`,
			)
		}
	}
}

export class ReviewPanelStateStore {
	private tail: Promise<void> = Promise.resolve()
	private closed = false

	private constructor(
		private current: ReviewPanelRunState,
		private readonly path: string,
		private readonly onChange?: (state: ReviewPanelRunState) => void,
	) {}

	static async create(
		state: ReviewPanelRunState,
		outputDir: string,
		onChange?: (state: ReviewPanelRunState) => void,
	): Promise<ReviewPanelStateStore> {
		await writeReviewJson(reviewPanelPaths(outputDir).statePath, state)
		return new ReviewPanelStateStore(state, reviewPanelPaths(outputDir).statePath, onChange)
	}

	static async load(
		outputDir: string,
		onChange?: (state: ReviewPanelRunState) => void,
	): Promise<ReviewPanelStateStore> {
		return new ReviewPanelStateStore(
			await loadReviewPanelState(outputDir),
			reviewPanelPaths(outputDir).statePath,
			onChange,
		)
	}

	get state(): ReviewPanelRunState {
		return this.current
	}

	get isClosed(): boolean {
		return this.closed
	}

	/** Stop coordinator-owned mutations before returning an abandoned panel.
	 * Existing queued work drains once, then every later update is a no-op.
	 * A fresh wrap-up receives a separately opened store instance. */
	async close(): Promise<void> {
		this.closed = true
		await this.tail
	}

	update(mutator: (state: ReviewPanelRunState) => void): Promise<ReviewPanelRunState> {
		const operation = this.tail
			.catch(() => {})
			.then(async () => {
				if (this.closed) return this.current
				const next = structuredClone(this.current)
				mutator(next)
				assertState(next)
				assertCoverage(next.coverage)
				await writeReviewJson(this.path, next)
				this.current = next
				this.onChange?.(next)
				return next
			})
		this.tail = operation.then(
			() => {},
			() => {},
		)
		return operation
	}

	async idle(): Promise<void> {
		await this.tail
	}
}
