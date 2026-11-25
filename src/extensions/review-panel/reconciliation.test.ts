import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	DEFAULT_WRITER_LIMIT,
	FINDING_SCHEMA_VERSION,
	MAX_FINDING_TEXT_BYTES,
	MAX_OUTPUT_FILE_BYTES,
	type ReviewFindingRecord,
} from "../review-submit/store.js"
import type { ResolvedReviewTarget } from "../review-targets/types.js"
import { checkpointReviewPanelFallback, finalizeReviewPanel } from "./finalize.js"
import { type ReviewLensId, resolveReviewPanel } from "./lenses.js"
import { readFinalFindings, readFindingWriter, reviewPanelPaths, serializeFinalFindings } from "./output.js"
import { validateSemanticReconciliation } from "./reconciliation.js"
import { coverageFor, createInitialPanelState, ReviewPanelStateStore } from "./state.js"
import { REVIEW_RECONCILIATION_VERSION, type ReviewPanelCandidate, type SemanticReconciliation } from "./types.js"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

function candidate(
	lens: ReviewLensId,
	seq: number,
	overrides: Partial<ReviewFindingRecord> = {},
): ReviewPanelCandidate {
	const id = `${lens}-${seq}`
	return {
		id,
		lens,
		finding: {
			schema_version: FINDING_SCHEMA_VERSION,
			id,
			writer: lens,
			seq,
			created_at: `2026-11-24T12:00:0${seq % 10}Z`,
			path: "stack.ts",
			line: 10,
			severity: "warning",
			type: "bug",
			description: "A concrete defect with an observed consequence.",
			suggestion: "Apply the corrective guard.",
			...overrides,
		},
	}
}

function target(contextDir: string): ResolvedReviewTarget {
	return {
		scope: {
			kind: "branch",
			refs: { branch: "feature", base: "main", resolvedBase: "main", head: "feature" },
			includeWorkingTree: false,
			baseSource: "explicit",
			pinned: { baseSha: SHA_A, headSha: SHA_B, tipSha: SHA_B },
			headKind: "commit",
			dirty: false,
			files: { changed: 1, anchorable: 1, unanchorable: 0 },
			anchorSource: "local",
			checkoutPath: "/fixture/repository",
			contextDir,
			commentableLinesPath: join(contextDir, "commentable-lines.json"),
			limitations: [],
		},
		cleanup: async () => {},
	}
}

function semantic(
	findings: SemanticReconciliation["findings"],
	candidates: readonly ReviewPanelCandidate[],
	threads: SemanticReconciliation["threads"] = [],
): SemanticReconciliation {
	return {
		schema_version: REVIEW_RECONCILIATION_VERSION,
		findings,
		decisions: candidates.map((entry) => {
			const group = findings.find((finding) => finding.candidate_ids.includes(entry.id))
			return group
				? {
						candidate_id: entry.id,
						disposition: group.candidate_ids.length === 1 ? "retained" : "merged",
						finding: group.id,
						reason: group.candidate_ids.length === 1 ? "Independent finding." : "Same defect and consequence.",
					}
				: {
						candidate_id: entry.id,
						disposition: "rejected",
						reason: "Equivalent to an earlier finding or superseded by current code.",
					}
		}),
		threads,
	}
}

