/**
 * evaluator.ts — the Ferment V2 executing verifier.
 *
 * When the implementer claims completion, the host spawns the `Verifier`
 * subagent (read/bash/grep/find/ls plus confined probe writes, unlimited
 * turns, model-only inactivity) with an inline guard extension that stamps
 * every tool result with an evidence ID `[eN]` and accumulates the session's
 * usage as assistant messages complete (compaction-proof). The verifier
 * executes checks in the real working tree and reports through host-bound
 * tools (`verifier-report.ts`): findings as it observes them, then one
 * `submit_verdict`, which ends the session.
 *
 * Getting a submitted verdict matters more than strict limits:
 *
 * - a session that ends without submitting is resumed (bounded) with a
 *   reminder to submit;
 * - a configured overall timeout grants one bounded grace turn asking only
 *   for submission; the verdict then records `submittedAfterLimit`;
 * - a transport retry starts a fresh session that carries the active
 *   findings of the interrupted attempt.
 *
 * Without a submission, recorded findings still yield `continue` (they are
 * evidenced objective violations); a review with no findings is
 * `unavailable` — an incomplete review is never implementation work.
 *
 * The host keeps final-answer checks as literal comparisons, enforces
 * workspace integrity after the run (also on abort), and returns a
 * `FermentV2EvaluationResult`. When a git workspace cannot be snapshotted,
 * the verifier still runs with integrity unenforced (the prompt and the
 * result say so). Verifier bash goes through the session's permission mode.
 */

import type { Api, Model } from "@earendil-works/pi-ai"
import type { AgentEndEvent, ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent"
import { classifyLLMGatewayError } from "../../llm-gateway-error.js"
import {
	type FermentV2VerifierAgentRun,
	resumeFermentV2VerifierAgent,
	spawnFermentV2VerifierAgent,
} from "../agents/index.js"
import type { ThinkingLevel } from "../agents/personas/types.js"
import { createPermissionsExtension } from "../permissions/index.js"
import { isRedactionEnabled } from "../pii-redaction/config.js"
import piiRedactionExtension from "../pii-redaction/index.js"
import { redactTextOrThrow } from "../pii-redaction/redactor.js"
import type { TodoItem } from "../todos/types.js"
import type { FermentV2EvaluatorFailureType } from "./domain-events.js"
import { latestFinalAnswerDraft } from "./final-answer.js"
import { objectiveText } from "./objective-file.js"
import { getFermentV2Settings } from "./settings.js"
import type { FermentV2Baseline, FermentV2CompletionConfidence, FermentV2EvaluatorUsage } from "./types.js"
import {
	createVerifierGuard,
	enforceWorkspaceIntegrity,
	type IntegrityResult,
	isVerifierWritablePath,
	type VerifierGuard,
	type VerifierGuardOptions,
} from "./verifier-guard.js"
import { resolveFermentV2VerifierModel } from "./verifier-model.js"
import { buildVerifierTaskPrompt, type FermentV2VerifierFacts } from "./verifier-prompt.js"
import {
	createVerifierReport,
	type FinalAnswerCheck,
	type FindingResolution,
	formatCarriedFindings,
	type OpenFinding,
	SUBMIT_VERDICT_TOOL,
	VERIFIER_REPORT_TOOLS,
	type VerifierFinding,
	type VerifierReport,
} from "./verifier-report.js"
import {
	type BaselineWorktree,
	detectGitWorkspace,
	type GitWorkspaceProbe,
	gatherWorkspaceFacts,
	type HeadState,
	reserveBaselineWorktree,
	snapshotWorkspace,
	type WorkspaceSnapshot,
	workspaceHead,
} from "./workspace.js"

const MAX_REASON_CHARS = 1_000

/** Backoff between transient verifier failures (design: ≈5s/20s/60s). */
const VERIFIER_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000]

/** Failure reasons that are transient: the verifier is retried up to 3× with backoff. */
const TRANSIENT_FAILURE_REASONS = new Set(["rate_limit", "transport_failure", "stream_interrupted", "provider_5xx"])

/** Resumes asking a session that ended without `submit_verdict` to submit. */
export const MAX_SUBMISSION_RESUMES = 2

/** The single grace turn after the overall timeout gets its own hard deadline. */
export const SUBMISSION_GRACE_MS = 120_000

const SUBMIT_REMINDER_PROMPT =
	"You ended without submitting a verdict. Record any objective violation you observed with report_finding (citing its [eN] evidence), then call submit_verdict now. Do not repeat verification you already completed."

