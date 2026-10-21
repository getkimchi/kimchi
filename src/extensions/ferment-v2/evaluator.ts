/**
 * evaluator.ts — the Ferment V2 executing verifier.
 *
 * When the implementer claims completion, the host spawns the `Verifier`
 * subagent (read/bash/grep/find/ls, unlimited turns and duration, model-only
 * inactivity) with an inline guard extension that stamps every tool result
 * with an evidence ID `[eN]` and accumulates the session's usage as
 * assistant messages complete (compaction-proof). The verifier executes
 * checks in the real working tree; the host validates its JSON verdict
 * (citations must exist in the guard's evidence), keeps final-answer checks
 * as literal host comparisons, enforces workspace integrity after the run
 * (also on abort), and returns a `FermentV2EvaluationResult`. When a git
 * workspace cannot be snapshotted, the verifier still runs with integrity
 * unenforced (the prompt and the result say so), so completion never
 * depends on the snapshot succeeding. Verifier bash goes through the
 * session's permission mode (the permissions extension rides along).
 *
 * The previous single-shot `completeSimple` call over a transcript digest is
 * gone; `evaluateFermentV2` and the result shape remain the seam used by
 * `index.ts`.
 */

import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
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
import { getRedactionConfig } from "../pii-redaction/config.js"
import piiRedactionExtension from "../pii-redaction/index.js"
import { redactTextOrThrow } from "../pii-redaction/redactor.js"
import type { TodoItem } from "../todos/types.js"
import type { FermentV2EvaluatorFailureType } from "./domain-events.js"
import { latestFinalAnswerDraft } from "./final-answer.js"
import { objectiveText } from "./objective-file.js"
import { isRecord } from "./reducer.js"
import { getFermentV2Settings } from "./settings.js"
import type { FermentV2Baseline, FermentV2CompletionConfidence, FermentV2EvaluatorUsage } from "./types.js"
import {
	createVerifierGuard,
	enforceWorkspaceIntegrity,
	type IntegrityResult,
	isVerifierWritablePath,
	type VerifierEvidence,
	type VerifierGuard,
	type VerifierGuardOptions,
} from "./verifier-guard.js"
import { resolveFermentV2VerifierModel } from "./verifier-model.js"
import { buildVerifierTaskPrompt, type FermentV2VerifierFacts } from "./verifier-prompt.js"
import {
	type BaselineWorktree,
	detectGitWorkspace,
	type GitWorkspaceProbe,
	gatherWorkspaceFacts,
	type HeadState,
	listSnapshotPaths,
	reserveBaselineWorktree,
	type SnapshotPaths,
	snapshotWorkspace,
	type TestInventoryFlag,
	type WorkspaceSnapshot,
	workspaceHead,
} from "./workspace.js"

const MAX_REASON_CHARS = 1_000

/** Maximum characters of a failing check's evidence excerpt embedded in the task-facing reason (design: ≤300). */
const FAILING_CHECK_EXCERPT_CHARS = 300

/** Backoff between transient verifier failures (design: ≈5s/20s/60s). */
const VERIFIER_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000]

/** Failure reasons that are transient: the verifier is retried up to 3× with backoff. */
const TRANSIENT_FAILURE_REASONS = new Set(["rate_limit", "transport_failure", "stream_interrupted", "provider_5xx"])

/**
 * Correction prompt for a verdict whose verification procedure is incomplete
 * (a behaviour passed on non-independent evidence, or a flagged pre-existing
 * test was never run in its baseline version): the verifier must do the
 * missing work with its tools, not just relabel the checks.
 */
const INCOMPLETE_PROCEDURE_CORRECTION_PROMPT =
	"Host validation found the verification incomplete: {reason} Do the missing checks now with your tools — write and run the probes or baseline test copies — then end with exactly one JSON object matching the output contract, citing the new [eN] results."

/** Check categories: only `behavior` passes need independent evidence. A missing category counts as `behavior`. */
const CHECK_CATEGORIES = ["behavior", "constraint", "delivery"] as const

/** How a check was verified; `implementer_test` and `inspection` are not independent evidence for a behaviour. */
const CHECK_METHODS = ["probe", "existing_test", "baseline_test", "command", "implementer_test", "inspection"] as const

const INDEPENDENT_METHODS: ReadonlySet<FermentV2VerifierCheckMethod> = new Set([
	"probe",
	"existing_test",
	"baseline_test",
	"command",
])

/** How many procedure gaps one correction prompt lists. */
const MAX_PROCEDURE_GAPS = 8