describe("review panel reconciliation and fallback", () => {
	let sandbox: string
	let contextDir: string
	let outputDir: string

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "review-panel-reconciliation-"))
		contextDir = join(sandbox, "review-context")
		outputDir = join(sandbox, "review-output")
		mkdirSync(contextDir, { recursive: true })
		writeFileSync(
			join(contextDir, "commentable-lines.json"),
			JSON.stringify({
				schema_version: "commentable-lines/v1",
				commit_sha: SHA_B,
				merge_base_sha: SHA_A,
				files: { "stack.ts": { ranges: [{ start_line: 10, end_line: 50 }] } },
			}),
		)
	})

	afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

	async function makeStore(candidates: ReviewPanelCandidate[]): Promise<ReviewPanelStateStore> {
		const lenses = [...new Set(candidates.map((entry) => entry.lens))]
		const selected = lenses.length > 0 ? lenses : (["spec"] as ReviewLensId[])
		const selection = resolveReviewPanel({ lenses: selected })
		const state = createInitialPanelState(
			target(contextDir),
			selection,
			{ lenses: selected, all: false, concurrency: 2 },
			[],
			outputDir,
		)
		state.candidates = candidates
		for (const lens of state.lenses) {
			lens.status = "submitted"
			lens.candidateIds = candidates.filter((entry) => entry.lens === lens.id).map((entry) => entry.id)
		}
		state.coverage = coverageFor(state, 0)
		return ReviewPanelStateStore.create(state, outputDir)
	}

	it("merges one defect at different locations and preserves every source ID", async () => {
		const candidates = [
			candidate("spec", 1, { line: 10, description: "Missing authorization exposes the record." }),
			candidate("standards", 1, { line: 14, description: "The same missing check exposes the record." }),
		]
		const output = semantic(
			[
				{
					id: "authorization-defect",
					path: "stack.ts",
					line: 12,
					severity: "critical",
					type: "security",
					description: "The record is reachable without its required authorization check.",
					suggestion: "Enforce authorization before loading the record.",
					candidate_ids: ["spec-1", "standards-1"],
				},
			],
			candidates,
		)
		const validated = await validateSemanticReconciliation(output, candidates, {
			writer: "final",
			contextDir,
			outputDir,
		})
		expect(validated.findings).toHaveLength(1)
		expect(validated.findings[0]).toMatchObject({
			id: "final-1",
			seq: 1,
			path: "stack.ts",
			line: 12,
			derived_from: ["spec-1", "standards-1"],
		})
		expect(validated.findings[0]).not.toHaveProperty("candidate_ids")
	})

	it("keeps distinct defects on the same line separate", async () => {
		const candidates = [
			candidate("spec", 1, { description: "The return value is wrong.", severity: "warning" }),
			candidate("security", 1, {
				description: "The same line leaks a secret.",
				severity: "critical",
				type: "security",
			}),
		]
		const output = semantic(
			candidates.map((entry, index) => ({
				id: `distinct-${index}`,
				path: entry.finding.path,
				line: entry.finding.line,
				severity: entry.finding.severity as "critical" | "warning",
				type: entry.finding.type,
				description: entry.finding.description,
				suggestion: entry.finding.suggestion,
				candidate_ids: [entry.id],
			})),
			candidates,
		)
		const validated = await validateSemanticReconciliation(output, candidates, {
			writer: "final",
			contextDir,
			outputDir,
		})
		expect(validated.findings).toHaveLength(2)
		expect(validated.findings.map((finding) => finding.description)).toEqual([
			"The same line leaks a secret.",
			"The return value is wrong.",
		])
	})

	it("keeps fallback output and records why invalid reconciliation was rejected", async () => {
		const candidates = [candidate("spec", 1), candidate("standards", 1, { description: "Another independent defect." })]
		const store = await makeStore(candidates)
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		const before = readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")
		const result = await finalizeReviewPanel({
			store,
			outputDir,
			contextDir,
			hasVerifier: true,
			reconcile: async () =>
				JSON.stringify({ schema_version: REVIEW_RECONCILIATION_VERSION, findings: [], decisions: [], threads: [] }),
		})
		expect(readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")).toBe(before)
		expect(result.findings).toHaveLength(2)
		expect(result.state.reconciliation).toMatchObject({ status: "fallback", inputDigest: expect.any(String) })
		expect(result.state.reconciliation.reason).toContain("fallback retained")
		expect(result.summary.coverage).toMatchObject({ status: "complete", unfinished_lenses: [] })
		expect(result.summary.body).not.toContain("time limit")
	})

	it("retains fallback when cached semantic output fails validation during recovery", async () => {
		const candidates = [candidate("spec", 1)]
		const store = await makeStore(candidates)
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		const before = readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")
		await store.update((state) => {
			state.reconciliation = {
				status: "reconciled",
				reason: "Previously accepted output.",
				inputDigest: state.reconciliation.inputDigest,
				semantic: { schema_version: REVIEW_RECONCILIATION_VERSION, findings: [], decisions: [], threads: [] },
			}
		})
		const result = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")).toBe(before)
		expect(result.findings).toHaveLength(1)
		expect(result.state.reconciliation.status).toBe("fallback")
		expect(result.state.reconciliation.reason).toContain("Cached semantic reconciliation failed validation")
	})

	it("rejects a symlinked final checkpoint", async () => {
		const finalPath = reviewPanelPaths(outputDir).findingsPath
		const targetPath = join(sandbox, "linked-final.jsonl")
		mkdirSync(join(outputDir, "findings"), { recursive: true })
		writeFileSync(
			targetPath,
			serializeFinalFindings([{ ...candidate("spec", 1).finding, id: "final-1", writer: "final" }]),
		)
		symlinkSync(targetPath, finalPath)
		await expect(readFinalFindings(finalPath)).rejects.toThrow("is not a regular final findings file")
	})

	it("rejects a directory in place of the final checkpoint", async () => {
		const finalPath = reviewPanelPaths(outputDir).findingsPath
		mkdirSync(finalPath, { recursive: true })
		await expect(readFinalFindings(finalPath)).rejects.toThrow("is not a regular final findings file")
	})

	it("rejects an oversized final checkpoint before parsing it", async () => {
		const finalPath = reviewPanelPaths(outputDir).findingsPath
		mkdirSync(join(outputDir, "findings"), { recursive: true })
		writeFileSync(finalPath, Buffer.alloc(MAX_OUTPUT_FILE_BYTES + 1))
		await expect(readFinalFindings(finalPath)).rejects.toThrow("exceeds the 1 MiB final findings limit")
	})

	it("accepts finalization paths with trailing separators", async () => {
		const store = await makeStore([])
		const result = await finalizeReviewPanel({
			store,
			outputDir: `${outputDir}/`,
			contextDir: `${contextDir}/`,
			hasVerifier: false,
		})
		expect(result.summary.coverage).toMatchObject({ status: "complete", final_finding_count: 0 })
	})

	it("accepts symlink aliases for finalization paths", async () => {
		const outputAlias = join(sandbox, "output-alias")
		const contextAlias = join(sandbox, "context-alias")
		symlinkSync(outputDir, outputAlias, "dir")
		symlinkSync(contextDir, contextAlias, "dir")
		const store = await makeStore([])
		const result = await finalizeReviewPanel({
			store,
			outputDir: outputAlias,
			contextDir: contextAlias,
			hasVerifier: false,
		})
		expect(result.summary.coverage).toMatchObject({ status: "complete", final_finding_count: 0 })
		expect(result.findingsPath).toBe(reviewPanelPaths(outputDir).findingsPath)
	})

	it("rejects finalization paths that disagree with saved panel state", async () => {
		const store = await makeStore([])
		const otherOutputDir = join(sandbox, "other-output")
		await expect(
			finalizeReviewPanel({ store, outputDir: otherOutputDir, contextDir, hasVerifier: false }),
		).rejects.toThrow("outputDir does not match saved panel state")
		expect(existsSync(reviewPanelPaths(otherOutputDir).findingsPath)).toBe(false)

		await expect(
			finalizeReviewPanel({ store, outputDir, contextDir: join(sandbox, "other-context"), hasVerifier: false }),
		).rejects.toThrow("contextDir does not match saved panel state")
		expect(existsSync(reviewPanelPaths(outputDir).findingsPath)).toBe(false)
	})

	it("rejects an anchor created only in a reviewer temporary test", async () => {
		mkdirSync(join(outputDir, "findings"), { recursive: true })
		const finding = candidate("spec", 1, { path: "reviewer-created.test.ts", line: 1 }).finding
		writeFileSync(join(outputDir, "findings", "spec.jsonl"), `${JSON.stringify(finding)}\n`)
		await expect(
			readFindingWriter(join(outputDir, "findings", "spec.jsonl"), "spec", {
				writer: "final",
				contextDir,
				outputDir,
			}),
		).rejects.toThrow("outside_provider_diff")
	})

	it("updates fallback as candidates arrive, collapses exact duplicates, limits output, and assigns rank seq", async () => {
		const duplicateA = candidate("spec", 1, { description: "Exact duplicate." })
		const duplicateB = candidate("standards", 1, { description: "Exact duplicate." })
		const store = await makeStore([duplicateA, duplicateB])
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		let findings = await readFinalFindings(reviewPanelPaths(outputDir).findingsPath)
		expect(findings).toHaveLength(1)
		expect(findings[0].derived_from).toEqual(["spec-1", "standards-1"])

		const critical = candidate("spec", 2, { description: "Higher rank.", severity: "critical", line: 40 })
		await store.update((state) => {
			state.candidates.push(critical)
			state.coverage = coverageFor(state, 1)
		})
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		findings = await readFinalFindings(reviewPanelPaths(outputDir).findingsPath)
		expect(findings.map((finding) => [finding.id, finding.seq, finding.severity])).toEqual([
			["final-1", 1, "critical"],
			["final-2", 2, "warning"],
		])

		await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		const first = readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")
		await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")).toBe(first)
	})

	it("enforces the 50-finding, field-size, and 1 MiB checkpoint limits", async () => {
		const candidates = Array.from({ length: 55 }, (_, index) =>
			candidate(index % 2 === 0 ? "spec" : "standards", index + 1, {
				line: 10 + (index % 40),
				description: `${String(index).padStart(2, "0")}-${"d".repeat(MAX_FINDING_TEXT_BYTES - 3)}`,
				suggestion: "s".repeat(MAX_FINDING_TEXT_BYTES),
			}),
		)
		const store = await makeStore(candidates)
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		const final = await readFinalFindings(reviewPanelPaths(outputDir).findingsPath)
		expect(candidates).toHaveLength(55)
		expect(final.length).toBeLessThanOrEqual(DEFAULT_WRITER_LIMIT)
		expect(final.length).toBeLessThan(50)
		expect(Buffer.byteLength(serializeFinalFindings(final))).toBeLessThanOrEqual(MAX_OUTPUT_FILE_BYTES)
		for (const finding of final) {
			expect(Buffer.byteLength(finding.description)).toBeLessThanOrEqual(MAX_FINDING_TEXT_BYTES)
			expect(Buffer.byteLength(finding.suggestion)).toBeLessThanOrEqual(MAX_FINDING_TEXT_BYTES)
		}
	})

	it.each([
		{ name: "single-candidate", lensCount: 2, groupSize: 1, disposition: "retained" as const },
		{ name: "multi-candidate", lensCount: 3, groupSize: 2, disposition: "merged" as const },
	])("rejects an omitted $name finding member with exact bidirectional accounting", async ({
		lensCount,
		groupSize,
		disposition,
	}) => {
		const lenses = ["spec", "standards", "operational"] as const
		const candidates = lenses.slice(0, lensCount).map((lens) => candidate(lens, 1))
		const memberIds = candidates.slice(0, groupSize).map((entry) => entry.id)
		const output = semantic(
			[
				{
					id: "accounted-group",
					path: "stack.ts",
					line: 12,
					severity: "warning",
					type: "bug",
					description: "A grouped defect.",
					suggestion: "Fix it.",
					candidate_ids: memberIds,
				},
			],
			candidates,
		)
		const omitted = candidates.at(-1)?.id
		output.decisions = output.decisions.map((decision) =>
			decision.candidate_id === omitted
				? {
						candidate_id: omitted,
						disposition,
						finding: "accounted-group",
						reason: "Incorrectly references the group.",
					}
				: decision,
		)
		await expect(
			validateSemanticReconciliation(output, candidates, { writer: "final", contextDir, outputDir }),
		).rejects.toThrow("omitted from its candidate_ids")
	})

	it("ranks semantic groups by published fields after a verifier severity swap", async () => {
		const candidates = [
			candidate("spec", 1, { severity: "critical", description: "Originally critical." }),
			candidate("standards", 1, { severity: "warning", description: "Originally warning." }),
		]
		const output = semantic(
			[
				{
					id: "now-warning",
					path: "stack.ts",
					line: 10,
					severity: "warning",
					type: "bug",
					description: "Published lower severity.",
					suggestion: "Fix after the critical defect.",
					candidate_ids: ["spec-1"],
				},
				{
					id: "now-critical",
					path: "stack.ts",
					line: 11,
					severity: "critical",
					type: "bug",
					description: "Published higher severity.",
					suggestion: "Fix first.",
					candidate_ids: ["standards-1"],
				},
			],
			candidates,
		)
		const validated = await validateSemanticReconciliation(output, candidates, {
			writer: "final",
			contextDir,
			outputDir,
		})
		expect(validated.findings.map((finding) => [finding.seq, finding.severity, finding.derived_from])).toEqual([
			[1, "critical", ["standards-1"]],
			[2, "warning", ["spec-1"]],
		])
	})

	it("preserves all 51 duplicate sources durably while capping published provenance", async () => {
		const candidates = [
			...Array.from({ length: 50 }, (_, index) => candidate("spec", index + 1)),
			candidate("standards", 1),
		]
		const store = await makeStore(candidates)
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		const result = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(result.findings).toHaveLength(1)
		const complete = result.state.reconciliation.provenance?.["final-1"]
		expect(complete).toHaveLength(51)
		expect(result.findings[0].derived_from).toEqual(complete?.slice(0, 50))
		expect(result.findings[0].derived_from).toHaveLength(50)
		expect(result.state.reconciliation.provenanceTruncatedCount).toBe(1)
		expect(result.state.coverage.provenance_truncated_count).toBe(1)
		expect(result.summary.coverage?.provenance_truncated_count).toBe(1)
	})

	it("rejects aggregate reply overflow before publishing any semantic artifact", async () => {
		const threads = Array.from({ length: 17 }, (_, index) => ({
			thread_id: `mention-${index}`,
			body: "x".repeat(64 * 1024),
			action: "none" as const,
		}))
		writeFileSync(
			join(contextDir, "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				threads: threads.map((thread) => ({ thread_id: thread.thread_id, is_ours: false, mentions_bot: true })),
			}),
		)
		const store = await makeStore([])
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		const result = await finalizeReviewPanel({
			store,
			outputDir,
			contextDir,
			hasVerifier: true,
			reconcile: async () => JSON.stringify(semantic([], [], threads)),
		})
		expect(result.state.reconciliation.status).toBe("fallback")
		expect(result.state.reconciliation.reason).toContain("1 MiB")
		expect(existsSync(reviewPanelPaths(outputDir).repliesPath)).toBe(false)
		expect(readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")).toBe("")
		expect(existsSync(reviewPanelPaths(outputDir).summaryPath)).toBe(true)
	})

	it("validates fixed and equivalent replies and preserves every final artifact byte on wrap-up", async () => {
		writeFileSync(
			join(contextDir, "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				previous_revision: SHA_A,
				threads: [
					{ thread_id: "fixed-thread", is_ours: true, mentions_bot: false, previous_revision: SHA_A },
					{ thread_id: "equivalent-thread", is_ours: true, mentions_bot: false },
				],
			}),
		)
		const candidates = [candidate("spec", 1)]
		const store = await makeStore(candidates)
		const output = semantic([], candidates, [
			{
				thread_id: "fixed-thread",
				body: "The guard is present at the current head and the former failing path is covered.",
				action: "resolve",
				verdict: "fixed",
				evidence_kind: "code_reference",
				evidence: "Compared previous_revision with the pinned head.",
			},
			{
				thread_id: "equivalent-thread",
				body: "This candidate is the same still-present concern; no duplicate inline finding is needed.",
				action: "none",
				verdict: "not_fixed",
				evidence_kind: "code_reference",
				evidence: "The same path still lacks the guard at head.",
				equivalent_candidate_ids: ["spec-1"],
			},
		])
		const first = await finalizeReviewPanel({
			store,
			outputDir,
			contextDir,
			hasVerifier: true,
			reconcile: async () => JSON.stringify(output),
		})
		expect(first.findings).toEqual([])
		expect(first.summary.coverage).toMatchObject({ status: "complete", final_finding_count: 0 })
		const repliesPath = reviewPanelPaths(outputDir).repliesPath
		const replies = readFileSync(repliesPath, "utf8")
		expect(replies.trim().split("\n")).toHaveLength(2)
		expect(replies).toContain('"verdict":"fixed"')
		expect(replies).toContain('"verdict":"not_fixed"')

		const findingsBefore = readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")
		const summaryBefore = readFileSync(reviewPanelPaths(outputDir).summaryPath, "utf8")
		const repliesBefore = readFileSync(repliesPath, "utf8")
		const second = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(second.findings).toEqual([])
		expect(readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")).toBe(findingsBefore)
		expect(readFileSync(reviewPanelPaths(outputDir).summaryPath, "utf8")).toBe(summaryBefore)
		expect(readFileSync(repliesPath, "utf8")).toBe(repliesBefore)
		expect(readFileSync(repliesPath, "utf8")).toBe(replies)
	})
})
