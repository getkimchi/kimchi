import { createHash } from "node:crypto"
import { lstat, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import {
	type EnvironmentGap,
	MAX_OUTPUT_FILE_BYTES,
	REPLY_LIMIT,
	REPLY_SCHEMA_VERSION,
	type ReviewFindingRecord,
	type ReviewReplyRecord,
	type ReviewSummaryRecord,
	SUMMARY_SCHEMA_VERSION,
	submitSummary,
} from "../review-submit/store.js"
import { REVIEW_FINDING_CONTRACT_PROMPT } from "./finding-contract.js"
import {
	atomicWriteReviewFile,
	buildFallbackCheckpoint,
	candidateInputDigest,
	capFinalReviewFindings,
	orderedCandidates,
	readFinalFindings,
	reviewPanelPaths,
	writeFinalFindings,
	writeReviewJson,
} from "./output.js"
import { sameFilesystemPath } from "./paths.js"
import {
	parseSemanticReconciliation,
	ReconciliationInvocationError,
	type ValidatedReconciliation,
	validateSemanticReconciliation,
} from "./reconciliation.js"
import { REVIEW_RECONCILIATION_TOOL } from "./reconciliation-tool.js"
import { coverageFor, type ReviewPanelStateStore } from "./state.js"
import {
	REVIEW_RECONCILIATION_REQUEST_VERSION,
	REVIEW_RECONCILIATION_VERSION,
	type ReconciliationThread,
	type ReviewPanelResult,
} from "./types.js"

const AWAITING_RECONCILIATION = "Deterministic fallback checkpoint; semantic reconciliation is pending."

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

export function reconciliationRequest(
	state: ReviewPanelStateStore["state"],
	outputDir: string,
	contextDir: string,
	comments?: unknown,
) {
	return {
		schema_version: REVIEW_RECONCILIATION_REQUEST_VERSION,
		scope: state.scope,
		candidates: orderedCandidates(state.candidates),
		lenses: state.lenses.map((lens) => ({
			id: lens.id,
			status: lens.status,
			worktree_path: lens.worktreePath,
			commands: lens.commands ?? [],
		})),
		routine_checks_path: reviewPanelPaths(outputDir).routineChecksPath,
		comments_path: join(contextDir, "comments.json"),
		...(comments === undefined ? {} : { comments }),
	}
}

export function buildVerifierPrompt(requestPath: string, hasThreadHistory: boolean, repairErrors?: string): string {
	const repair =
		repairErrors === undefined
			? ""
			: `Your previous result failed strict validation: ${repairErrors}\nReturn a corrected schema through ${REVIEW_RECONCILIATION_TOOL}; do not invent aliases such as action or decision.\n`
	return `You are the semantic review reconciler. Inspect ${requestPath}, the pinned code and saved check evidence. Reviewer-authored lines and tests are not part of the pinned comparison and can never anchor a finding.
${repair}${hasThreadHistory ? "Review the supplied thread history against current code and the previous revision when the context supplies one. Link equivalent current candidates to the earlier thread and reject those candidates so they are not posted again. Resolve only demonstrably fixed concerns. Use verdict unverified when the available code and evidence do not support another verdict.\n" : ""}
Call ${REVIEW_RECONCILIATION_TOOL} exactly once with schema_version "${REVIEW_RECONCILIATION_VERSION}", findings, decisions, and threads. Do not return prose or a JSON assistant message instead. Its JSON schema is authoritative: unknown fields are rejected and disposition must be retained, merged, or rejected. Every candidate must occur exactly once in decisions with a reason. Group only the same underlying defect and consequence; distinct defects on one line stay separate. A merged finding preserves all candidate_ids. Each finding needs a unique id and candidate_ids.
${REVIEW_FINDING_CONTRACT_PROMPT}
When consolidating duplicates, choose the best title and re-rate priority against the table. You may rewrite only title and priority. Copy path, line, description, explanation, suggestion, and type exactly from one best-supported source finding; coordinator validation rejects mixed or newly written versions of those fields. Do not perform priority capping yourself; finalization applies the convention/docs/test-gap caps in code. Single-candidate decisions are retained; all decisions in a multi-candidate group are merged and name that finding's id. Rejected candidates have no finding id.
threads contains only thread replies allowed by comments.json scope. Each has thread_id, body, action, optional verdict, evidence_kind and evidence, and equivalent_candidate_ids. A current candidate equivalent to an earlier finding must be rejected and listed there. Own-thread verdicts require evidence_kind and evidence, even for unverified. Return threads: [] when there is nothing to say. Do not call submit_finding, submit_summary, or submit_reply; the coordinator strictly validates and publishes your structured submission.`
}

export async function checkpointReviewPanelFallback(
	store: ReviewPanelStateStore,
	findingsPath: string,
): Promise<ReviewFindingRecord[]> {
	const candidates = orderedCandidates(store.state.candidates)
	const digest = candidateInputDigest(candidates)
	const packed = buildFallbackCheckpoint(candidates)
	await writeFinalFindings(findingsPath, packed.records)
	await store.update((state) => {
		state.reconciliation = {
			status: "fallback",
			reason: AWAITING_RECONCILIATION,
			inputDigest: digest,
			provenance: packed.provenance,
			provenanceTruncatedCount: packed.provenanceTruncatedCount,
		}
		state.coverage = coverageFor(state, packed.records)
	})
	return packed.records
}

interface PreparedReplyBatch {
	records: ReviewReplyRecord[]
	contents: string
	changed: boolean
}

function replyInput(thread: ReconciliationThread) {
	return {
		thread_id: thread.thread_id,
		body: thread.body,
		action: thread.action,
		...(thread.verdict === undefined ? {} : { verdict: thread.verdict }),
		...(thread.evidence_kind === undefined ? {} : { evidence_kind: thread.evidence_kind }),
		...(thread.evidence === undefined ? {} : { evidence: thread.evidence }),
	}
}

function sameReply(record: ReviewReplyRecord, input: ReturnType<typeof replyInput>): boolean {
	return Object.entries(input).every(([field, value]) => record[field as keyof ReviewReplyRecord] === value)
}

function serializeReplyBatch(records: readonly ReviewReplyRecord[]): string {
	const contents = records.map((record) => `${JSON.stringify(record)}\n`).join("")
	if (records.length > REPLY_LIMIT) throw new Error(`Final replies exceed the ${REPLY_LIMIT}-reply limit.`)
	if (Buffer.byteLength(contents, "utf8") > MAX_OUTPUT_FILE_BYTES) {
		throw new Error("Final replies exceed the shared 1 MiB output limit; semantic reconciliation was not published.")
	}
	return contents
}

async function prepareReplyBatch(
	outputDir: string,
	threads: readonly ReconciliationThread[],
): Promise<PreparedReplyBatch> {
	const path = reviewPanelPaths(outputDir).repliesPath
	const existing: ReviewReplyRecord[] = []
	let previousContents = ""
	if (await fileExists(path)) {
		const metadata = await lstat(path)
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Final replies are not a regular file.")
		if (metadata.size > MAX_OUTPUT_FILE_BYTES) throw new Error("Existing final replies exceed the 1 MiB output limit.")
		previousContents = await readFile(path, "utf8")
		let expectedSeq = 1
		for (const line of previousContents.split("\n")) {
			if (!line.trim()) continue
			if (line.includes("\0")) throw new Error("Existing final replies contain NUL.")
			const record = JSON.parse(line) as ReviewReplyRecord
			if (
				record.schema_version !== REPLY_SCHEMA_VERSION ||
				record.writer !== "final" ||
				record.seq !== expectedSeq ||
				record.id !== `final-${expectedSeq}` ||
				typeof record.created_at !== "string"
			) {
				throw new Error("Existing final replies have an unsupported identity, schema, or sequence.")
			}
			existing.push(record)
			expectedSeq += 1
		}
	}
	const records = [...existing]
	for (const thread of threads) {
		const input = replyInput(thread)
		if (records.some((record) => sameReply(record, input))) continue
		const seq = records.length + 1
		records.push({
			schema_version: REPLY_SCHEMA_VERSION,
			id: `final-${seq}`,
			writer: "final",
			seq,
			created_at: new Date().toISOString().replace(/\.000Z$/, "Z"),
			...input,
		})
	}
	// This validation deliberately happens before findings, replies, or semantic
	// state are published, so count/byte overflow cannot leave a partial batch.
	const contents = serializeReplyBatch(records)
	return { records, contents, changed: contents !== previousContents }
}

async function collectEnvironmentGaps(
	store: ReviewPanelStateStore,
	outputDir: string,
	coordinatorGaps: readonly EnvironmentGap[] = [],
): Promise<EnvironmentGap[]> {
	const gaps = new Map<string, EnvironmentGap>()
	for (const gap of coordinatorGaps) gaps.set(JSON.stringify([gap.kind, gap.name, gap.note]), gap)
	for (const lens of store.state.lenses) {
		if (lens.status !== "submitted") continue
		try {
			const path = join(outputDir, "summary", `${lens.writer}.json`)
			const metadata = await lstat(path)
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_OUTPUT_FILE_BYTES) {
				throw new Error("The reviewer summary is not a regular file within the 1 MiB output limit.")
			}
			const summary = JSON.parse(await readFile(path, "utf8")) as {
				environment_gaps?: EnvironmentGap[]
			}
			for (const gap of summary.environment_gaps ?? []) {
				if (gap && typeof gap.kind === "string" && typeof gap.name === "string" && typeof gap.note === "string") {
					gaps.set(JSON.stringify([gap.kind, gap.name, gap.note]), gap)
				}
			}
		} catch {
			const gap = {
				kind: "review_output",
				name: lens.id,
				note: "The reviewer summary or its environment gaps could not be read.",
			}
			gaps.set(JSON.stringify([gap.kind, gap.name, gap.note]), gap)
		}
	}
	return [...gaps.values()]
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
		.slice(0, 50)
}