const SUBMISSION_GRACE_PROMPT =
	"The review time limit has been reached. Do not start new checks. Record any objective violation you already observed with report_finding (citing its [eN] evidence), then call submit_verdict now based on what you have verified."
export type FermentV2EvaluatorVerdict = "continue" | "met" | "impossible"

export interface FermentV2EvaluatorDiagnostics {
	/** The ferment revision (objective revision) this evaluation ran against. */
	objectiveRevision?: number
	durationMs: number
	timeoutMs: number
	providerRequestCount: number
	timeoutCount: number
	/** Resumes asking the verifier to submit its verdict. */
	correctionCount: number
	/** Tool calls executed by the verifier session. */
	toolCalls?: number
	/** Turns used by the verifier session. */
	turns?: number
	failureType?: FermentV2EvaluatorFailureType
	httpStatusCode?: number
}

export type FermentV2EvaluationResult =
	| {
			verdict: FermentV2EvaluatorVerdict
			reason: string
			model: string
			usage: FermentV2EvaluatorUsage
			diagnostics: FermentV2EvaluatorDiagnostics
			sameModelAsImplementer?: boolean
			modelFallback?: "session"
			unusableEvaluatorRefs?: readonly string[]
			/** The proposed final answer the verifier accepted against exact-reply requirements, for verbatim delivery. */
			acceptedFinalAnswer?: string
			/** Workspace integrity outcome of this verifier run. */
			integrity?: IntegrityResult
			/** Every finding of this review, retracted ones included. */
			findings?: readonly VerifierFinding[]
			/** The verdict was submitted during the grace turn after the overall timeout. */
			submittedAfterLimit?: boolean
			/** No verdict was submitted; the verdict comes from recorded findings. */
			incompleteReview?: boolean
			/** The host-gathered facts the verifier was given. */
			facts?: FermentV2VerifierFacts
			/** The working-tree snapshot tree this review checked; open findings remember it, so a later `fixed` needs a change. */
			workspaceTree?: string
			/** How this review settled the findings earlier reviews left open. */
			resolutions?: readonly FindingResolution[]
			/** Final-answer checks a transcript-free review recorded without comparing them. */
			uncheckedFinalAnswer?: readonly FinalAnswerCheck[]
	  }
	| {
			verdict: "unavailable"
			reason: string
			model?: string
			usage?: FermentV2EvaluatorUsage
			diagnostics: FermentV2EvaluatorDiagnostics
			sameModelAsImplementer?: boolean
			modelFallback?: "session"
			unusableEvaluatorRefs?: readonly string[]
			/** Workspace integrity outcome of this verifier run. */
			integrity?: IntegrityResult
			/** Retracted findings of an incomplete review, kept for audit. */
			findings?: readonly VerifierFinding[]
			/** The host-gathered facts the verifier was given, when the run got that far. */
			facts?: FermentV2VerifierFacts
	  }

export interface FermentV2EvaluationInput {
	objective: string
	/** The ferment revision (objective revision) this evaluation runs against, for the report. */
	objectiveRevision?: number
	/** The verifier child session's working directory (the real working tree). */
	cwd: string
	/** The implementer's conversation — used only to derive the proposed final answer. */
	messages: ReadonlyArray<AgentEndEvent["messages"][number]>
	todos: readonly TodoItem[]
	completionConfidence?: FermentV2CompletionConfidence
	/** Task-facing reason of the previous verifier `continue` verdict, when one exists. */
	previousGap?: string
	/** The ferment's baseline snapshot — the fixed point the facts, the flags, and the baseline worktree anchor to. */
	baseline?: FermentV2Baseline
	/** Findings earlier reviews left open, with the implementer's responses; each must be resolved. */
	openFindings?: readonly OpenFinding[]
	/**
	 * A headless review with no implementer conversation: there is no proposed
	 * final answer, so final-answer checks are recorded but never compared.
	 */
	transcriptFree?: boolean
	/** Fired once when the verifier run starts (after model resolution), for status-line UX. */
	onVerifierStart?: (info: { model: string }) => void
	signal?: AbortSignal
}

/** Options passed to the spawn seam. */
export interface FermentV2VerifierSpawnInput {
	model: Model<Api>
	prompt: string
	cwd: string
	extensionFactories: InlineExtension[]
	signal: AbortSignal
	/** Wall-clock cap in seconds; 0 = unlimited. */
	maxDuration: number
	/** The verifier session's thinking level (`fermentV2.verifierThinking`). */
	thinkingLevel: ThinkingLevel
	/** Ends the session once an accepted verdict submission completes. */
	shouldTerminateAfterTool: (toolName: string) => boolean
}