/** Flag kinds whose pre-existing test file must be run in its baseline version (`baseline_test`). */
const BASELINE_TEST_FLAG_KINDS: ReadonlySet<string> = new Set([
	"test_file_modified",
	"test_file_deleted",
	"test_file_renamed",
])

const INVALID_OUTPUT_CORRECTION_PROMPT =
	'The previous response was rejected by host validation: {reason} Return exactly one valid JSON object matching the output contract and nothing else. Cite only [eN] evidence IDs that appear in your tool results. Every "pass" check needs cited evidence and a failureMode; a "continue" verdict needs at least one cited "fail" check; an "impossible" verdict needs at least one check citing executed evidence; when the task lists test-inventory flag IDs, a met verdict needs every flag addressed in some check\'s flags array.'

export type FermentV2EvaluatorVerdict = "continue" | "met" | "impossible"

export interface FermentV2EvaluatorDiagnostics {
	durationMs: number
	timeoutMs: number
	providerRequestCount: number
	timeoutCount: number
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
			acceptedFinalAnswer?: string
			sameModelAsImplementer?: boolean
			modelFallback?: "session"
			unusableEvaluatorRefs?: readonly string[]
			/** Workspace integrity outcome of this verifier run. */
			integrity?: IntegrityResult
			/** The verifier's checks behind the verdict (as returned, before host downgrades). */
			checks?: readonly FermentV2VerifierCheck[]
			/** The host-gathered facts the verifier was given. */
			facts?: FermentV2VerifierFacts
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
			/** The host-gathered facts the verifier was given, when the run got that far. */
			facts?: FermentV2VerifierFacts
	  }

export interface FermentV2EvaluationInput {
	objective: string
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
	/** Kept failing probes from earlier verifier runs, flagged when modified or deleted. */
	keptProbes?: readonly { path: string; requirementId: string }[]
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
}

/** Injection seams so every validation branch is unit-testable without a real subagent. */
export interface FermentV2VerifierDeps {
	spawn?: (input: FermentV2VerifierSpawnInput) => Promise<FermentV2VerifierAgentRun | undefined>
	resume?: (id: string, prompt: string, signal: AbortSignal) => Promise<FermentV2VerifierAgentRun | undefined>
	/** Probes whether the workspace is a git work tree; defaults to detectGitWorkspace. */
	gitProbe?: (cwd: string, signal?: AbortSignal) => Promise<GitWorkspaceProbe>
	createGuard?: (options: VerifierGuardOptions) => VerifierGuard
	snapshot?: (cwd: string, signal?: AbortSignal) => Promise<WorkspaceSnapshot | undefined>
	head?: (cwd: string, signal?: AbortSignal) => Promise<HeadState | undefined>
	/** Reserves the run's lazy baseline worktree; defaults to reserveBaselineWorktree. */
	reserveWorktree?: (cwd: string, baseline: string) => BaselineWorktree | undefined
	enforceIntegrity?: typeof enforceWorkspaceIntegrity
	redact?: (text: string) => Promise<string>
	/** Backoff sleep; the default ends early when the signal aborts. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export type FermentV2VerifierCheckCategory = (typeof CHECK_CATEGORIES)[number]
export type FermentV2VerifierCheckMethod = (typeof CHECK_METHODS)[number]

export interface FermentV2VerifierCheck {
	kind?: "work" | "final_answer"
	category?: FermentV2VerifierCheckCategory
	method?: FermentV2VerifierCheckMethod
	requirement: string
	status: "pass" | "fail" | "unverifiable"
	failureMode?: string
	candidateRef?: string
	observedAnswer?: string
	expectedAnswer?: string | null
	evidence: string[]
	/** Test-inventory flag IDs (f1, f2, …) this check addresses. */
	flags?: string[]
}

interface ParsedFermentV2EvaluatorOutput {
	verdict: FermentV2EvaluatorVerdict
	reason: string
	checks?: FermentV2VerifierCheck[]
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function emptyUsage(): FermentV2EvaluatorUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 }
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

function normalizeEvidenceId(evidence: string): string {
	const normalized = evidence.trim()
	return normalized.match(/^\[?(e\d+)\]?(?:\s|$)/i)?.[1]?.toLowerCase() ?? normalized
}

export function parseFermentV2EvaluatorOutput(raw: string): ParsedFermentV2EvaluatorOutput | undefined {
	for (const candidate of jsonObjects(raw)) {
		const value = candidate as unknown
		if (!isRecord(value)) continue
		if (value.verdict !== "continue" && value.verdict !== "met" && value.verdict !== "impossible") continue
		if (typeof value.reason !== "string" || !value.reason.trim()) continue
		const hasChecks = Object.hasOwn(value, "checks")
		const checks = parseChecks(value.checks)
		if (hasChecks && checks === undefined) continue
		// The reason stays the verifier's own task-facing summary here — the
		// failing-check composition needs the guard's evidence map and happens
		// in validation (failingCheckReason), not in parsing.
		return {
			verdict: value.verdict,
			reason: value.reason.trim().slice(0, MAX_REASON_CHARS),
			...(checks ? { checks } : {}),
		}
	}
	return undefined
}

