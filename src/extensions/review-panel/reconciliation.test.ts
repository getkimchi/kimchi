import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	DEFAULT_WRITER_LIMIT,
	FINDING_SCHEMA_VERSION,
	FINDING_TEXT_LIMITS,
	MAX_OUTPUT_FILE_BYTES,
	type ReviewFindingRecord,
} from "../review-submit/store.js"
import type { ResolvedReviewTarget } from "../review-targets/types.js"
import { checkpointReviewPanelFallback, finalizeReviewPanel } from "./finalize.js"
import { type ReviewLensId, resolveReviewPanel } from "./lenses.js"
import {
	buildFallbackCheckpoint,
	buildFinalFallback,
	capFinalReviewFindings,
	readFinalFindings,
	readFindingWriter,
	reviewPanelPaths,
	serializeFinalFindings,
} from "./output.js"
import {
	parseSemanticReconciliation,
	ReconciliationInvocationError,
	validateSemanticReconciliation,
} from "./reconciliation.js"
import { assertReviewPanelIdentity, coverageFor, createInitialPanelState, ReviewPanelStateStore } from "./state.js"
import {
	REVIEW_RECONCILIATION_VERSION,
	type ReconciliationFinding,
	type ReviewPanelCandidate,
	type SemanticReconciliation,
} from "./types.js"

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
			title: "Concrete defect",
			description: "A concrete defect with an observed consequence.",
			explanation: "Static inspection of stack.ts supports this fixture finding.",
			suggestion: "Apply the corrective guard.",
			priority: "P2",
			type: "bug",
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