/** Injection seams so every branch is unit-testable without a real subagent. */
export interface FermentV2VerifierDeps {
	spawn?: (input: FermentV2VerifierSpawnInput) => Promise<FermentV2VerifierAgentRun | undefined>
	resume?: (
		id: string,
		prompt: string,
		signal: AbortSignal,
		shouldTerminateAfterTool: (toolName: string) => boolean,
	) => Promise<FermentV2VerifierAgentRun | undefined>
	/** Probes whether the workspace is a git work tree; defaults to detectGitWorkspace. */
	gitProbe?: (cwd: string, signal?: AbortSignal) => Promise<GitWorkspaceProbe>
	createGuard?: (options: VerifierGuardOptions) => VerifierGuard
	/** Creates the report tools; tests use it to observe or drive submissions. */
	createReport?: typeof createVerifierReport
	snapshot?: (cwd: string, signal?: AbortSignal) => Promise<WorkspaceSnapshot | undefined>
	head?: (cwd: string, signal?: AbortSignal) => Promise<HeadState | undefined>
	/** Reserves the run's lazy baseline worktree; defaults to reserveBaselineWorktree. */
	reserveWorktree?: (cwd: string, baseline: string) => BaselineWorktree | undefined
	enforceIntegrity?: typeof enforceWorkspaceIntegrity
	redact?: (text: string) => Promise<string>
	/** Backoff sleep; the default ends early when the signal aborts. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
	/** Grace-turn deadline; defaults to SUBMISSION_GRACE_MS. */
	graceMs?: number
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function emptyUsage(): FermentV2EvaluatorUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 }
}

function truncate(text: string, max = MAX_REASON_CHARS): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Backoff sleep that ends early when the signal aborts, so a timeout or
 * cancellation proceeds promptly to integrity cleanup instead of waiting out
 * the full delay.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer)
			resolve()
		}
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		if (signal?.aborted) {
			onAbort()
			return
		}
		signal?.addEventListener("abort", onAbort)
	})
}

function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
	const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
	if (present.length === 0) return new AbortController().signal
	return present.length === 1 ? present[0] : AbortSignal.any(present)
}

/** The task-facing gap for the implementer: each active finding as a concrete fix. */
export function findingsReason(findings: readonly VerifierFinding[], summary?: string): string {
	const items = findings.map(
		(finding) => `${finding.id} ${finding.clause}: expected ${finding.expected}; observed ${finding.observed}.`,
	)
	const body = items.length === 1 ? items[0] : items.map((item, index) => `${index + 1}. ${item}`).join(" ")
	return truncate(summary ? `${body} ${summary}` : body)
}

/** Host literal comparison of exact-output requirements against the proposed final answer. */
function finalAnswerGap(checks: readonly FinalAnswerCheck[], proposedAnswer: string | undefined): string | undefined {
	for (const check of checks) {
		const clause = JSON.stringify(check.clause.slice(0, 200))
		if (proposedAnswer === undefined) {
			return `Requirement ${clause} has not been checked against an exact proposed answer; return only the required answer with no extra text.`
		}
		if (typeof check.expected === "string" && proposedAnswer !== check.expected) {
			return `Requirement ${clause} requires exactly ${JSON.stringify(check.expected)}; return that answer with no extra text.`
		}
	}
	return undefined
}