function parseChecks(value: unknown): FermentV2VerifierCheck[] | undefined {
	if (!Array.isArray(value)) return undefined
	const checks: FermentV2VerifierCheck[] = []
	for (const candidate of value) {
		if (!isRecord(candidate) || typeof candidate.requirement !== "string" || !candidate.requirement.trim()) {
			return undefined
		}
		if (candidate.status !== "pass" && candidate.status !== "fail" && candidate.status !== "unverifiable") {
			return undefined
		}
		const evidence =
			(candidate.evidence === undefined || candidate.evidence === null) && candidate.kind === "final_answer"
				? []
				: candidate.evidence
		if (
			!Array.isArray(evidence) ||
			(candidate.kind !== undefined && candidate.kind !== "work" && candidate.kind !== "final_answer") ||
			(candidate.candidateRef !== undefined &&
				candidate.candidateRef !== null &&
				typeof candidate.candidateRef !== "string") ||
			(candidate.observedAnswer !== undefined &&
				candidate.observedAnswer !== null &&
				typeof candidate.observedAnswer !== "string") ||
			(candidate.kind === "final_answer" &&
				candidate.expectedAnswer !== null &&
				typeof candidate.expectedAnswer !== "string")
		) {
			return undefined
		}
		if (evidence.some((item) => typeof item !== "string" || !item.trim())) return undefined
		const flags = candidate.flags
		if (
			flags !== undefined &&
			(!Array.isArray(flags) || flags.some((item) => typeof item !== "string" || !item.trim().match(/^f\d+$/)))
		) {
			return undefined
		}
		const category = CHECK_CATEGORIES.find((value) => value === normalizeLabel(candidate.category))
		const method = CHECK_METHODS.find((value) => value === normalizeLabel(candidate.method))
		checks.push({
			...(candidate.kind ? { kind: candidate.kind } : {}),
			...(category ? { category } : {}),
			...(method ? { method } : {}),
			requirement: candidate.requirement.trim(),
			status: candidate.status,
			...(typeof candidate.failureMode === "string" && candidate.failureMode.trim()
				? { failureMode: candidate.failureMode.trim() }
				: {}),
			...(typeof candidate.candidateRef === "string" ? { candidateRef: candidate.candidateRef } : {}),
			...(typeof candidate.observedAnswer === "string" ? { observedAnswer: candidate.observedAnswer } : {}),
			...(typeof candidate.expectedAnswer === "string" || candidate.expectedAnswer === null
				? { expectedAnswer: candidate.expectedAnswer }
				: {}),
			evidence: evidence.map(normalizeEvidenceId),
			...(flags !== undefined ? { flags: flags.map((item) => item.trim()) } : {}),
		})
	}
	return checks
}

/** `"Existing test"` / `"existing-test"` → `"existing_test"`; anything else unrecognised is dropped by the caller. */
function normalizeLabel(value: unknown): string | undefined {
	return typeof value === "string"
		? value
				.trim()
				.toLowerCase()
				.replace(/[\s-]+/g, "_")
		: undefined
}

/**
 * Yields each `{...}` run, pairing every `}` with its own opener via a stack so
 * unmatched braces in surrounding prose cannot swallow the verdict object. One
 * parse attempt per closing brace, rather than one per brace pair.
 */
function* jsonObjects(raw: string): Generator<unknown> {
	const starts: number[] = []
	let inString = false
	let escaped = false
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') inString = true
		else if (char === "{") starts.push(i)
		else if (char === "}") {
			const start = starts.pop()
			if (start === undefined) continue
			try {
				yield JSON.parse(raw.slice(start, i + 1))
			} catch {}
		}
	}
}

/** Evidence IDs cited by the verdict that the guard never stamped — hallucinated citations. */
function unknownEvidenceIds(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): string[] {
	const unknown: string[] = []
	for (const check of checks ?? []) {
		for (const id of check.evidence) {
			if (!evidence.has(id) && !unknown.includes(id)) unknown.push(id)
		}
	}
	return unknown
}