function summaryBody(store: ReviewPanelStateStore, finalFindings: readonly ReviewFindingRecord[]): string {
	const coverage = coverageFor(store.state, finalFindings)
	const findingCount = finalFindings.length
	const findings = `${findingCount} final finding${findingCount === 1 ? "" : "s"} from ${coverage.candidate_count} accepted candidate${coverage.candidate_count === 1 ? "" : "s"}.`
	const priorities = Object.entries(coverage.findings_by_priority)
		.filter(([, count]) => count > 0)
		.map(([priority, count]) => `${priority}=${count}`)
		.join(", ")
	const prioritySummary = `Priority counts: ${priorities || "none"}.`
	if (coverage.status === "complete") {
		return `Coverage: complete. All ${coverage.selected_lenses} selected lenses submitted; ${findings} ${prioritySummary}`
	}
	return `Coverage: partial. Unfinished lenses: ${coverage.unfinished_lenses.join(", ")}. ${coverage.submitted_lenses}/${coverage.selected_lenses} selected lenses submitted; ${findings} ${prioritySummary}`
}

export interface FinalizeReviewPanelOptions {
	store: ReviewPanelStateStore
	outputDir: string
	contextDir: string
	/** Initial result, or a repaired result after receiving validation errors. */
	reconcile?: (validationErrors?: string) => Promise<unknown>
	hasVerifier: boolean
	/** Synchronize source writers immediately before replacing any final artifact. */
	beforePublish?: () => Promise<void>
	/** @internal Inject a new writer during the publication-boundary regression test. */
	beforeStaleCandidateCheck?: () => void | Promise<void>
	/** Reconciliation and findings are complete; report/summary writing is starting. */
	beforeReport?: () => void | Promise<void>
	/** Trusted sandbox or coordinator environment limitations, merged with reviewer reports. */
	environmentGaps?: EnvironmentGap[]
}