function reconciledFinding(
	source: ReviewPanelCandidate,
	overrides: Partial<ReconciliationFinding> = {},
): ReconciliationFinding {
	return {
		id: `${source.id}-reconciled`,
		path: source.finding.path,
		line: source.finding.line,
		title: source.finding.title,
		description: source.finding.description,
		explanation: source.finding.explanation,
		suggestion: source.finding.suggestion,
		priority: source.finding.priority,
		type: source.finding.type,
		candidate_ids: [source.id],
		...overrides,
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

	it("accepts one surrounding markdown fence but rejects prose and a second JSON value", () => {
		const json = '{"schema_version":"review-reconciliation/v1","findings":[],"decisions":[],"threads":[]}'
		expect(parseSemanticReconciliation(`\`\`\`json\n${json}\n\`\`\``)).toEqual(JSON.parse(json))
		expect(parseSemanticReconciliation(`\`\`\`\n${json}\n\`\`\``)).toEqual(JSON.parse(json))
		expect(() => parseSemanticReconciliation(`Result:\n\`\`\`json\n${json}\n\`\`\``)).toThrow(SyntaxError)
		expect(() => parseSemanticReconciliation(`\`\`\`json\n${json}\n${json}\n\`\`\``)).toThrow(SyntaxError)
	})

	it("rejects a second Markdown fence containing another JSON block", () => {
		const json = '{"schema_version":"review-reconciliation/v1","findings":[],"decisions":[],"threads":[]}'
		const fenced = `\`\`\`json\n${json}\n\`\`\``
		expect(() => parseSemanticReconciliation(`${fenced}\n${fenced}`)).toThrow(SyntaxError)
	})

	async function makeStore(
		candidates: ReviewPanelCandidate[],
		stateOutputDir = outputDir,
	): Promise<ReviewPanelStateStore> {
		const lenses = [...new Set(candidates.map((entry) => entry.lens))]
		const selected = lenses.length > 0 ? lenses : (["spec"] as ReviewLensId[])
		const selection = resolveReviewPanel({ lenses: selected })
		const state = createInitialPanelState(
			target(contextDir),
			selection,
			{ lenses: selected, all: false, concurrency: 2 },
			[],
			stateOutputDir,
		)
		state.candidates = candidates
		for (const lens of state.lenses) {
			lens.status = "submitted"
			lens.candidateIds = candidates.filter((entry) => entry.lens === lens.id).map((entry) => entry.id)
		}
		state.coverage = coverageFor(state, [])
		return ReviewPanelStateStore.create(state, stateOutputDir)
	}

	const malformedCandidates: Array<{ name: string; mutate: (candidate: ReviewPanelCandidate) => void }> = [
		{
			name: "schema",
			mutate: (candidate) => Object.assign(candidate.finding, { schema_version: "review-finding/v2" }),
		},
		{ name: "writer", mutate: (candidate) => Object.assign(candidate.finding, { writer: "not-spec" }) },
		{ name: "non-contiguous sequence", mutate: (candidate) => Object.assign(candidate.finding, { seq: 99 }) },
		{
			name: "mismatched ID",
			mutate: (candidate) => {
				Object.assign(candidate.finding, { id: "wrong" })
				candidate.id = "wrong"
			},
		},
		{ name: "empty timestamp", mutate: (candidate) => Object.assign(candidate.finding, { created_at: "" }) },
		{ name: "forbidden evidence", mutate: (candidate) => Object.assign(candidate.finding, { evidence: "static" }) },
		{ name: "forbidden severity", mutate: (candidate) => Object.assign(candidate.finding, { severity: "critical" }) },
		{
			name: "over-limit title",
			mutate: (candidate) => Object.assign(candidate.finding, { title: "x".repeat(FINDING_TEXT_LIMITS.title + 1) }),
		},
	]

	it.each(["create", "load", "update"] as const)("rejects malformed stored candidates on %s", async (operation) => {
		for (const [index, testCase] of malformedCandidates.entries()) {
			const stateOutputDir = join(sandbox, `panel-state-${operation}-${index}`)
			const store = await makeStore([candidate("spec", 1)], stateOutputDir)
			const statePath = reviewPanelPaths(stateOutputDir).statePath
			const persistedBefore = readFileSync(statePath, "utf8")
			const malformed = structuredClone(store.state.candidates[0])
			testCase.mutate(malformed)
			const label = `${operation}: ${testCase.name}`

			if (operation === "create") {
				const invalidState = structuredClone(store.state)
				invalidState.candidates[0] = malformed
				const createOutputDir = join(stateOutputDir, "create")
				await expect(ReviewPanelStateStore.create(invalidState, createOutputDir), label).rejects.toThrow()
				expect(existsSync(reviewPanelPaths(createOutputDir).statePath)).toBe(false)
			} else if (operation === "load") {
				const invalidState = structuredClone(store.state)
				invalidState.candidates[0] = malformed
				writeFileSync(statePath, JSON.stringify(invalidState, null, 2))
				await expect(ReviewPanelStateStore.load(stateOutputDir), label).rejects.toThrow()
			} else {
				await expect(
					store.update((state) => {
						state.candidates[0] = malformed
					}),
					label,
				).rejects.toThrow()
				expect(readFileSync(statePath, "utf8"), label).toBe(persistedBefore)
			}
		}
	})

	it("merges one defect at different locations and preserves every source ID", async () => {
		const candidates = [
			candidate("spec", 1, { line: 10, description: "Missing authorization exposes the record." }),
			candidate("standards", 1, { line: 14, description: "The same missing check exposes the record." }),
		]
		const output = semantic(
			[
				reconciledFinding(candidates[0], {
					id: "authorization-defect",
					title: "Record access skips authorization",
					priority: "P1",
					candidate_ids: ["spec-1", "standards-1"],
				}),
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
			line: 10,
			title: "Record access skips authorization",
			priority: "P1",
			derived_from: ["spec-1", "standards-1"],
		})
		expect(validated.findings[0]).not.toHaveProperty("candidate_ids")
	})

	it("keeps distinct defects on the same line separate", async () => {
		const candidates = [
			candidate("spec", 1, { description: "The return value is wrong.", priority: "P2" }),
			candidate("security", 1, {
				description: "The same line leaks a secret.",
				priority: "P0",
				type: "security",
			}),
		]
		const output = semantic(
			candidates.map((entry, index) => reconciledFinding(entry, { id: `distinct-${index}` })),
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

	it("retains capped fallback when cached semantic output fails validation during recovery", async () => {
		const candidates = [candidate("spec", 1, { type: "convention", priority: "P1" })]
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
		expect(readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")).not.toBe(before)
		expect(result.findings).toHaveLength(1)
		expect(result.findings[0].priority).toBe("P4")
		expect(result.state.reconciliation.status).toBe("fallback")
		expect(result.state.reconciliation.reason).toContain("Cached semantic reconciliation failed validation")
	})

	it.each([
		{ name: "verifier available", hasVerifier: true },
		{ name: "verifier unavailable", hasVerifier: false },
	])("recovers reloaded reconciled state without semantic payload with $name", async ({ hasVerifier }) => {
		const source = candidate("spec", 1, { title: "Candidate title" })
		const store = await makeStore([source])
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		await store.update((state) => {
			state.reconciliation.status = "reconciled"
			state.reconciliation.reason = "Persisted reconciled state without its semantic payload."
			state.reconciliation.semantic = undefined
		})
		await store.close()
		const reloaded = await ReviewPanelStateStore.load(outputDir)
		expect(reloaded.state.reconciliation.status).toBe("reconciled")
		expect(reloaded.state.reconciliation.semantic).toBeUndefined()
		let verifierCalls = 0

		const result = await finalizeReviewPanel({
			store: reloaded,
			outputDir,
			contextDir,
			hasVerifier,
			reconcile: async () => {
				verifierCalls += 1
				return semantic([reconciledFinding(source, { title: "Reconciled semantic title" })], [source])
			},
		})

		if (hasVerifier) {
			expect(verifierCalls).toBe(1)
			expect(result.findings.map((finding) => [finding.id, finding.title, finding.derived_from])).toEqual([
				["final-1", "Reconciled semantic title", ["spec-1"]],
			])
			expect(result.state.reconciliation).toMatchObject({
				status: "reconciled",
				reason: "Semantic reconciliation validated and published.",
				provenance: { "final-1": ["spec-1"] },
			})
		} else {
			expect(verifierCalls).toBe(0)
			expect(result.findings.map((finding) => [finding.id, finding.title, finding.derived_from])).toEqual([
				["final-1", "Candidate title", ["spec-1"]],
			])
			expect(result.state.reconciliation).toMatchObject({
				status: "fallback",
				reason: "Semantic reconciliation was unavailable; the deterministic fallback is final.",
				provenance: { "final-1": ["spec-1"] },
			})
		}
	})

	it("rejects malformed fields in final serialization and final read-back", async () => {
		const invalid = {
			...candidate("spec", 1).finding,
			id: "final-1",
			writer: "final",
			title: "x".repeat(FINDING_TEXT_LIMITS.title + 1),
		}
		expect(() => serializeFinalFindings([invalid])).toThrow("actual length is 81")
		const finalPath = reviewPanelPaths(outputDir).findingsPath
		mkdirSync(join(outputDir, "findings"), { recursive: true })
		writeFileSync(finalPath, `${JSON.stringify(invalid)}\n`)
		await expect(readFinalFindings(finalPath)).rejects.toThrow("actual length is 81")
	})

	it.each([
		{ name: "a non-final writer", overrides: { writer: "not-final" } },
		{ name: "a discontinuous sequence", overrides: { seq: 99 } },
		{ name: "an arbitrary ID", overrides: { id: "wrong" } },
		{ name: "an empty timestamp", overrides: { created_at: "" } },
		{ name: "a non-timestamp string", overrides: { created_at: "yesterday" } },
		{ name: "an impossible calendar date", overrides: { created_at: "2026-02-30T12:00:00Z" } },
		{ name: "a timestamp with a non-UTC offset", overrides: { created_at: "2026-11-24T12:00:00+01:00" } },
	])("rejects $name during final serialization", ({ overrides }) => {
		const invalid = { ...candidate("spec", 1).finding, id: "final-1", writer: "final", ...overrides }
		expect(() => serializeFinalFindings([invalid])).toThrow()
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

	it("accepts trailing separators in wrap-up identity paths", async () => {
		const state = (await makeStore([])).state
		state.scope.checkoutPath = sandbox
		await expect(
			assertReviewPanelIdentity(state, {
				baseSha: state.scope.pinned.baseSha,
				headSha: state.scope.pinned.headSha,
				checkoutPath: `${state.scope.checkoutPath}/`,
				contextDir: `${state.contextDir}/`,
				outputDir: `${state.outputDir}/`,
			}),
		).resolves.toBeUndefined()
	})

	it("rejects identical nonexistent wrap-up identity paths", async () => {
		const state = (await makeStore([])).state
		const deletedCheckoutPath = join(sandbox, "deleted-checkout")
		state.scope.checkoutPath = deletedCheckoutPath
		await expect(
			assertReviewPanelIdentity(state, {
				baseSha: state.scope.pinned.baseSha,
				headSha: state.scope.pinned.headSha,
				checkoutPath: deletedCheckoutPath,
				contextDir: state.contextDir,
				outputDir: state.outputDir,
			}),
		).rejects.toThrow("Review wrap-up identity mismatch for checkoutPath")
	})

	it("rejects a genuinely different wrap-up identity directory", async () => {
		const state = (await makeStore([])).state
		state.scope.checkoutPath = sandbox
		const differentOutputDir = join(sandbox, "genuinely-different-output")
		mkdirSync(differentOutputDir, { recursive: true })
		await expect(
			assertReviewPanelIdentity(state, {
				baseSha: state.scope.pinned.baseSha,
				headSha: state.scope.pinned.headSha,
				checkoutPath: state.scope.checkoutPath,
				contextDir: state.contextDir,
				outputDir: differentOutputDir,
			}),
		).rejects.toThrow("Review wrap-up identity mismatch for outputDir")
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

		const critical = candidate("spec", 2, { description: "Higher rank.", priority: "P0", line: 40 })
		await store.update((state) => {
			state.candidates.push(critical)
			state.coverage = coverageFor(state, [])
		})
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		findings = await readFinalFindings(reviewPanelPaths(outputDir).findingsPath)
		expect(findings.map((finding) => [finding.id, finding.seq, finding.priority])).toEqual([
			["final-1", 1, "P0"],
			["final-2", 2, "P2"],
		])

		await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		const first = readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")
		await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(readFileSync(reviewPanelPaths(outputDir).findingsPath, "utf8")).toBe(first)
	})

	it("enforces the 50-finding and finalized field-size limits", async () => {
		const candidates = Array.from({ length: 55 }, (_, index) =>
			candidate(index % 2 === 0 ? "spec" : "standards", Math.floor(index / 2) + 1, {
				line: 10 + (index % 40),
				title: `Finding ${index}`,
				description: `${String(index).padStart(2, "0")}-${"d".repeat(FINDING_TEXT_LIMITS.description - 3)}`,
				explanation: "e".repeat(FINDING_TEXT_LIMITS.explanation),
				suggestion: "s".repeat(FINDING_TEXT_LIMITS.suggestion),
			}),
		)
		const store = await makeStore(candidates)
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		const final = await readFinalFindings(reviewPanelPaths(outputDir).findingsPath)
		expect(candidates).toHaveLength(55)
		expect(final).toHaveLength(DEFAULT_WRITER_LIMIT)
		expect(Buffer.byteLength(serializeFinalFindings(final))).toBeLessThanOrEqual(MAX_OUTPUT_FILE_BYTES)
		for (const finding of final) {
			expect(Array.from(finding.description)).toHaveLength(FINDING_TEXT_LIMITS.description)
			expect(Array.from(finding.explanation)).toHaveLength(FINDING_TEXT_LIMITS.explanation)
			expect(Array.from(finding.suggestion)).toHaveLength(FINDING_TEXT_LIMITS.suggestion)
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
			[reconciledFinding(candidates[0], { id: "accounted-group", candidate_ids: memberIds })],
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

	it("ranks semantic groups after a verifier re-rates only title and priority", async () => {
		const candidates = [
			candidate("spec", 1, { priority: "P0", description: "Originally critical." }),
			candidate("standards", 1, { priority: "P2", description: "Originally warning." }),
		]
		const output = semantic(
			[
				reconciledFinding(candidates[0], { id: "now-p2", title: "Re-rated lower", priority: "P2" }),
				reconciledFinding(candidates[1], { id: "now-p0", title: "Re-rated higher", priority: "P0" }),
			],
			candidates,
		)
		const validated = await validateSemanticReconciliation(output, candidates, {
			writer: "final",
			contextDir,
			outputDir,
		})
		expect(validated.findings.map((finding) => [finding.seq, finding.priority, finding.derived_from])).toEqual([
			[1, "P0", ["standards-1"]],
			[2, "P2", ["spec-1"]],
		])
	})

	it("rejects reconciliation rewrites outside title and priority", async () => {
		const candidates = [candidate("spec", 1), candidate("standards", 1)]
		const output = semantic(
			[
				reconciledFinding(candidates[0], {
					description: "A consolidated description invented by the reconciler.",
					candidate_ids: candidates.map((entry) => entry.id),
				}),
			],
			candidates,
		)
		await expect(
			validateSemanticReconciliation(output, candidates, { writer: "final", contextDir, outputDir }),
		).rejects.toThrow("may rewrite only title and priority")
	})

	it("normalizes preserved reconciliation fields before comparing and publishing them", async () => {
		const source = candidate("spec", 1)
		const output = semantic(
			[
				reconciledFinding(source, {
					title: "  Normalized title  ",
					description: ` \n${source.finding.description}\t `,
					explanation: `\t${source.finding.explanation}\n`,
					suggestion: ` \n${source.finding.suggestion}\t `,
				}),
			],
			[source],
		)
		const validated = await validateSemanticReconciliation(output, [source], {
			writer: "final",
			contextDir,
			outputDir,
		})
		expect(validated.semantic.findings[0]).toMatchObject({
			title: "Normalized title",
			description: source.finding.description,
			explanation: source.finding.explanation,
			suggestion: source.finding.suggestion,
		})
		expect(validated.findings[0]).toMatchObject({
			title: "Normalized title",
			description: source.finding.description,
			explanation: source.finding.explanation,
			suggestion: source.finding.suggestion,
		})

		const rewritten = structuredClone(output)
		rewritten.findings[0].description = "A substantive rewrite of the preserved description."
		await expect(
			validateSemanticReconciliation(rewritten, [source], { writer: "final", contextDir, outputDir }),
		).rejects.toThrow("may rewrite only title and priority")
	})

	it.each([
		{ name: "LF", character: "\n" },
		{ name: "CR", character: "\r" },
		{ name: "tab", character: "\t" },
		{ name: "U+2028", character: "\u2028" },
	])("rejects $name around a reconciliation title before normalization", async ({ character }) => {
		const source = candidate("spec", 1)
		const output = semantic([reconciledFinding(source, { title: `${character}Concrete defect${character}` })], [source])
		await expect(
			validateSemanticReconciliation(output, [source], { writer: "final", contextDir, outputDir }),
		).rejects.toThrow("title must be a single line and must not contain control characters.")
	})

	it("keeps interim checkpoints uncapped and caps fresh and reused fallback only at wrap-up", async () => {
		const source = candidate("spec", 1, { title: "Convention cleanup", type: "convention", priority: "P1" })
		const store = await makeStore([source])
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		expect((await readFinalFindings(reviewPanelPaths(outputDir).findingsPath))[0].priority).toBe("P1")
		expect(store.state.candidates[0].finding.priority).toBe("P1")

		const first = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(first.findings[0].priority).toBe("P4")
		expect(first.summary.coverage?.findings_by_priority.P1).toBe(0)
		expect(first.summary.coverage?.findings_by_priority.P4).toBe(1)

		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		expect((await readFinalFindings(reviewPanelPaths(outputDir).findingsPath))[0].priority).toBe("P1")
		const reused = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(reused.findings[0].priority).toBe("P4")
		expect(reused.summary.coverage?.findings_by_priority.P4).toBe(1)
	})

	it("counts capped priorities in interim coverage without changing interim records", async () => {
		const source = candidate("spec", 1, { title: "Convention cleanup", type: "convention", priority: "P1" })
		const store = await makeStore([source])
		await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		const interim = await readFinalFindings(reviewPanelPaths(outputDir).findingsPath)
		expect(interim[0].priority).toBe("P1")
		expect(store.state.coverage.findings_by_priority).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0, P4: 1 })

		const result = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(result.findings[0].priority).toBe("P4")
		expect(result.summary.coverage?.findings_by_priority).toEqual(store.state.coverage.findings_by_priority)
	})

	it("caps semantic findings only at publication without mutating reconciliation provenance", async () => {
		const source = candidate("spec", 1, { title: "Semantic convention cleanup", type: "convention", priority: "P1" })
		const store = await makeStore([source])
		const result = await finalizeReviewPanel({
			store,
			outputDir,
			contextDir,
			hasVerifier: true,
			reconcile: async () => semantic([reconciledFinding(source)], [source]),
		})
		expect(result.findings[0].priority).toBe("P4")
		expect(result.state.reconciliation.semantic?.findings[0].priority).toBe("P1")
		expect(result.summary.coverage?.findings_by_priority.P4).toBe(1)
	})

	it("caps convention, docs, and test-gap priorities during finalization and counts capped priorities", async () => {
		const candidates = [
			candidate("spec", 1, { title: "Convention", type: "convention", priority: "P0" }),
			candidate("spec", 2, { title: "Documentation", type: "docs", priority: "P1" }),
			candidate("spec", 3, { title: "Missing regression coverage", type: "test-gap", priority: "P0" }),
			candidate("spec", 4, { title: "Edge-case coverage", type: "test-gap", priority: "P4" }),
		]
		const store = await makeStore(candidates)
		const result = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(result.findings.map((finding) => [finding.title, finding.priority])).toEqual([
			["Missing regression coverage", "P3"],
			["Convention", "P4"],
			["Documentation", "P4"],
			["Edge-case coverage", "P4"],
		])
		expect(result.findings.every((finding) => !("priority_capped_from" in finding))).toBe(true)
		expect(result.summary.coverage?.findings_by_priority).toEqual({ P0: 0, P1: 0, P2: 0, P3: 1, P4: 3 })
		expect(result.summary.body).toContain("P3=1, P4=3")
	})

	it("ranks fallback findings by capped priority before enforcing the finding limit", async () => {
		const docs = Array.from({ length: DEFAULT_WRITER_LIMIT }, (_, index) =>
			candidate("standards", index + 1, { line: index + 1, type: "docs", priority: "P1" }),
		)
		const bug = candidate("spec", 1, { priority: "P2" })
		const store = await makeStore([...docs, bug])
		const checkpoint = await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
		expect(checkpoint).toHaveLength(DEFAULT_WRITER_LIMIT)
		expect(checkpoint.every((finding) => finding.priority === "P1")).toBe(true)

		const result = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(result.findings).toHaveLength(DEFAULT_WRITER_LIMIT)
		expect(result.findings[0]).toMatchObject({ id: "final-1", priority: "P2", derived_from: [bug.id] })
		expect(result.state.reconciliation.provenance?.["final-1"]).toEqual([bug.id])
		expect(result.summary.coverage?.findings_by_priority).toMatchObject({ P2: 1, P4: DEFAULT_WRITER_LIMIT - 1 })
	})

	it("repairs provenance when capped fallback publication crashed before its state update", async () => {
		const candidates = [
			candidate("standards", 1, {
				title: "Documentation cleanup",
				description: "A documentation finding.",
				type: "docs",
				priority: "P1",
			}),
			candidate("spec", 1, {
				title: "Runtime defect",
				description: "A runtime finding.",
				priority: "P2",
			}),
		]
		const store = await makeStore(candidates)
		const paths = reviewPanelPaths(outputDir)
		await checkpointReviewPanelFallback(store, paths.findingsPath)
		const checkpoint = buildFallbackCheckpoint(candidates)
		expect(checkpoint.records.map((record) => [record.id, record.derived_from])).toEqual([
			["final-1", ["standards-1"]],
			["final-2", ["spec-1"]],
		])
		const published = buildFinalFallback(candidates)
		await store.update((state) => {
			state.reconciliation.status = "fallback"
			state.reconciliation.reason = "Semantic reconciliation was unavailable; the deterministic fallback is final."
		})
		writeFileSync(paths.findingsPath, serializeFinalFindings(published.records))
		// The capped file is durable, but state still has the pre-cap final-1/final-2 mapping.
		const result = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(result.findings.map((record) => [record.id, record.priority, record.derived_from])).toEqual([
			["final-1", "P2", ["spec-1"]],
			["final-2", "P4", ["standards-1"]],
		])
		expect(result.state.reconciliation.provenance).toEqual({
			"final-1": ["spec-1"],
			"final-2": ["standards-1"],
		})
	})

	it("throws when final capping is missing a record's complete provenance", async () => {
		const packed = buildFallbackCheckpoint([candidate("spec", 1)])
		expect(() => capFinalReviewFindings({ ...packed, provenance: {} })).toThrow(
			"Missing complete provenance for final finding final-1.",
		)
	})

	it("publishes capped candidate fallback when changed-history reconciliation fails", async () => {
		writeFileSync(
			join(contextDir, "comments.json"),
			JSON.stringify({ schema_version: "review-comments/v1", threads: [] }),
		)
		const candidates = [
			candidate("spec", 1, { title: "First candidate title", type: "convention", priority: "P1" }),
			candidate("standards", 1, { title: "Second candidate title", type: "convention", priority: "P1" }),
		]
		const store = await makeStore(candidates)
		const output = semantic(
			[
				reconciledFinding(candidates[0], {
					id: "merged-semantic-finding",
					title: "Merged semantic title",
					candidate_ids: candidates.map((entry) => entry.id),
				}),
			],
			candidates,
		)
		const first = await finalizeReviewPanel({
			store,
			outputDir,
			contextDir,
			hasVerifier: true,
			reconcile: async () => output,
		})
		expect(first.state.reconciliation.status).toBe("reconciled")
		expect(first.findings).toHaveLength(1)
		expect(first.findings[0].derived_from).toEqual(["spec-1", "standards-1"])

		writeFileSync(
			join(contextDir, "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				threads: [{ thread_id: "new-history", is_ours: false, mentions_bot: true }],
			}),
		)
		const second = await finalizeReviewPanel({
			store,
			outputDir,
			contextDir,
			hasVerifier: true,
			reconcile: async () => {
				throw new ReconciliationInvocationError("Verifier unavailable for changed history.")
			},
		})
		expect(second.state.reconciliation.status).toBe("fallback")
		expect(second.state.reconciliation.reason).toContain("Verifier unavailable for changed history.")
		expect(second.findings.map((record) => [record.id, record.title, record.priority, record.derived_from])).toEqual([
			["final-1", "First candidate title", "P4", ["spec-1"]],
			["final-2", "Second candidate title", "P4", ["standards-1"]],
		])
		expect(second.state.reconciliation.provenance).toEqual({
			"final-1": ["spec-1"],
			"final-2": ["standards-1"],
		})
	})

	it("recovers consistently when semantic findings publication crashed before its state update", async () => {
		const candidates = [
			candidate("spec", 1, { title: "First candidate title", type: "convention", priority: "P1" }),
			candidate("standards", 1, { title: "Second candidate title", type: "convention", priority: "P1" }),
		]
		const store = await makeStore(candidates)
		const paths = reviewPanelPaths(outputDir)
		await checkpointReviewPanelFallback(store, paths.findingsPath)
		const output = semantic(
			[
				reconciledFinding(candidates[0], {
					id: "merged-semantic-finding",
					title: "Merged semantic title",
					candidate_ids: candidates.map((entry) => entry.id),
				}),
			],
			candidates,
		)
		const validated = await validateSemanticReconciliation(output, candidates, {
			writer: "final",
			contextDir,
			outputDir,
		})
		const published = capFinalReviewFindings({
			records: validated.findings,
			provenance: validated.provenance,
			provenanceTruncatedCount: validated.provenanceTruncatedCount,
		})
		writeFileSync(paths.findingsPath, serializeFinalFindings(published.records))
		// State still contains only the awaiting candidate checkpoint and its provenance.
		const result = await finalizeReviewPanel({ store, outputDir, contextDir, hasVerifier: false })
		expect(result.state.reconciliation.status).toBe("fallback")
		expect(result.state.reconciliation.semantic).toBeUndefined()
		expect(result.findings.map((record) => [record.id, record.title, record.priority, record.derived_from])).toEqual([
			["final-1", "First candidate title", "P4", ["spec-1"]],
			["final-2", "Second candidate title", "P4", ["standards-1"]],
		])
		expect(result.state.reconciliation.provenance).toEqual({
			"final-1": ["spec-1"],
			"final-2": ["standards-1"],
		})
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