/** Host reason when a `met` verdict is not backed by the verifier's own evidence. */
function unsupportedMetReason(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
	proposedAnswer: string | undefined,
): string | undefined {
	if (!checks?.length) return "Map each objective requirement to a check backed by executed evidence before finishing."
	for (const check of checks) {
		const requirement = JSON.stringify(check.requirement.slice(0, 200))
		if (check.status === "fail") {
			const excerpt = citedExcerpt(check, evidence)
			return `Requirement ${requirement} is not met; continue work and verify it.${excerpt ? ` Failing check: ${excerpt}.` : ""}`
		}
		if (check.kind === "final_answer") {
			if (
				proposedAnswer === undefined ||
				check.candidateRef !== "last_assistant" ||
				check.observedAnswer !== proposedAnswer
			) {
				return `Requirement ${requirement} has not been checked against the exact proposed answer; return only the required answer with no extra text.`
			}
			if (typeof check.expectedAnswer === "string" && proposedAnswer !== check.expectedAnswer) {
				return `Requirement ${requirement} requires exactly ${JSON.stringify(check.expectedAnswer)}; return that answer with no extra text.`
			}
			continue
		}
		if (check.status === "pass" && !check.failureMode) {
			return `Requirement ${requirement} does not name the plausible failure mode ruled out by its evidence; inspect the risk and verify it.`
		}
		if (check.evidence.length === 0) {
			return `Requirement ${requirement} has no cited evidence; run a relevant check and cite its [eN] result.`
		}
	}
	return undefined
}

/** Source and test file names inside a shell command (`test/grid-probe.tsx`, `probe_case.py`, …). */
const SOURCE_PATH_TOKEN = /[\w@.+/-]*[\w-]\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|swift|scala|exs?)\b/g

/** What the verifier created during this run: write-tool files, and anything absent from the before-run snapshot. */
export interface VerifierCreatedFiles {
	/** The verifier's cwd (relative tokens resolve against it). */
	cwd: string
	/** Absolute paths created with the write tool. */
	written: ReadonlySet<string>
	/** The before-run snapshot's files; absent outside git or when listing failed. */
	beforeRun?: SnapshotPaths
}

function realCwd(cwd: string): string {
	try {
		return realpathSync(cwd)
	} catch {
		return cwd
	}
}

/**
 * Whether a command runs a file the verifier created in this run: one written
 * with the write tool, or — for probes created with shell commands — a
 * repository file that did not exist before the run. The before-run snapshot
 * already carries the implementer's new tests, so they never qualify.
 */
function runsVerifierCreatedFile(command: string, created: VerifierCreatedFiles): boolean {
	const bases = [created.cwd, realCwd(created.cwd)]
	for (const token of command.match(SOURCE_PATH_TOKEN) ?? []) {
		for (const base of bases) {
			const absolute = resolve(base, token)
			if (created.written.has(absolute)) return true
			const before = created.beforeRun
			if (!before) continue
			const rel = relative(before.root, absolute)
			if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !before.paths.has(rel)) return true
		}
	}
	return false
}

/** Shell commands the check cites (bash evidence only). */
function citedCommands(check: FermentV2VerifierCheck, evidence: ReadonlyMap<string, VerifierEvidence>): string[] {
	const commands: string[] = []
	for (const id of check.evidence) {
		const item = evidence.get(id)
		if (item?.toolName === "bash" && typeof item.input.command === "string") commands.push(item.input.command)
	}
	return commands
}

/**
 * Host reason when a `met` verdict's verification procedure is incomplete —
 * routed to the verifier as a correction, never to the implementer:
 *
 * - every modified, deleted, or renamed pre-existing test file (flag) must be
 *   covered by a `baseline_test` check that ran something: the baseline version
 *   of the file against the current code;
 * - every passing behaviour check must rest on independent evidence — the
 *   verifier's own probe, a pre-existing test, a baseline test, or a direct
 *   command — with at least one executed shell command cited; the
 *   implementer's own tests alone never suffice. A `probe` must cite a run
 *   that references a file the verifier created in this run.
 */