export async function evaluateFermentV2(
	input: FermentV2EvaluationInput,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	deps?: FermentV2VerifierDeps,
): Promise<FermentV2EvaluationResult> {
	const startedAt = Date.now()
	const settings = getFermentV2Settings()
	const evaluationTimeoutMs = settings.evaluationTimeoutMs
	const sleep = deps?.sleep ?? abortableSleep

	let providerRequestCount = 0
	let timeoutCount = 0
	let correctionCount = 0
	let toolCalls = 0
	let turns = 0
	let guard: VerifierGuard | undefined
	let report: VerifierReport | undefined
	let worktree: BaselineWorktree | undefined
	let gatheredFacts: FermentV2VerifierFacts | undefined
	let modelRef: string | undefined
	let sameModelAsImplementer: boolean | undefined
	let modelFallback: "session" | undefined
	let unusableEvaluatorRefs: readonly string[] | undefined

	const diagnostics = (
		failureType?: FermentV2EvaluatorFailureType,
		httpStatusCode?: number,
	): FermentV2EvaluatorDiagnostics => ({
		...(input.objectiveRevision !== undefined ? { objectiveRevision: input.objectiveRevision } : {}),
		durationMs: Math.max(0, Date.now() - startedAt),
		timeoutMs: evaluationTimeoutMs ?? 0,
		providerRequestCount,
		timeoutCount,
		correctionCount,
		toolCalls,
		turns,
		...(failureType ? { failureType } : {}),
		...(httpStatusCode !== undefined ? { httpStatusCode } : {}),
	})

	const baseResultFields = () => ({
		...(sameModelAsImplementer ? { sameModelAsImplementer } : {}),
		...(modelFallback ? { modelFallback } : {}),
		...(unusableEvaluatorRefs?.length ? { unusableEvaluatorRefs } : {}),
		...(gatheredFacts ? { facts: gatheredFacts } : {}),
	})

	// The verifier's usage is accumulated by its in-session guard per assistant
	// message, so compaction rewriting the session messages cannot erase it.
	const verifierUsage = (): FermentV2EvaluatorUsage => (guard ? { ...guard.usage } : emptyUsage())

	const unavailable = (
		reason: string,
		failureType: FermentV2EvaluatorFailureType,
		httpStatusCode?: number,
	): FermentV2EvaluationResult => {
		const usage = verifierUsage()
		const findings = report?.findings()
		return {
			verdict: "unavailable",
			reason,
			...(modelRef ? { model: modelRef } : {}),
			...(usage.totalTokens > 0 || usage.costUsd > 0 ? { usage } : {}),
			diagnostics: diagnostics(failureType, httpStatusCode),
			...(findings?.length ? { findings } : {}),
			...baseResultFields(),
		}
	}

	// Integrity protection: the working tree is snapshotted before the run so
	// verifier changes can be reverted afterwards. Outside git there is nothing
	// to snapshot. When git cannot answer or the snapshot fails, the verifier
	// still runs with integrity unenforced — the prompt tells it not to write
	// and the result carries `integrity.unenforced` for a one-time notice — so
	// a large or unusual repository never makes completion impossible. An
	// unresolvable HEAD only disables HEAD-move detection.
	if (input.signal?.aborted) return unavailable(`Verifier ${modelRef ?? "session model"} was cancelled.`, "cancelled")
	const gitProbe = await (deps?.gitProbe ?? detectGitWorkspace)(input.cwd, input.signal)
	const before =
		gitProbe === "outside_git" ? undefined : await (deps?.snapshot ?? snapshotWorkspace)(input.cwd, input.signal)
	const integrityUnenforced = gitProbe !== "outside_git" && !before
	const beforeHead = before ? await (deps?.head ?? workspaceHead)(input.cwd, input.signal) : undefined

	let result: FermentV2EvaluationResult
	try {
		result = await runVerifier()
	} catch (error) {
		if (input.signal?.aborted) {
			result = unavailable(`Verifier ${modelRef ?? "session model"} was cancelled.`, "cancelled")
		} else {
			const classified = classifyLLMGatewayError(errorMessage(error))
			result = unavailable(
				`Verifier ${modelRef ?? "session model"} failed: ${errorMessage(error)}`,
				classified?.reason ?? "call_failed",
				classified?.httpStatusCode,
			)
		}
	}

	// Integrity runs after every verifier run — verdict, error, and abort alike.
	// The (possibly aborted) input signal is deliberately not passed: the
	// restore must complete.
	if (before) {
		try {
			const integrity = await (deps?.enforceIntegrity ?? enforceWorkspaceIntegrity)(
				input.cwd,
				before,
				beforeHead,
				undefined,
				{ createdFiles: guard?.createdFiles },
			)
			result = applyIntegrity(result, integrity, diagnostics, baseResultFields)
		} catch (error) {
			// Integrity enforcement failed (e.g. a restore could not be written or
			// git disappeared mid-run): the working tree may still carry verifier
			// changes, so a `met` verdict cannot be trusted.
			result = discardMetOnEnforcementFailure(
				result,
				`could not be enforced (${errorMessage(error)})`,
				diagnostics,
				baseResultFields,
			)
		}
	} else if (integrityUnenforced) {
		result = { ...result, integrity: UNENFORCED_INTEGRITY }
	}
	// The baseline worktree is disposed after every run — verdict, error, and
	// abort alike — once integrity has been enforced. Disposal is best-effort:
	// a leftover is pruned at the next session start.
	if (worktree) {
		const stale = worktree
		worktree = undefined
		try {
			await stale.dispose()
		} catch {
			// Removal failed (git vanished mid-run, say); nothing to retry here.
		}
	}
	return result

	async function runVerifier(): Promise<FermentV2EvaluationResult> {
		input.signal?.throwIfAborted()

		const modelChoice = await resolveFermentV2VerifierModel(ctx, settings.evaluatorModels)
		if (!modelChoice) return unavailable("No verifier model is available.", "no_model")
		const model = modelChoice.model
		modelRef = modelChoice.ref
		sameModelAsImplementer = modelChoice.sameAsImplementer || undefined
		modelFallback = modelChoice.fallback
		unusableEvaluatorRefs = modelChoice.unusableRefs

		// The baseline worktree the verifier attributes failures and checks new
		// tests in is only reserved here; the guard checks it out on the first
		// tool call that references its path. A baseline implies a git
		// workspace; `before` is the fresh snapshot the facts are diffed against.
		const reserved =
			input.baseline && before
				? (deps?.reserveWorktree ?? reserveBaselineWorktree)(input.cwd, input.baseline.commit)
				: undefined
		worktree = reserved
		const facts = await gatherVerifierFacts({
			cwd: input.cwd,
			gitProbe,
			...(before ? { before } : {}),
			...(beforeHead ? { beforeHead } : {}),
			...(input.baseline ? { baseline: input.baseline.commit } : {}),
			signal: input.signal,
		})
		gatheredFacts = facts
		const activeGuard = (deps?.createGuard ?? createVerifierGuard)({
			cwd: input.cwd,
			metadataTools: VERIFIER_REPORT_TOOLS,
			...(reserved ? { baselineWorktree: { path: reserved.path, ensure: () => reserved.ensure(input.signal) } } : {}),
		})
		guard = activeGuard
		const activeReport = (deps?.createReport ?? createVerifierReport)({
			evidence: activeGuard.evidence,
			...(input.openFindings?.length
				? {
						openFindings: input.openFindings,
						objective: objectiveText(input.objective, ctx.cwd),
						cwd: input.cwd,
						...(before ? { currentTree: before.tree } : {}),
					}
				: {}),
		})
		report = activeReport
		const shouldTerminateAfterTool = (toolName: string) =>
			toolName === SUBMIT_VERDICT_TOOL && activeReport.isSubmitted()
		const cancelled = () => input.signal?.aborted === true
		const cancelledResult = () => unavailable(`Verifier ${modelRef} was cancelled.`, "cancelled")
		// New probe files in the repository and anything inside the disposable
		// worktree are pre-approved, so they never wait on the classifier; every
		// other call follows the session's permission mode.
		const writableRoots = { cwd: input.cwd, ...(reserved ? { worktree: reserved.path } : {}) }
		const permissions = createPermissionsExtension({
			preApproved: (toolName, toolInput) =>
				VERIFIER_REPORT_TOOLS.includes(toolName) ||
				(toolName === "write" && isVerifierWritablePath(toolInput.path, writableRoots)),
		})

		const proposedAnswer = latestFinalAnswerDraft(input.messages)
		let prompt = buildVerifierTaskPrompt({
			objective: objectiveText(input.objective, ctx.cwd),
			cwd: input.cwd,
			facts,
			...(reserved ? { baselineWorktree: reserved.path } : {}),
			...(integrityUnenforced ? { integrityUnenforced } : {}),
			...(input.openFindings?.length ? { openFindings: input.openFindings } : {}),
			todos: input.todos,
			...(proposedAnswer !== undefined ? { proposedAnswer } : {}),
			...(input.previousGap ? { previousGap: input.previousGap } : {}),
		})
		// The overall timeout ends the working phase; the grace turn below has
		// its own deadline. User cancellation always ends the review at once.
		const timeoutSignal = evaluationTimeoutMs ? AbortSignal.timeout(evaluationTimeoutMs) : undefined
		const runSignal = anySignal([timeoutSignal, input.signal])
		// The spawn's wall-clock cap mirrors the optional timeout (0 = unlimited).
		const maxDuration = evaluationTimeoutMs ? Math.ceil(evaluationTimeoutMs / 1000) : 0

		input.onVerifierStart?.({ model: modelRef })
		if (isRedactionEnabled()) {
			try {
				prompt = await (deps?.redact ?? redactTextOrThrow)(prompt)
			} catch {
				return unavailable("Verifier input redaction failed.", "redaction_failed")
			}
		}

		let timedOut = false
		let failure: { reason: string; failureType: FermentV2EvaluatorFailureType; httpStatusCode?: number } | undefined
		let runId: string | undefined
		let cumulativeToolCalls = 0

		// Working phase: a transport retry starts a fresh session that carries
		// the interrupted attempt's active findings.
		const spawn = deps?.spawn ?? defaultSpawn
		for (let attempt = 0; ; attempt++) {
			if (cancelled()) return cancelledResult()
			if (timeoutSignal?.aborted) {
				timedOut = true
				break
			}
			providerRequestCount++
			activeReport.beginAttempt()
			const carried = activeReport.activeFindings()
			// The Verifier persona disables extensions, so PII redaction and the
			// permission system ride along as inline factories. Redaction (a no-op
			// when disabled) runs before the guard so the guard stamps — and
			// records as evidence excerpts — already-redacted content.
			const run = await spawn({
				model,
				prompt: carried.length ? `${prompt}\n\n${formatCarriedFindings(carried)}` : prompt,
				cwd: input.cwd,
				extensionFactories: [piiRedactionExtension, permissions, activeGuard.extension, activeReport.extension],
				signal: runSignal,
				maxDuration,
				thinkingLevel: settings.verifierThinking,
				shouldTerminateAfterTool,
			})
			if (!run) return unavailable("The verifier subagent system is not available.", "agent_unavailable")
			toolCalls += run.toolCalls
			turns += run.turns
			runId = run.id
			cumulativeToolCalls = run.toolCalls
			if (activeReport.isSubmitted()) break
			if (cancelled()) return cancelledResult()
			if (timeoutSignal?.aborted) {
				timedOut = true
				break
			}
			if (run.status === "error") {
				const classified = classifyLLMGatewayError(run.error ?? "")
				if (
					classified &&
					TRANSIENT_FAILURE_REASONS.has(classified.reason) &&
					attempt < VERIFIER_RETRY_DELAYS_MS.length
				) {
					// The abortable backoff ends early on timeout/cancellation; the
					// loop-top check reports it instead of spawning again.
					await sleep(VERIFIER_RETRY_DELAYS_MS[attempt], runSignal)
					continue
				}
				failure = {
					reason: `Verifier ${modelRef} run failed: ${run.error ?? "unknown error"}`,
					failureType: classified?.reason ?? "call_failed",
					...(classified?.httpStatusCode !== undefined ? { httpStatusCode: classified.httpStatusCode } : {}),
				}
			} else if (run.status === "stopped") {
				failure = { reason: `Verifier ${modelRef} was stopped.`, failureType: "call_failed" }
			}
			break
		}

		// A session that ended without submitting is asked to submit.
		while (runId && !activeReport.isSubmitted() && !timedOut && !failure && correctionCount < MAX_SUBMISSION_RESUMES) {
			correctionCount++
			const resumed = await resumeWithRetries(
				runId,
				SUBMIT_REMINDER_PROMPT,
				runSignal,
				cumulativeToolCalls,
				shouldTerminateAfterTool,
			)
			if (cancelled()) return cancelledResult()
			if (activeReport.isSubmitted()) break
			if (timeoutSignal?.aborted) {
				timedOut = true
				break
			}
			if (!resumed) {
				failure = { reason: `Verifier ${modelRef} could not be resumed to submit.`, failureType: "call_failed" }
				break
			}
			cumulativeToolCalls = Math.max(cumulativeToolCalls, resumed.toolCalls)
			if (resumed.status === "error") {
				const classified = classifyLLMGatewayError(resumed.error ?? "")
				failure = {
					reason: `Verifier ${modelRef} run failed: ${resumed.error ?? "unknown error"}`,
					failureType: classified?.reason ?? "call_failed",
					...(classified?.httpStatusCode !== undefined ? { httpStatusCode: classified.httpStatusCode } : {}),
				}
			}
		}

		// One bounded grace turn after the overall timeout: finishing the review
		// matters more than the limit, but the turn has its own hard deadline.
		let submittedAfterLimit = false
		if (timedOut && !activeReport.isSubmitted()) {
			timeoutCount++
			if (runId) {
				const graceSignal = anySignal([AbortSignal.timeout(deps?.graceMs ?? SUBMISSION_GRACE_MS), input.signal])
				await resumeWithRetries(
					runId,
					SUBMISSION_GRACE_PROMPT,
					graceSignal,
					cumulativeToolCalls,
					shouldTerminateAfterTool,
				)
				if (cancelled()) return cancelledResult()
				submittedAfterLimit = activeReport.isSubmitted()
			}
		}

		const submission = activeReport.submission()
		const active = activeReport.activeFindings()
		const reported = {
			findings: activeReport.findings(),
			...(activeReport.resolutions().length ? { resolutions: activeReport.resolutions() } : {}),
			...(before ? { workspaceTree: before.tree } : {}),
		}
		if (!submission) {
			// Recorded findings are evidenced objective violations: they are
			// implementation work even when the review could not finish.
			if (active.length) {
				return {
					verdict: "continue",
					reason: findingsReason(active),
					model: modelRef,
					usage: verifierUsage(),
					diagnostics: diagnostics(),
					...reported,
					incompleteReview: true,
					...baseResultFields(),
				}
			}
			if (failure) return unavailable(failure.reason, failure.failureType, failure.httpStatusCode)
			if (timedOut) {
				return unavailable(
					`Verifier ${modelRef} timed out after ${(evaluationTimeoutMs ?? 0) / 1_000} seconds without submitting a verdict.`,
					"timeout",
				)
			}
			return unavailable(`Verifier ${modelRef} ended without submitting a verdict.`, "incomplete_review")
		}

		let verdict: FermentV2EvaluatorVerdict = submission.verdict
		let reason: string
		let acceptedFinalAnswer: string | undefined
		if (verdict === "met") {
			const gap = input.transcriptFree ? undefined : finalAnswerGap(submission.finalAnswer, proposedAnswer)
			if (gap) {
				verdict = "continue"
				reason = gap
			} else {
				reason = truncate(submission.summary || "The objective is verified complete.")
				if (submission.finalAnswer.length && proposedAnswer !== undefined) acceptedFinalAnswer = proposedAnswer
			}
		} else {
			reason = findingsReason(active, submission.summary)
		}
		return {
			verdict,
			reason,
			model: modelRef,
			usage: verifierUsage(),
			diagnostics: diagnostics(),
			...(acceptedFinalAnswer !== undefined ? { acceptedFinalAnswer } : {}),
			...(input.transcriptFree && submission.finalAnswer.length
				? { uncheckedFinalAnswer: submission.finalAnswer }
				: {}),
			...reported,
			...(submittedAfterLimit ? { submittedAfterLimit } : {}),
			...baseResultFields(),
		}
	}

	function defaultSpawn(spawnInput: FermentV2VerifierSpawnInput): Promise<FermentV2VerifierAgentRun | undefined> {
		return spawnFermentV2VerifierAgent(pi, ctx, spawnInput.prompt, {
			model: spawnInput.model,
			cwd: spawnInput.cwd,
			extensionFactories: spawnInput.extensionFactories,
			signal: spawnInput.signal,
			maxDuration: spawnInput.maxDuration,
			thinkingLevel: spawnInput.thinkingLevel,
			shouldTerminateAfterTool: spawnInput.shouldTerminateAfterTool,
		})
	}

	/**
	 * Resume the verifier session with the transient retry policy: transient
	 * provider errors are retried with backoff like the spawn, while timeouts
	 * and cancellations never retry. Returns the final run (an error run when
	 * the failure is not transient) or undefined when the run cannot continue.
	 *
	 * `baselineToolCalls` is the child record's cumulative tool-call count when
	 * the previous run ended; a resume returns that same record's cumulative
	 * count (the manager never resets it), so only the delta is counted.
	 */
	async function resumeWithRetries(
		id: string,
		prompt: string,
		signal: AbortSignal,
		baselineToolCalls: number,
		shouldTerminateAfterTool: (toolName: string) => boolean,
	): Promise<FermentV2VerifierAgentRun | undefined> {
		const resume = deps?.resume ?? defaultResume
		let cumulativeToolCalls = baselineToolCalls
		for (let attempt = 0; ; attempt++) {
			// Never resume again once the run was cancelled or timed out —
			// including after a backoff whose signal aborted mid-wait.
			if (input.signal?.aborted || signal.aborted) return undefined
			providerRequestCount++
			const run = await resume(id, prompt, signal, shouldTerminateAfterTool)
			if (!run) return undefined
			if (run.toolCalls > cumulativeToolCalls) {
				toolCalls += run.toolCalls - cumulativeToolCalls
				cumulativeToolCalls = run.toolCalls
			}
			turns += run.turns
			if (report?.isSubmitted()) return run
			if (run.status === "error") {
				// An aborted signal (timeout or cancellation) surfaces as an error
				// only in flight; it is never retried.
				if (input.signal?.aborted || signal.aborted) return run
				const classified = classifyLLMGatewayError(run.error ?? "")
				if (
					classified &&
					TRANSIENT_FAILURE_REASONS.has(classified.reason) &&
					attempt < VERIFIER_RETRY_DELAYS_MS.length
				) {
					await sleep(VERIFIER_RETRY_DELAYS_MS[attempt], signal)
					continue
				}
				return run
			}
			if (run.status === "aborted" || run.status === "stopped") return undefined
			if (input.signal?.aborted || signal.aborted) return undefined
			return run
		}
	}

	function defaultResume(
		id: string,
		prompt: string,
		signal: AbortSignal,
		shouldTerminateAfterTool: (toolName: string) => boolean,
	): Promise<FermentV2VerifierAgentRun | undefined> {
		return resumeFermentV2VerifierAgent(id, prompt, { signal, shouldTerminateAfterTool })
	}
}