async function publishValidatedReconciliation(
	store: ReviewPanelStateStore,
	outputDir: string,
	digest: string,
	validated: ValidatedReconciliation,
	replies: PreparedReplyBatch,
	threadHistoryDigest: string | undefined,
): Promise<ReviewFindingRecord[]> {
	const published = capFinalReviewFindings({
		records: validated.findings,
		provenance: validated.provenance,
		provenanceTruncatedCount: validated.provenanceTruncatedCount,
	})
	await writeFinalFindings(reviewPanelPaths(outputDir).findingsPath, published.records)
	if (replies.changed) {
		await atomicWriteReviewFile(reviewPanelPaths(outputDir).repliesPath, replies.contents)
	}
	await store.update((state) => {
		state.reconciliation = {
			status: "reconciled",
			reason: "Semantic reconciliation validated and published.",
			inputDigest: digest,
			threadHistoryDigest,
			provenance: published.provenance,
			provenanceTruncatedCount: published.provenanceTruncatedCount,
			semantic: validated.semantic,
		}
		state.coverage = coverageFor(state, published.records)
	})
	return published.records
}

/** Idempotent finalization from saved candidates. Findings are always replaced
 * before the corresponding summary. A semantic failure never removes fallback. */
export async function finalizeReviewPanel(options: FinalizeReviewPanelOptions): Promise<ReviewPanelResult> {
	const { store } = options
	if (!(await sameFilesystemPath(store.state.outputDir, options.outputDir)))
		throw new Error("Finalization outputDir does not match saved panel state.")
	if (!(await sameFilesystemPath(store.state.contextDir, options.contextDir)))
		throw new Error("Finalization contextDir does not match saved panel state.")
	// Use the established spellings so aliases do not bypass downstream path-safety checks.
	const outputDir = store.state.outputDir
	const contextDir = store.state.contextDir
	const paths = reviewPanelPaths(outputDir)
	const candidates = orderedCandidates(store.state.candidates)
	const digest = candidateInputDigest(candidates)
	if (store.state.reconciliation.inputDigest !== digest || !(await fileExists(paths.findingsPath))) {
		await checkpointReviewPanelFallback(store, paths.findingsPath)
	}

	let findings = await readFinalFindings(paths.findingsPath)
	let validated: ValidatedReconciliation | undefined
	let replyBatch: PreparedReplyBatch | undefined
	const sameInput = store.state.reconciliation.inputDigest === digest
	const awaiting =
		store.state.reconciliation.reason === AWAITING_RECONCILIATION || store.state.reconciliation.status === "pending"
	const hasThreads = await fileExists(join(contextDir, "comments.json"))
	const commentsText = hasThreads ? await readFile(join(contextDir, "comments.json"), "utf8") : undefined
	const threadHistoryDigest =
		commentsText === undefined ? undefined : createHash("sha256").update(commentsText).digest("hex")
	const sameThreadHistory = store.state.reconciliation.threadHistoryDigest === threadHistoryDigest

	if (
		store.state.reconciliation.status === "reconciled" &&
		store.state.reconciliation.semantic &&
		sameInput &&
		sameThreadHistory
	) {
		try {
			const cached = store.state.reconciliation.semantic
			validated = await validateSemanticReconciliation(cached, candidates, {
				writer: "final",
				contextDir,
				outputDir,
			})
			replyBatch = await prepareReplyBatch(outputDir, cached.threads)
		} catch (error) {
			validated = undefined
			replyBatch = undefined
			const packed = buildFallbackCheckpoint(candidates)
			findings = packed.records
			await writeFinalFindings(paths.findingsPath, findings)
			await store.update((state) => {
				state.reconciliation = {
					status: "fallback",
					reason: `Cached semantic reconciliation failed validation; fallback retained: ${error instanceof Error ? error.message : String(error)}`,
					inputDigest: digest,
					threadHistoryDigest,
					provenance: packed.provenance,
					provenanceTruncatedCount: packed.provenanceTruncatedCount,
				}
				state.coverage = coverageFor(state, findings)
			})
		}
	} else if (store.state.reconciliation.status === "fallback" && sameInput && !awaiting && sameThreadHistory) {
		// A failed or unavailable reconciliation for this exact input is final;
		// repeated wrap-up calls reuse the fallback instead of changing IDs.
	} else if (candidates.length === 0 && !hasThreads) {
		await store.update((state) => {
			state.reconciliation = {
				status: "fallback",
				reason: "No candidates or thread history require semantic reconciliation.",
				inputDigest: digest,
				threadHistoryDigest,
				provenance: {},
				provenanceTruncatedCount: 0,
			}
		})
	} else if (!options.hasVerifier || !options.reconcile) {
		const packed = buildFallbackCheckpoint(candidates)
		findings = packed.records
		await store.update((state) => {
			state.reconciliation = {
				status: "fallback",
				reason: "Semantic reconciliation was unavailable; the deterministic fallback is final.",
				inputDigest: digest,
				threadHistoryDigest,
				provenance: packed.provenance,
				provenanceTruncatedCount: packed.provenanceTruncatedCount,
			}
		})
	} else {
		const requestPath = paths.reconciliationRequestPath
		const comments = commentsText === undefined ? undefined : JSON.parse(commentsText)
		await writeReviewJson(requestPath, reconciliationRequest(store.state, outputDir, contextDir, comments))
		const validate = async (response: unknown) => {
			return validateSemanticReconciliation(
				typeof response === "string" ? parseSemanticReconciliation(response) : response,
				candidates,
				{ writer: "final", contextDir, outputDir },
			)
		}
		const fallback = async (reason: string) => {
			const packed = buildFallbackCheckpoint(candidates)
			findings = packed.records
			await store.update((state) => {
				state.reconciliation = {
					status: "fallback",
					reason,
					inputDigest: digest,
					threadHistoryDigest,
					provenance: packed.provenance,
					provenanceTruncatedCount: packed.provenanceTruncatedCount,
				}
				state.coverage = coverageFor(state, findings)
			})
		}
		try {
			try {
				validated = await validate(await options.reconcile())
			} catch (error) {
				if (error instanceof ReconciliationInvocationError) throw error
				const validationReason = `Initial reconciliation failed validation: ${error instanceof Error ? error.message : String(error)}`
				try {
					const repaired = await options.reconcile(validationReason)
					validated = await validate(repaired)
				} catch (repairError) {
					throw new Error(
						`${validationReason}; repair rejected or unavailable: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
					)
				}
			}
			// Aggregate count/size validation happens before semantic publication.
			replyBatch = await prepareReplyBatch(outputDir, validated.semantic.threads)
		} catch (error) {
			validated = undefined
			replyBatch = undefined
			await fallback(
				`Semantic reconciliation rejected or unavailable; fallback retained: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	await options.beforePublish?.()
	if (validated && replyBatch) {
		findings = await publishValidatedReconciliation(
			store,
			outputDir,
			digest,
			validated,
			replyBatch,
			threadHistoryDigest,
		)
	} else {
		// Fallback records and complete provenance are one deterministic derivation.
		// Always publish both so a rerun converges after a crash between either write.
		const published = capFinalReviewFindings(buildFallbackCheckpoint(candidates))
		await writeFinalFindings(paths.findingsPath, published.records)
		await store.update((state) => {
			state.reconciliation.provenance = published.provenance
			state.reconciliation.provenanceTruncatedCount = published.provenanceTruncatedCount
		})
		findings = published.records
	}
	await options.beforeReport?.()
	const hasReplies = replyBatch ? replyBatch.records.length > 0 : await fileExists(paths.repliesPath)
	const coverage = coverageFor(store.state, findings)
	await store.update((state) => {
		state.coverage = coverage
	})
	const input = {
		body: summaryBody(store, findings),
		environment_gaps: await collectEnvironmentGaps(store, outputDir, options.environmentGaps),
		coverage,
	}
	let summary: ReviewSummaryRecord | undefined
	if (await fileExists(paths.summaryPath)) {
		const existing = JSON.parse(await readFile(paths.summaryPath, "utf8")) as ReviewSummaryRecord
		if (
			existing.schema_version === SUMMARY_SCHEMA_VERSION &&
			existing.writer === "final" &&
			existing.body === input.body &&
			JSON.stringify(existing.environment_gaps) === JSON.stringify(input.environment_gaps) &&
			JSON.stringify(existing.coverage) === JSON.stringify(input.coverage)
		) {
			summary = existing
		}
	}
	if (!summary) {
		const result = await submitSummary(input, { writer: "final", contextDir, outputDir })
		if (!result.accepted) throw new Error(`Could not write the final review summary: ${result.message}`)
		summary = JSON.parse(await readFile(paths.summaryPath, "utf8")) as ReviewSummaryRecord
	}
	if (summary.schema_version !== SUMMARY_SCHEMA_VERSION || summary.writer !== "final") {
		throw new Error("Final review summary failed read-back validation.")
	}
	const state = store.state
	return {
		state,
		progress: {
			phase: "complete",
			lenses: state.lenses.map((lens) => ({
				id: lens.id,
				writer: lens.writer,
				status: lens.status,
				reasons: [...lens.reasons],
				candidateCount: lens.candidateIds.length,
				...(lens.error ? { error: lens.error } : {}),
			})),
			counts: {
				queued: state.lenses.filter((lens) => lens.status === "queued").length,
				running: state.lenses.filter((lens) => lens.status === "running").length,
				submitted: state.lenses.filter((lens) => lens.status === "submitted").length,
				failed: state.lenses.filter((lens) => lens.status === "failed").length,
				cancelled: state.lenses.filter((lens) => lens.status === "cancelled").length,
				candidates: state.candidates.length,
			},
			coverage,
			reconciliation: { status: state.reconciliation.status, reason: state.reconciliation.reason },
		},
		findings,
		summary,
		findingsPath: paths.findingsPath,
		summaryPath: paths.summaryPath,
		...(hasReplies ? { repliesPath: paths.repliesPath } : {}),
	}
}