function incompleteProcedureReason(
	checks: readonly FermentV2VerifierCheck[],
	testInventoryFlags: readonly TestInventoryFlag[],
	evidence: ReadonlyMap<string, VerifierEvidence>,
	created: VerifierCreatedFiles,
): string | undefined {
	// Every gap is reported at once: the verifier gets a single correction round.
	const gaps: string[] = []
	for (const flag of testInventoryFlags) {
		if (!BASELINE_TEST_FLAG_KINDS.has(flag.kind)) continue
		const covered = checks.some(
			(check) =>
				check.method === "baseline_test" && check.flags?.includes(flag.id) && citedCommands(check, evidence).length > 0,
		)
		if (!covered) {
			gaps.push(
				`Flag ${flag.id} (${flag.kind.replaceAll("_", " ")}: ${flag.path}) has no baseline_test check: write the baseline version of that file (git show <baseline>:${flag.path}) as a new test file, run it against the current code, and report it as a check with method "baseline_test" and flags ["${flag.id}"].`,
			)
		}
	}
	for (const check of checks) {
		if (check.kind === "final_answer" || check.status !== "pass") continue
		if ((check.category ?? "behavior") !== "behavior") continue
		const requirement = JSON.stringify(check.requirement.slice(0, 200))
		if (!check.method || !INDEPENDENT_METHODS.has(check.method)) {
			gaps.push(
				`Behaviour check ${requirement} passes on ${check.method ?? "unlabelled"} evidence; the implementer's own tests are context, not proof. Verify it independently — write and run your own probe for it and each edge the objective names (method "probe"), or run a pre-existing test that asserts it ("existing_test") — and label the check's category and method.`,
			)
			continue
		}
		const commands = citedCommands(check, evidence)
		if (commands.length === 0) {
			gaps.push(
				`Behaviour check ${requirement} cites no executed command; run the ${check.method} and cite its [eN] result.`,
			)
			continue
		}
		if (check.method === "probe" && !commands.some((command) => runsVerifierCreatedFile(command, created))) {
			gaps.push(
				`Behaviour check ${requirement} is labelled "probe" but cites no run of a probe file you created in this run; write the probe with the write tool and run it.`,
			)
		}
	}
	if (gaps.length === 0) return undefined
	const shown = gaps.slice(0, MAX_PROCEDURE_GAPS)
	const more = gaps.length > shown.length ? ` (+${gaps.length - shown.length} more of the same kind)` : ""
	return `${gaps.length} gap${gaps.length === 1 ? "" : "s"}: ${shown.join(" ")}${more}`
}

/** A `continue` verdict needs at least one `fail` check citing evidence the guard stamped. */
function hasCitedFail(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): boolean {
	return checks?.some((check) => check.status === "fail" && check.evidence.some((id) => evidence.has(id))) ?? false
}

/** An `impossible` verdict blocks the ferment only with a check citing stamped evidence (design: ≥ 1 cited check). */
function hasCitedCheck(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): boolean {
	return checks?.some((check) => check.evidence.some((id) => evidence.has(id))) ?? false
}

/** A check's first stamped evidence excerpt, whitespace-flattened and clipped for a task-facing reason. */
function citedExcerpt(
	check: FermentV2VerifierCheck,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): string | undefined {
	for (const id of check.evidence) {
		const excerpt = evidence.get(id)?.excerpt
		if (!excerpt) continue
		const flattened = excerpt.replace(/\s+/g, " ").trim()
		if (flattened) {
			return flattened.length > FAILING_CHECK_EXCERPT_CHARS
				? `${flattened.slice(0, FAILING_CHECK_EXCERPT_CHARS)}…`
				: flattened
		}
	}
	return undefined
}

/**
 * The task-facing reason for a verdict that keeps a failing check (plan
 * Chunk 8): the requirement plus the observed error from the check's cited
 * evidence. Returned results carry neither the checks nor their evidence, so
 * without this the implementer would never see what the verifier observed —
 * the excerpt is the diagnosis and the repair anchor. Falls back to the
 * verifier's own summary when no failing check cites a stamped, non-empty
 * excerpt.
 */
function failingCheckReason(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): string | undefined {
	for (const check of checks ?? []) {
		if (check.status !== "fail") continue
		const excerpt = citedExcerpt(check, evidence)
		if (excerpt === undefined) continue
		const requirement = check.requirement.replace(/[.\s]+$/, "")
		return `Remaining requirement: ${requirement}. Failing check: ${excerpt}`
	}
	return undefined
}

type ValidatedVerdict =
	| { kind: "ok"; verdict: FermentV2EvaluatorVerdict; reason: string; acceptedFinalAnswer?: string }
	| { kind: "correct"; reason: string; failureType: FermentV2EvaluatorFailureType; procedure?: true }

/** The first test-inventory flag no check addresses (in its flags array) — a `met` verdict must cover every flag. */
function unaddressedTestInventoryFlag(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	testInventoryFlags: readonly TestInventoryFlag[],
): TestInventoryFlag | undefined {
	return testInventoryFlags.find((flag) => !checks?.some((check) => check.flags?.includes(flag.id)))
}