/** Integrity outcome attached when the before-run snapshot failed: the verifier ran without the guard. */
const UNENFORCED_INTEGRITY: IntegrityResult = {
	violated: false,
	restored: [],
	removed: [],
	headMoved: false,
	unenforced: true,
}

/**
 * Workspace facts for the run, through the one facts path: the before-run
 * snapshot compared against the ferment baseline, or against the before-run
 * HEAD commit when the ferment has none. Facts are `unavailable` when there
 * is no snapshot, nothing to compare against, or the diff fails.
 */
async function gatherVerifierFacts(request: {
	cwd: string
	gitProbe: GitWorkspaceProbe
	before?: WorkspaceSnapshot
	beforeHead?: HeadState
	baseline?: string
	signal?: AbortSignal
}): Promise<FermentV2VerifierFacts> {
	if (request.gitProbe === "outside_git") return { basis: "outside_git" }
	const against = request.baseline ?? (request.beforeHead?.kind === "commit" ? request.beforeHead.sha : undefined)
	if (!request.before || !against) return { basis: "unavailable" }
	const workspace = await gatherWorkspaceFacts(request.cwd, against, request.before, request.signal)
	if (!workspace) return { basis: "unavailable" }
	return { basis: request.baseline ? "baseline" : "head", workspace }
}

