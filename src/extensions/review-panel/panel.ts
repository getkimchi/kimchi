import { readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { raceWithTimeout } from "../../shared/race-with-timeout.js"
import { runAgent } from "../agents/manager/agent-runner.js"
import {
	type ReviewAgentResult,
	type ReviewAgentSpawner,
	type ReviewExecutionPolicyOptions,
	ReviewRunner,
} from "../review-runner/index.js"
import { MAX_OUTPUT_FILE_BYTES, SUMMARY_SCHEMA_VERSION } from "../review-submit/store.js"
import { type ResolvedReviewScope, type ResolvedReviewTarget, ReviewTargetError } from "../review-targets/index.js"
import {
	buildVerifierPrompt,
	checkpointReviewPanelFallback,
	type FinalizeReviewPanelOptions,
	finalizeReviewPanel,
} from "./finalize.js"
import {
	DEFAULT_REVIEW_CONCURRENCY,
	type ReviewLensId,
	type ReviewPanelArguments,
	resolveReviewPanel,
} from "./lenses.js"
import { cancelAndWaitForReviewChildren, trackLiveReviewChild } from "./live-children.js"
import {
	candidateInputDigest,
	createEmptyFinalCheckpoint,
	orderedCandidates,
	readFindingWriter,
	reviewPanelPaths,
} from "./output.js"
import { assertReviewPanelIdentity, createInitialPanelState, progressFor, ReviewPanelStateStore } from "./state.js"
import type {
	ReviewPanelModelOptions,
	ReviewPanelPhase,
	ReviewPanelResult,
	RunReviewPanelOptions,
	WrapUpReviewPanelOptions,
} from "./types.js"
import { ReviewPanelUsageBuffer } from "./usage.js"

const DEFAULT_RECONCILIATION_RESERVE_MS = 120_000
const DEFAULT_SUBMIT_GRACE_MS = 30_000
const DEFAULT_CANCELLATION_GRACE_MS = 1_000
const CLEANUP_EXIT_MARGIN_MS = 100
/** Time protected from reviewers, cancellation and the verifier for final atomic artifacts. */
export const REVIEW_PANEL_FINAL_WRITE_HEADROOM_MS = 5_000

async function cleanupWithDeadline(runner: ReviewRunner, deadline: number | undefined): Promise<void> {
	const cleanup = runner.cleanup()
	if (deadline === undefined) {
		await cleanup
		return
	}
	await raceWithTimeout(cleanup, Math.max(0, deadline - Date.now() - CLEANUP_EXIT_MARGIN_MS), undefined)
	// A wedged child must not delay final artifacts or session shutdown. The
	// runner manifest remains available for recovery; cleanup continues in the background.
	void cleanup.catch(() => {})
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

async function hasValidSummary(outputDir: string, lens: ReviewLensId): Promise<boolean> {
	const path = join(outputDir, "summary", `${lens}.json`)
	try {
		const metadata = await stat(path)
		if (!metadata.isFile() || metadata.size > MAX_OUTPUT_FILE_BYTES) return false
		const value = JSON.parse(await readFile(path, "utf8")) as {
			schema_version?: unknown
			writer?: unknown
			body?: unknown
			environment_gaps?: unknown
		}
		return (
			value.schema_version === SUMMARY_SCHEMA_VERSION &&
			value.writer === lens &&
			typeof value.body === "string" &&
			!value.body.includes("\0") &&
			Buffer.byteLength(value.body, "utf8") <= 64 * 1024 &&
			Array.isArray(value.environment_gaps)
		)
	} catch {
		return false
	}
}

function terminalStopReason(result: ReviewAgentResult): string | undefined {
	return [...result.session.messages].reverse().find((message) => message.role === "assistant")?.stopReason
}

function deadlineValue(value: number | undefined): number | undefined {
	if (value === undefined) return undefined
	if (!Number.isFinite(value))
		throw new ReviewTargetError("invalid_arguments", "Review deadline must be an absolute finite timestamp.")
	return value
}

function finalWriteHeadroomValue(value: number | undefined): number {
	const headroom = value ?? REVIEW_PANEL_FINAL_WRITE_HEADROOM_MS
	if (!Number.isFinite(headroom) || headroom < 0) {
		throw new ReviewTargetError(
			"invalid_arguments",
			"Review final-write headroom must be a non-negative finite duration.",
		)
	}
	return headroom
}

function reviewerPrompt(target: ResolvedReviewTarget, lens: { id: ReviewLensId; focus: string }): string {
	const scope = target.scope
	return `REVIEW_LENS ${lens.id}
Review only the pinned comparison ${scope.pinned.baseSha}..${scope.pinned.headSha}; your checkout is the pinned head. Focus: ${lens.focus}
Read review context and its original commentable-lines map from ${scope.contextDir}. Your private worktree may contain temporary tests when the inherited effective session permissions allow them; never elevate permissions. Read-only session restrictions apply to every write and command. Use run_review_check for routine repository checks and run_review_command for focused tests or base/head comparisons.
For every material claim, record the revision, exact command when applicable, and observed outcome in the submitted description. Compare the same test against base and head when that distinguishes a regression. Reviewer-created lines and temporary tests are never valid anchors.
Submit each valid material finding promptly with submit_finding. Finish with submit_summary, including missing tools or blocked dependencies in environment_gaps. Do not submit thread replies; the reconciler handles prior threads. Do not edit review output outside the submit tools.`
}

function resumeTarget(scope: ResolvedReviewScope): ResolvedReviewTarget {
	return {
		scope,
		// Original stage 2/3 owners retain snapshot-ref ownership. Interrupted runs
		// are reclaimed by review-runner recovery, not by an unrelated resume.
		cleanup: async () => {},
	}
}

interface RunnerPanelContext {
	runner: ReviewRunner
	store: ReviewPanelStateStore
	outputDir: string
	usage: ReviewPanelUsageBuffer
}

function childAgentOptions(
	base: ReviewPanelModelOptions | undefined,
	writer: string,
	usage: ReviewPanelUsageBuffer,
	onToolActivity?: ReviewPanelModelOptions["onToolActivity"],
): ReviewPanelModelOptions {
	return {
		...base,
		onSessionCreated: (session) => {
			base?.onSessionCreated?.(session)
			usage.attach(writer, session)
		},
		onToolActivity: (activity) => {
			base?.onToolActivity?.(activity)
			onToolActivity?.(activity)
		},
	}
}

function verifierCall(
	context: RunnerPanelContext,
	options: {
		deadline?: number
		headroomMs: number
		agent?: ReviewPanelModelOptions
		signal?: AbortSignal
		respectSignal: boolean
	},
): { hasVerifier: boolean; reconcile?: () => Promise<string> } {
	const available = options.deadline === undefined || options.deadline - Date.now() > options.headroomMs
	if (!available || options.signal?.aborted) return { hasVerifier: false }
	return {
		hasVerifier: true,
		reconcile: async () => {
			const remaining = options.deadline === undefined ? 120_000 : options.deadline - Date.now() - options.headroomMs
			if (remaining <= 0) throw new Error("The reconciliation reserve has no verifier time remaining.")
			const timeout = new AbortController()
			const signal =
				options.respectSignal && options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal
			const requestPath = reviewPanelPaths(context.outputDir).reconciliationRequestPath
			const hasThreads = await exists(join(context.store.state.contextDir, "comments.json"))
			const verification = context.runner.spawnVerifier({
				id: "reconciliation",
				type: "General-Purpose",
				prompt: buildVerifierPrompt(requestPath, hasThreads),
				signal,
				agent: {
					...childAgentOptions(options.agent, "reconciliation", context.usage),
					maxDuration: Math.max(1, Math.floor(remaining / 1000)),
				},
			})
			const outcome = await raceWithTimeout(
				verification.then((result) => ({ kind: "settled" as const, result })),
				remaining,
				{ kind: "timeout" as const },
				() => timeout.abort(),
			)
			if (outcome.kind === "timeout") {
				context.runner.cancelReviewer("reconciliation", new Error("Semantic verifier settlement window expired"))
				throw new Error("Semantic verifier did not settle within the reconciliation window; using fallback.")
			}
			const result = outcome.result
			if (result.aborted) throw new Error("The semantic verifier was cancelled before returning output.")
			return result.responseText
		},
	}
}

async function makeRunner(options: {
	ctx: RunReviewPanelOptions["ctx"]
	pi: RunReviewPanelOptions["pi"]
	target: ResolvedReviewTarget
	outputDir: string
	concurrency: number
	checkDefinitions?: RunReviewPanelOptions["checkDefinitions"]
	executionPolicy?: ReviewExecutionPolicyOptions
	rootDir?: string
	spawnAgent?: ReviewAgentSpawner
}): Promise<ReviewRunner> {
	let runner: ReviewRunner
	const spawnAgent: ReviewAgentSpawner = async (request) => {
		const run = (
			options.spawnAgent ??
			(({ ctx, type, prompt, options: agentOptions }) => runAgent(ctx, type, prompt, agentOptions))
		)(request)
		const writer = request.options.description?.startsWith("Review writer ")
			? request.options.description.slice("Review writer ".length)
			: "unknown"
		return trackLiveReviewChild(options.outputDir, writer, run, () => {
			if (writer === "unknown") runner.cancelActiveReviewers()
			else runner.cancelReviewer(writer)
		})
	}
	runner = await ReviewRunner.create({
		ctx: options.ctx,
		pi: options.pi,
		target: options.target,
		outputDir: options.outputDir,
		concurrency: options.concurrency,
		checkDefinitions: options.checkDefinitions,
		executionPolicy: options.executionPolicy,
		rootDir: options.rootDir,
		spawnAgent,
	})
	return runner
}

async function ingestLensCandidateFile(
	store: ReviewPanelStateStore,
	outputDir: string,
	lens: ReviewLensId,
): Promise<void> {
	if (store.isClosed) return
	const records = await readFindingWriter(join(outputDir, "findings", `${lens}.jsonl`), lens, {
		writer: "final",
		contextDir: store.state.contextDir,
		outputDir,
	})
	const known = new Map(store.state.candidates.map((candidate) => [candidate.id, candidate]))
	for (const finding of records) {
		const previous = known.get(finding.id)
		if (previous && JSON.stringify(previous.finding) !== JSON.stringify(finding)) {
			throw new Error(`Candidate ${finding.id} changed after acceptance; candidate IDs must remain stable.`)
		}
	}
	const additions = records.filter((record) => !known.has(record.id))
	if (additions.length === 0 || store.isClosed) return
	await store.update((state) => {
		for (const finding of additions) state.candidates.push({ id: finding.id, lens, finding })
		state.candidates = orderedCandidates(state.candidates)
		const lensState = state.lenses.find((entry) => entry.id === lens)
		if (lensState) {
			lensState.candidateIds = state.candidates
				.filter((candidate) => candidate.lens === lens)
				.map((candidate) => candidate.id)
		}
		state.coverage.candidate_count = state.candidates.length
		state.reconciliation = { status: "pending", reason: "New reviewer candidates require a fallback checkpoint." }
	})
	if (store.isClosed) return
	await checkpointReviewPanelFallback(store, reviewPanelPaths(outputDir).findingsPath)
}

class StaleCandidateInputError extends Error {}

async function rescanAllWriters(store: ReviewPanelStateStore, outputDir: string): Promise<void> {
	for (const lens of store.state.lenses) await ingestLensCandidateFile(store, outputDir, lens.id)
}

async function finalizeWithWriterRescan(
	store: ReviewPanelStateStore,
	outputDir: string,
	options: Pick<FinalizeReviewPanelOptions, "hasVerifier" | "reconcile">,
): Promise<ReviewPanelResult> {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const inputDigest = candidateInputDigest(store.state.candidates)
		try {
			return await finalizeReviewPanel({
				store,
				outputDir,
				contextDir: store.state.contextDir,
				...options,
				beforePublish: async () => {
					await rescanAllWriters(store, outputDir)
					if (candidateInputDigest(store.state.candidates) !== inputDigest) {
						throw new StaleCandidateInputError()
					}
				},
			})
		} catch (error) {
			if (!(error instanceof StaleCandidateInputError)) throw error
		}
	}
	// Continually arriving submissions are bounded by the final fallback
	// publication; anything after its source scan belongs to the next wrap-up.
	return finalizeReviewPanel({ store, outputDir, contextDir: store.state.contextDir, hasVerifier: false })
}

/** Run a fresh panel. Stage 5 passes parser panel fields directly plus trusted
 * requiredLenses; a manifest deadline is converted to epoch milliseconds. */
export async function runReviewPanel(options: RunReviewPanelOptions): Promise<ReviewPanelResult> {
	options.signal?.throwIfAborted()
	const deadline = deadlineValue(options.deadline)
	const headroomMs = finalWriteHeadroomValue(options.finalWriteHeadroomMs)
	const outputDir = resolve(options.outputDir)
	const paths = reviewPanelPaths(outputDir)
	if (await exists(paths.statePath)) {
		throw new ReviewTargetError(
			"panel_exists",
			"Review panel state already exists; use wrapUpReviewPanel to resume it.",
		)
	}
	const panelArgs = {
		lenses: [...(options.lenses ?? [])],
		all: options.all === true,
		concurrency: options.concurrency ?? DEFAULT_REVIEW_CONCURRENCY,
	}
	const selection = resolveReviewPanel({
		lenses: panelArgs.lenses,
		all: panelArgs.all,
		concurrency: panelArgs.concurrency,
		requiredLenses: options.requiredLenses,
	})
	await createEmptyCheckpointAndState(options, outputDir, panelArgs, selection)

	let phase: ReviewPanelPhase = "reviewing"
	const store = await ReviewPanelStateStore.load(outputDir, (state) => options.onProgress?.(progressFor(state, phase)))
	const usage = new ReviewPanelUsageBuffer(options.onChildUsage, options.parentToolCallId, options.onUsageDropped)
	const runner = await makeRunner({
		ctx: options.ctx,
		pi: options.pi,
		target: options.target,
		outputDir,
		concurrency: selection.slotCount,
		checkDefinitions: options.checkDefinitions,
		executionPolicy: options.executionPolicy,
		rootDir: options.rootDir,
		spawnAgent: options.spawnAgent,
	})
	const context: RunnerPanelContext = { runner, store, outputDir, usage }
	let ingestTail: Promise<void> = Promise.resolve()
	const active = new Map<ReviewLensId, Promise<void>>()
	let nextLens = 0
	let reserveStarted = false
	let reservePromise: Promise<void> | undefined
	let timer: ReturnType<typeof setTimeout> | undefined

	const ingestNow = async (lens: ReviewLensId) => ingestLensCandidateFile(store, outputDir, lens)
	const queueIngest = (lens: ReviewLensId): Promise<void> => {
		if (store.isClosed) return Promise.resolve()
		const operation = ingestTail.catch(() => {}).then(() => ingestNow(lens))
		ingestTail = operation.catch(() => {})
		return operation
	}

	const runLens = async (lens: (typeof selection.lenses)[number]): Promise<void> => {
		await store.update((state) => {
			const current = state.lenses.find((entry) => entry.id === lens.id)
			if (current) current.status = "running"
		})
		// Reserve may begin while the running-state write is queued. Never enter
		// the runner after that point, even if this worker already claimed a slot.
		if (reserveStarted) {
			await store.update((state) => {
				const current = state.lenses.find((entry) => entry.id === lens.id)
				if (current) {
					current.status = "cancelled"
					current.error = "The reconciliation reserve began before this reviewer launched."
				}
			})
			return
		}
		let result: ReviewAgentResult | undefined
		let failure: unknown
		try {
			result = await runner.spawnReviewer({
				id: lens.writer,
				type: "General-Purpose",
				prompt: reviewerPrompt(options.target, lens),
				agent: childAgentOptions(options.agent, lens.writer, usage, (activity) => {
					if (!store.isClosed && activity.toolName === "submit_finding" && activity.status === "completed") {
						void queueIngest(lens.id).catch(() => {})
					}
				}),
			})
			await queueIngest(lens.id)
		} catch (error) {
			failure = error
			runner.cancelReviewer(lens.writer, error)
			try {
				await queueIngest(lens.id)
			} catch (ingestError) {
				failure = new AggregateError([error, ingestError], `Reviewer and candidate ingest failed for ${lens.id}.`)
			}
		}
		const cancelled = reserveStarted || result?.aborted === true || options.signal?.aborted === true
		if (!failure && !cancelled && result) {
			const stopReason = terminalStopReason(result)
			if (stopReason === "error") {
				failure = new Error(`Reviewer ${lens.id} ended with a terminal provider error.`)
			} else if (stopReason === undefined) {
				failure = new Error(`Reviewer ${lens.id} has no final assistant stop reason.`)
			} else {
				const hasCandidate = store.state.candidates.some((candidate) => candidate.lens === lens.id)
				const hasSummary = await hasValidSummary(outputDir, lens.id)
				if (!hasCandidate && !hasSummary) {
					failure = new Error(
						`Reviewer ${lens.id} ended without an accepted candidate or valid summary (no_submission).`,
					)
				}
			}
		}
		await store.update((state) => {
			const current = state.lenses.find((entry) => entry.id === lens.id)
			if (!current) return
			current.status = cancelled ? "cancelled" : failure ? "failed" : "submitted"
			current.error = failure
				? failure instanceof Error
					? failure.message
					: String(failure)
				: cancelled
					? "Reviewer was cancelled before completing its lens."
					: undefined
			if (result) {
				current.worktreePath = result.worktree.path
				current.commands = [...result.execution.records]
			}
		})
	}

	let notifyReserve!: () => void
	const reserveTriggered = new Promise<void>((resolveReserve) => {
		notifyReserve = resolveReserve
	})
	const beginReserve = (): Promise<void> => {
		if (reservePromise) return reservePromise
		reserveStarted = true
		notifyReserve()
		phase = "reserve"
		runner.beginWrapUp()
		reservePromise = (async () => {
			await store.update((state) => {
				for (const lens of state.lenses) {
					if (lens.status === "queued") {
						lens.status = "cancelled"
						lens.error = "The reconciliation reserve began before this lens launched."
					}
				}
			})
			options.onProgress?.(progressFor(store.state, phase))
			await usage.flush()
			const headroom = headroomMs
			const cutoff = deadline === undefined ? undefined : deadline - headroom
			const pending = [...active.values()]
			const submitGrace = options.submitGraceMs ?? DEFAULT_SUBMIT_GRACE_MS
			const submitBound = cutoff === undefined ? submitGrace : Math.max(0, cutoff - Date.now())
			await raceWithTimeout(Promise.all(pending), Math.min(submitGrace, submitBound), undefined)
			runner.cancelActiveReviewers(new Error("Review panel reconciliation reserve began"))
			const cancellationGrace = options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS
			const cancellationBound = cutoff === undefined ? cancellationGrace : Math.max(0, cutoff - Date.now())
			await raceWithTimeout(Promise.all(pending), Math.min(cancellationGrace, cancellationBound), undefined)
			await store.update((state) => {
				for (const lens of state.lenses) {
					if (lens.status === "running") {
						lens.status = "cancelled"
						lens.error = "Reviewer did not settle within the post-cancellation grace; finalizing durable evidence."
					}
				}
			})
			await ingestTail
		})()
		return reservePromise
	}

	try {
		const reserveAt =
			deadline === undefined
				? undefined
				: deadline - (options.reconciliationReserveMs ?? DEFAULT_RECONCILIATION_RESERVE_MS)
		const finalWriteCutoff = deadline === undefined ? undefined : deadline - headroomMs
		if (options.signal?.aborted || (reserveAt !== undefined && reserveAt <= Date.now())) {
			void beginReserve()
		} else if (finalWriteCutoff !== undefined && finalWriteCutoff <= Date.now()) {
			void beginReserve()
		} else if (reserveAt !== undefined) {
			timer = setTimeout(() => void beginReserve(), reserveAt - Date.now())
		}
		const abort = () => void beginReserve()
		options.signal?.addEventListener("abort", abort, { once: true })
		const workers = Array.from({ length: selection.slotCount }, async () => {
			while (!reserveStarted && nextLens < selection.lenses.length) {
				const lens = selection.lenses[nextLens]
				nextLens += 1
				const operation = runLens(lens).finally(() => active.delete(lens.id))
				active.set(lens.id, operation)
				await operation
			}
		})
		try {
			const allWorkers = Promise.all(workers)
			await Promise.race([allWorkers, reserveTriggered])
			if (reservePromise) await reservePromise
			else await allWorkers
		} finally {
			if (timer) clearTimeout(timer)
			options.signal?.removeEventListener("abort", abort)
		}
		if (!reserveStarted) runner.beginWrapUp()
		phase = "reconciling"
		options.onProgress?.(progressFor(store.state, phase))
		const verifier = verifierCall(context, {
			deadline,
			headroomMs,
			agent: options.reconciliationAgent ?? options.agent,
			respectSignal: false,
		})
		const result = await finalizeWithWriterRescan(store, outputDir, verifier)
		await usage.flush()
		options.onProgress?.(result.progress)
		return result
	} finally {
		try {
			await store.close()
			await cleanupWithDeadline(runner, deadline)
		} finally {
			try {
				await usage.flush({ deadline, exitMarginMs: CLEANUP_EXIT_MARGIN_MS })
			} finally {
				usage.close()
			}
		}
	}
}

/** Finish an interrupted panel without launching any reviewer. A changed
 * manifest deadline is accepted, while the pinned identity must match exactly. */
export async function wrapUpReviewPanel(options: WrapUpReviewPanelOptions): Promise<ReviewPanelResult> {
	const outputDir = resolve(options.outputDir)
	const deadline = deadlineValue(options.deadline)
	const headroomMs = finalWriteHeadroomValue(options.finalWriteHeadroomMs)
	const cancellationBound =
		deadline === undefined
			? (options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS)
			: Math.min(
					options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS,
					Math.max(0, deadline - headroomMs - Date.now()),
				)
	await cancelAndWaitForReviewChildren(outputDir, cancellationBound)
	let phase: ReviewPanelPhase = "reserve"
	const store = await ReviewPanelStateStore.load(outputDir, (state) => options.onProgress?.(progressFor(state, phase)))
	assertReviewPanelIdentity(store.state, options.expected)
	for (const lens of store.state.lenses) {
		try {
			await ingestLensCandidateFile(store, outputDir, lens.id)
		} catch (error) {
			await store.update((state) => {
				const current = state.lenses.find((entry) => entry.id === lens.id)
				if (current) {
					current.status = "failed"
					current.error = `Saved candidate ingest failed: ${error instanceof Error ? error.message : String(error)}`
				}
			})
		}
	}
	// No reviewer launch is possible during wrap-up, including crashed running entries.
	await store.update((state) => {
		for (const lens of state.lenses) {
			if (lens.status === "queued" || lens.status === "running") {
				lens.status = "cancelled"
				lens.error = "The panel did not finish before wrap-up."
			}
		}
	})
	const usage = new ReviewPanelUsageBuffer(options.onChildUsage, options.parentToolCallId, options.onUsageDropped)
	const runner = await makeRunner({
		ctx: options.ctx,
		pi: options.pi,
		target: resumeTarget(store.state.scope),
		outputDir,
		concurrency: 1,
		checkDefinitions: options.checkDefinitions,
		executionPolicy: options.executionPolicy,
		rootDir: options.rootDir,
		spawnAgent: options.spawnAgent,
	})
	runner.beginWrapUp()
	try {
		phase = "reconciling"
		options.onProgress?.(progressFor(store.state, phase))
		const context: RunnerPanelContext = { runner, store, outputDir, usage }
		const verifier = verifierCall(context, {
			deadline,
			headroomMs,
			agent: options.reconciliationAgent,
			signal: options.signal,
			respectSignal: true,
		})
		const result = await finalizeWithWriterRescan(store, outputDir, verifier)
		await usage.flush()
		options.onProgress?.(result.progress)
		return result
	} finally {
		try {
			await store.close()
			await cleanupWithDeadline(runner, deadline)
		} finally {
			try {
				await usage.flush({ deadline, exitMarginMs: CLEANUP_EXIT_MARGIN_MS })
			} finally {
				usage.close()
			}
		}
	}
}

async function createEmptyCheckpointAndState(
	options: RunReviewPanelOptions,
	outputDir: string,
	panelArgs: ReviewPanelArguments,
	selection: ReturnType<typeof resolveReviewPanel>,
): Promise<void> {
	await createEmptyFinalCheckpoint(reviewPanelPaths(outputDir).findingsPath)
	await ReviewPanelStateStore.create(
		createInitialPanelState(options.target, selection, panelArgs, options.requiredLenses ?? [], outputDir),
		outputDir,
	)
}