function validateParsedVerdict(
	parsed: ParsedFermentV2EvaluatorOutput,
	evidence: ReadonlyMap<string, VerifierEvidence>,
	proposedAnswer: string | undefined,
	testInventoryFlags: readonly TestInventoryFlag[],
	created: VerifierCreatedFiles,
): ValidatedVerdict {
	// Every cited ID must match a stamped tool result before any verdict is
	// accepted — a hallucinated [eN] citation rejects the verdict.
	const unknown = unknownEvidenceIds(parsed.checks, evidence)
	if (unknown.length > 0) {
		if (parsed.verdict === "met") {
			// Mirrors an uncited `met`: downgraded to a host-authored `continue`.
			return {
				kind: "ok",
				verdict: "continue",
				reason: `The verdict cites evidence ID${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} that match no executed tool result; run the supporting check and cite its [eN] result.`,
			}
		}
		return {
			kind: "correct",
			reason: `the verdict cited unknown evidence ID${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`,
			failureType: "uncited_verdict",
		}
	}
	if (parsed.verdict === "met") {
		// An incomplete or missing inventory does not block `met`: the prompt
		// tells the verifier to inspect changed test files itself, so a
		// persistent git failure never makes completion impossible.
		// A met verdict must address every host-detected test-inventory flag:
		// deleted, renamed, or modified pre-existing tests, added skip/only
		// markers, and kept-probe changes are the classic ways an implementer
		// makes a suite green without making it pass.
		const unaddressed = unaddressedTestInventoryFlag(parsed.checks, testInventoryFlags)
		if (unaddressed) {
			const described = `${unaddressed.kind.replaceAll("_", " ")}: ${unaddressed.path}${
				unaddressed.detail ? ` (${unaddressed.detail})` : ""
			}`
			return {
				kind: "ok",
				verdict: "continue",
				reason: `Flag ${unaddressed.id} (${described}) is not addressed by any check; address every test-inventory flag in a check's flags array before claiming completion.`,
			}
		}
		const unsupported = unsupportedMetReason(parsed.checks, evidence, proposedAnswer)
		if (unsupported) {
			// An uncited `met` is downgraded to a host-authored `continue`.
			return { kind: "ok", verdict: "continue", reason: unsupported }
		}
		// A `met` whose procedure skipped independent verification goes back to
		// the verifier — the gap is in the verification, not the implementation.
		const incomplete = incompleteProcedureReason(parsed.checks ?? [], testInventoryFlags, evidence, created)
		if (incomplete) {
			return { kind: "correct", reason: incomplete, failureType: "procedure_incomplete", procedure: true }
		}
		return {
			kind: "ok",
			verdict: "met",
			reason: parsed.reason,
			...(parsed.checks?.some((check) => check.kind === "final_answer") && proposedAnswer !== undefined
				? { acceptedFinalAnswer: proposedAnswer }
				: {}),
		}
	}
	if (parsed.verdict === "continue" && !hasCitedFail(parsed.checks, evidence)) {
		return {
			kind: "correct",
			reason: "the verdict had no cited failing check.",
			failureType: "uncited_verdict",
		}
	}
	// Design (Chunk 8): "impossible: ≥ 1 cited check → blocked." An unsupported
	// impossible never blocks the ferment on its own say-so.
	if (parsed.verdict === "impossible" && !hasCitedCheck(parsed.checks, evidence)) {
		return {
			kind: "correct",
			reason: "the verdict had no cited check.",
			failureType: "uncited_verdict",
		}
	}
	// A verdict with a failing check keeps the composed task-facing gap
	// (requirement + observed error); without one the verifier's own
	// summary stands.
	return { kind: "ok", verdict: parsed.verdict, reason: failingCheckReason(parsed.checks, evidence) ?? parsed.reason }
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
	keptProbes: readonly { path: string; requirementId: string }[]
	signal?: AbortSignal
}): Promise<FermentV2VerifierFacts> {
	if (request.gitProbe === "outside_git") return { basis: "outside_git" }
	const against = request.baseline ?? (request.beforeHead?.kind === "commit" ? request.beforeHead.sha : undefined)
	if (!request.before || !against) return { basis: "unavailable" }
	const workspace = await gatherWorkspaceFacts(request.cwd, against, request.before, request.keptProbes, request.signal)
	if (!workspace) return { basis: "unavailable" }
	return { basis: request.baseline ? "baseline" : "head", workspace }
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
		return {
			verdict: "unavailable",
			reason,
			...(modelRef ? { model: modelRef } : {}),
			...(usage.totalTokens > 0 || usage.costUsd > 0 ? { usage } : {}),
			diagnostics: diagnostics(failureType, httpStatusCode),
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
		guard = (deps?.createGuard ?? createVerifierGuard)({
			cwd: input.cwd,
			...(reserved ? { baselineWorktree: { path: reserved.path, ensure: () => reserved.ensure(input.signal) } } : {}),
		})
		// New probe files in the repository and anything inside the disposable
		// worktree are pre-approved, so they never wait on the classifier; every
		// other call follows the session's permission mode.
		const writableRoots = { cwd: input.cwd, ...(reserved ? { worktree: reserved.path } : {}) }
		const permissions = createPermissionsExtension({
			preApproved: (toolName, toolInput) =>
				toolName === "write" && isVerifierWritablePath(toolInput.path, writableRoots),
		})
		const facts = await gatherVerifierFacts({
			cwd: input.cwd,
			gitProbe,
			...(before ? { before } : {}),
			...(beforeHead ? { beforeHead } : {}),
			...(input.baseline ? { baseline: input.baseline.commit } : {}),
			keptProbes: input.keptProbes ?? [],
			signal: input.signal,
		})
		gatheredFacts = facts

		const proposedAnswer = latestFinalAnswerDraft(input.messages)
		let prompt = buildVerifierTaskPrompt({
			objective: objectiveText(input.objective, ctx.cwd),
			cwd: input.cwd,
			facts,
			...(reserved ? { baselineWorktree: reserved.path } : {}),
			...(integrityUnenforced ? { integrityUnenforced } : {}),
			todos: input.todos,
			...(input.completionConfidence ? { completionConfidence: input.completionConfidence } : {}),
			...(proposedAnswer !== undefined ? { proposedAnswer } : {}),
			...(input.previousGap ? { previousGap: input.previousGap } : {}),
		})
		if (getRedactionConfig().enabled) {
			try {
				prompt = await (deps?.redact ?? redactTextOrThrow)(prompt)
			} catch {
				return unavailable("Verifier input redaction failed.", "redaction_failed")
			}
		}

		const timeoutSignal = evaluationTimeoutMs ? AbortSignal.timeout(evaluationTimeoutMs) : undefined
		const runSignal = timeoutSignal
			? input.signal
				? AbortSignal.any([timeoutSignal, input.signal])
				: timeoutSignal
			: (input.signal ?? new AbortController().signal)
		// The spawn's wall-clock cap mirrors the optional timeout (0 = unlimited).
		const maxDuration = evaluationTimeoutMs ? Math.ceil(evaluationTimeoutMs / 1000) : 0

		input.onVerifierStart?.({ model: modelRef })
		const spawn = deps?.spawn ?? defaultSpawn
		let run: FermentV2VerifierAgentRun | undefined
		for (let attempt = 0; ; attempt++) {
			// The combined signal is checked before every attempt — including the
			// first and each retry after backoff — so a timeout that already fired
			// is never retried and cancellation proceeds to integrity cleanup.
			if (input.signal?.aborted) return unavailable(`Verifier ${modelRef} was cancelled.`, "cancelled")
			if (timeoutSignal?.aborted) {
				timeoutCount++
				return unavailable(
					`Verifier ${modelRef} timed out after ${(evaluationTimeoutMs ?? 0) / 1_000} seconds.`,
					"timeout",
				)
			}
			providerRequestCount++
			// The Verifier persona disables extensions, so PII redaction and the
			// permission system ride along as inline factories. Redaction (a no-op
			// when disabled) runs before the guard so the guard stamps — and
			// records as evidence excerpts for verdict reasons — already-redacted
			// content; permissions gate verifier bash by the session's mode (the
			// child cannot prompt, so non-read-only commands go to the classifier).
			run = await spawn({
				model,
				prompt,
				cwd: input.cwd,
				extensionFactories: [piiRedactionExtension, permissions, guard.extension],
				signal: runSignal,
				maxDuration,
				thinkingLevel: settings.verifierThinking,
			})
			if (!run) return unavailable("The verifier subagent system is not available.", "agent_unavailable")
			toolCalls += run.toolCalls
			turns += run.turns
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
				return unavailable(
					`Verifier ${modelRef} run failed: ${run.error ?? "unknown error"}`,
					classified?.reason ?? "call_failed",
					classified?.httpStatusCode,
				)
			}
			if (input.signal?.aborted) return unavailable(`Verifier ${modelRef} was cancelled.`, "cancelled")
			if (timeoutSignal?.aborted) {
				timeoutCount++
				return unavailable(
					`Verifier ${modelRef} timed out after ${(evaluationTimeoutMs ?? 0) / 1_000} seconds.`,
					"timeout",
				)
			}
			if (run.status === "aborted" || run.status === "stopped") {
				return unavailable(`Verifier ${modelRef} was aborted (${run.abortReason ?? run.status}).`, "call_failed")
			}
			break
		}
		const verifierRun = run

		// Collected flags must be addressed; missing or incomplete inventories
		// are reported in the prompt and do not block `met`.
		const testInventoryFlags = "workspace" in facts ? facts.workspace.testInventoryFlags : []

		// Which files the verifier itself created — probes must run one of them.
		// The write set is live (a correction may add probes); the before-run
		// listing is taken once.
		const beforeRun = before ? await listSnapshotPaths(input.cwd, before, input.signal) : undefined
		const created: VerifierCreatedFiles = {
			cwd: input.cwd,
			written: guard.createdFiles,
			...(beforeRun ? { beforeRun } : {}),
		}

		const parsed = parseFermentV2EvaluatorOutput(verifierRun.text)
		let checks = parsed?.checks
		let validated: ValidatedVerdict = parsed
			? validateParsedVerdict(parsed, guard.evidence, proposedAnswer, testInventoryFlags, created)
			: { kind: "correct", reason: "no valid JSON verdict was returned.", failureType: "invalid_output" }
		if (validated.kind === "correct") {
			correctionCount++
			const corrected = await resumeWithRetries(
				verifierRun.id,
				(validated.procedure ? INCOMPLETE_PROCEDURE_CORRECTION_PROMPT : INVALID_OUTPUT_CORRECTION_PROMPT).replace(
					"{reason}",
					validated.reason,
				),
				runSignal,
				verifierRun.toolCalls,
			)
			// A timeout is never retried and reported as such; the same cap covered the whole run.
			if (timeoutSignal?.aborted) {
				timeoutCount++
				return unavailable(
					`Verifier ${modelRef} timed out after ${(evaluationTimeoutMs ?? 0) / 1_000} seconds.`,
					"timeout",
				)
			}
			if (input.signal?.aborted) return unavailable(`Verifier ${modelRef} was cancelled.`, "cancelled")
			if (corrected === undefined) return unavailable(`Verifier ${modelRef} correction failed.`, "call_failed")
			if (corrected.status === "error") {
				const classified = classifyLLMGatewayError(corrected.error ?? "")
				return unavailable(
					`Verifier ${modelRef} correction failed: ${corrected.error ?? "unknown error"}`,
					classified?.reason ?? "call_failed",
					classified?.httpStatusCode,
				)
			}
			const reparsed = parseFermentV2EvaluatorOutput(corrected.text)
			checks = reparsed?.checks
			validated = reparsed
				? validateParsedVerdict(reparsed, guard.evidence, proposedAnswer, testInventoryFlags, created)
				: {
						kind: "correct",
						reason: "no valid JSON verdict was returned after the correction.",
						failureType: "invalid_output",
					}
			if (validated.kind === "correct") {
				return unavailable(`Verifier ${modelRef} ${validated.reason}`, validated.failureType)
			}
		}

		return {
			verdict: validated.verdict,
			reason: validated.reason,
			model: modelRef,
			usage: verifierUsage(),
			diagnostics: diagnostics(),
			...(validated.acceptedFinalAnswer ? { acceptedFinalAnswer: validated.acceptedFinalAnswer } : {}),
			...(checks ? { checks } : {}),
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
		})
	}

	/**
	 * Resume the verifier session with the transient retry policy: transient
	 * provider errors are retried with backoff like the spawn, while timeouts
	 * and cancellations never retry. Returns the final run (an error run when
	 * the failure is not transient) or undefined when the run cannot continue.
	 *
	 * `baselineToolCalls` is the child record's cumulative tool-call count when
	 * the initial run ended; a resume returns that same record's cumulative
	 * count (the manager never resets it), so only the delta is counted.
	 */
	async function resumeWithRetries(
		id: string,
		prompt: string,
		signal: AbortSignal,
		baselineToolCalls: number,
	): Promise<FermentV2VerifierAgentRun | undefined> {
		const resume = deps?.resume ?? defaultResume
		let cumulativeToolCalls = baselineToolCalls
		for (let attempt = 0; ; attempt++) {
			// Never resume again once the run was cancelled or timed out —
			// including after a backoff whose signal aborted mid-wait.
			if (input.signal?.aborted || signal.aborted) return undefined
			providerRequestCount++
			const run = await resume(id, prompt, signal)
			if (!run) return undefined
			if (run.toolCalls > cumulativeToolCalls) {
				toolCalls += run.toolCalls - cumulativeToolCalls
				cumulativeToolCalls = run.toolCalls
			}
			turns += run.turns
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
	): Promise<FermentV2VerifierAgentRun | undefined> {
		return resumeFermentV2VerifierAgent(id, prompt, { signal })
	}
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

/** Discard a `met` verdict on guard violation; keep every other verdict and attach the integrity outcome. */
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