/**
 * Integrity could not be enforced or established after a run whose before-run
 * snapshot exists: the working tree's post-run state is unknown, so a `met`
 * verdict is discarded with an explicit recovery note; every other verdict
 * stands (its continuation does not certify the tree).
 */
function discardMetOnEnforcementFailure(
	result: FermentV2EvaluationResult,
	detail: string,
	diagnostics: (failureType?: FermentV2EvaluatorFailureType, httpStatusCode?: number) => FermentV2EvaluatorDiagnostics,
	baseResultFields: () => Record<string, unknown>,
): FermentV2EvaluationResult {
	if (result.verdict !== "met") return result
	return {
		verdict: "unavailable",
		reason: `Verifier workspace integrity ${detail}, so its completion verdict was discarded. The working tree may still contain verifier changes; inspect it before continuing.`,
		...(result.model ? { model: result.model } : {}),
		...(result.usage ? { usage: result.usage } : {}),
		diagnostics: diagnostics("guard_violation"),
		...baseResultFields(),
	}
}

function applyIntegrity(
	result: FermentV2EvaluationResult,
	integrity: IntegrityResult,
	diagnostics: (failureType?: FermentV2EvaluatorFailureType, httpStatusCode?: number) => FermentV2EvaluatorDiagnostics,
	baseResultFields: () => Record<string, unknown>,
): FermentV2EvaluationResult {
	if (!integrity.violated) {
		if (integrity.unenforced) {
			// A before-run snapshot exists, so `unenforced` means the post-run
			// snapshot failed — an enforcement failure, not a non-git workspace.
			return discardMetOnEnforcementFailure(
				result,
				"could not be established after the run",
				diagnostics,
				baseResultFields,
			)
		}
		return { ...result, integrity }
	}
	if (result.verdict === "met") {
		const restored = [...integrity.restored, ...integrity.removed].sort()
		const recovery = integrity.postRunSnapshot ? ` Post-run snapshot: ${integrity.postRunSnapshot}.` : ""
		return {
			verdict: "unavailable",
			reason: `The verifier modified the working tree, so its completion verdict was discarded. Restored files: ${restored.length ? restored.join(", ") : "(none)"}.${recovery}`,
			...(result.model ? { model: result.model } : {}),
			...(result.usage ? { usage: result.usage } : {}),
			diagnostics: diagnostics("guard_violation"),
			...baseResultFields(),
			integrity,
		}
	}
	return { ...result, integrity }
}
