/**
 * requirements-agent.ts — Ferment V2 source-only requirements drafting.
 *
 * The drafter is one bounded, read-only subagent invocation that turns the
 * resolved objective (plus the already-authorized plan text) and a
 * source-only view of the goal's baseline into a complete initial
 * requirements list, recorded through the shared `record_requirements`
 * schema. It runs before the implementer's first turn on a new goal, so the
 * contract is established independently of any candidate code:
 *
 * - the source view is the reserved baseline worktree when the goal has a
 *   fixed baseline (a frozen historical checkout), otherwise — for a new
 *   non-Git goal only — the live workspace before implementation begins;
 * - the host enforces the read boundary (read/grep/find/ls confined to the
 *   view root, no shell, write, edit, or subagent tools), not just the prompt;
 * - one bounded attempt per draft: the existing evaluation timeout when set,
 *   an internal 120-second bound otherwise, with no new configuration;
 * - a failure leaves the goal's requirements record `unavailable` with an
 *   explicit reason — work proceeds, and one retry happens at the next
 *   completion claim (see index.ts), never a startup pause.
 *
 * Pure state transitions live in reducer.ts/requirements.ts; this module owns
 * only the model orchestration for drafting.
 */

import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent"
import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { findExistingFile, resolveUserPath } from "../../fs-paths.js"
import { classifyLLMGatewayError } from "../../llm-gateway-error.js"
import {
	type FermentV2VerifierAgentRun,
	spawnFermentV2RequirementsAmendmentAgent,
	spawnFermentV2RequirementsDraftAgent,
} from "../agents/index.js"
import type { ThinkingLevel } from "../agents/personas/types.js"
import { textResult } from "../agents/tool-result.js"
import { createPermissionsExtension } from "../permissions/index.js"
import { getRedactionConfig } from "../pii-redaction/config.js"
import piiRedactionExtension from "../pii-redaction/index.js"
import { redactTextOrThrow } from "../pii-redaction/redactor.js"
import type { FermentV2EvaluatorFailureType } from "./domain-events.js"
import { isRecord } from "./reducer.js"
import {
	nextRequirementIdWatermark,
	parseVerifierRequirements,
	RECORD_REQUIREMENTS_TOOL,
	REQUIREMENT_PARAMETERS,
	type RequirementsAmendmentDiff,
	type VerifierRequirement,
} from "./requirements.js"
import { getFermentV2Settings } from "./settings.js"
import type { FermentV2EvaluatorUsage, FermentV2Requirements, FermentV2RequirementsProvenance } from "./types.js"
import { createUsageAccumulator } from "./verifier-guard.js"
import { resolveFermentV2VerifierModel } from "./verifier-model.js"
import { type BaselineWorktree, reserveBaselineWorktree } from "./workspace.js"

/** Marker string in the drafter's task prompt; fake-provider tests match on it. */
export const FERMENT_V2_REQUIREMENTS_DRAFT_MARKER = "<ferment_v2_requirements_draft>"

/** Marker string in the amendment ruler's task prompt; fake-provider tests match on it. */
export const FERMENT_V2_REQUIREMENTS_AMENDMENT_MARKER = "<ferment_v2_requirements_amendment_task>"

/** Name of the ruling tool the requirements ruler submits its decision through. */
export const AMENDMENT_RULING_TOOL_NAME = "submit_amendment_ruling"

/** Tools the drafter may use; everything else is blocked by the host guard. */
export const REQUIREMENTS_DRAFT_READ_TOOLS = ["read", "grep", "find", "ls"] as const

/**
 * Internal deadline for one requirements-stage model invocation (draft or
 * amendment ruling) when no evaluation timeout is configured. Deliberately
 * not configurable in this iteration.
 */
export const REQUIREMENTS_STAGE_TIMEOUT_MS = 120_000

/** A read-only source view the draft may consult. */
export type FermentV2RequirementsDraftSourceView =
	| { kind: "baseline"; root: string }
	| { kind: "workspace"; root: string }
	| { kind: "none" }

export interface FermentV2RequirementsDraftInput {
	fermentV2Id: string
	revision: number
	/** Exact resolved objective text the contract targets. */
	objective: string
	/** Digest of `objective`; binds the result to the record it may settle. */
	objectiveDigest: string
	/** Already-authorized approved-plan text, when the goal started from one. */
	planText?: string
	/** The host working directory; baseline worktrees are reserved against it. */
	cwd: string
	/** The goal's fixed baseline commit, when one exists. */
	baseline?: string
	/** True when the draft runs before any implementation turn (startup). */
	beforeImplementation: boolean
	/** Previous accepted obligations and allocation state; identity context for refreshes. */
	previousContract?: Pick<FermentV2Requirements, "items" | "idWatermark">
	signal?: AbortSignal
}

export interface FermentV2RequirementsDraftDiagnostics {
	durationMs: number
	timeoutMs: number
	providerRequestCount: number
	model?: string
	failureType?: FermentV2EvaluatorFailureType
}

export interface FermentV2RequirementsDraftOutcome {
	status: "ready" | "unavailable"
	provenance: FermentV2RequirementsProvenance
	/** The accepted list when status is `ready`. */
	items?: readonly VerifierRequirement[]
	unavailableReason?: string
	usage: FermentV2EvaluatorUsage
	diagnostics: FermentV2RequirementsDraftDiagnostics
	/** The digest the draft ran for; the applier fences on it. */
	objectiveDigest: string
	objectiveRevision: number
}

export interface FermentV2RequirementsSpawnInput {
	model: Model<Api>
	prompt: string
	cwd: string
	extensionFactories: InlineExtension[]
	signal: AbortSignal
	/** Wall-clock cap in seconds. */
	maxDuration: number
	thinkingLevel: ThinkingLevel
}

/** Injection seams so every branch is unit-testable without a real subagent. */
export interface FermentV2RequirementsDeps {
	spawn?: (input: FermentV2RequirementsSpawnInput) => Promise<FermentV2VerifierAgentRun | undefined>
	reserveWorktree?: (cwd: string, baseline: string) => BaselineWorktree | undefined
	resolveModel?: typeof resolveFermentV2VerifierModel
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** A path and its symlink-resolved form (macOS keeps the temp dir under /private). */
function pathForms(path: string): string[] {
	try {
		const resolved = realpathSync(path)
		return resolved === path ? [path] : [path, resolved]
	} catch {
		return [path]
	}
}

function isInsideAny(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const rel = relative(root, path)
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	})
}

/** Whether the path (relative to the view root) reaches `.git` metadata. */
function reachesGitMetadata(target: string, root: string): boolean {
	return pathForms(root).some((form) => {
		const rel = relative(form, target)
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
		return rel.split(sep).includes(".git")
	})
}

/**
 * Whether the drafter may read `rawPath` (the exact tool-input value; a
 * relative path resolves against the view root, which is also the child
 * session's cwd). The host enforces this before the tool runs:
 *
 * - the value must stay inside the view root (parent traversal and absolute
 *   paths outside the view are rejected);
 * - symlinks must not escape the root's real path (on macOS the temp-dir
 *   alias counts as the same root);
 * - `.git` metadata is never readable: in a baseline worktree the `.git`
 *   pointer file exposes the candidate checkout's gitdir.
 *
 * A path that does not exist yet is checked lexically (nothing exists to
 * resolve); reads are read-only and the view is host-provided, so a
 * check-then-read race cannot expose candidate code that was not already
 * reachable.
 */
export function isDraftReadablePath(rawPath: unknown, root: string, toolName = "read"): boolean {
	if (rawPath === undefined) return true
	if (typeof rawPath !== "string") return false
	if (!rawPath) return true
	let target: string
	try {
		// The shared path helpers mirror Pi's aliases and read fallback ladder.
		// Check the path the SDK will execute, not a lexical approximation.
		target =
			toolName === "read"
				? (findExistingFile(rawPath, root, existsSync) ?? resolveUserPath(rawPath, root))
				: resolveUserPath(rawPath, root)
	} catch {
		return false
	}
	if (!isInsideAny(target, pathForms(root))) return false
	if (reachesGitMetadata(target, root)) return false
	try {
		const real = realpathSync(target)
		if (!isInsideAny(real, pathForms(root))) return false
		return !reachesGitMetadata(real, root)
	} catch {
		return true
	}
}

/** Path-bearing tool inputs the guard validates, by tool. */
function draftToolPaths(toolName: string, input: Record<string, unknown>): unknown[] {
	if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
		return [input.path]
	}
	return []
}

/**
 * The host-side read boundary shared by the requirements phases: only the
 * read/list/search tools and one recording tool pass; every other tool
 * (shell, write, edit, subagents, extension tools) is blocked before it runs,
 * and every read path is confined to the source view root. A view of `none`
 * blocks all reads.
 */
function createSourceViewGuard(root: string | undefined, recordingTool: string, phaseLabel: string): InlineExtension {
	const readTools: ReadonlySet<string> = new Set(REQUIREMENTS_DRAFT_READ_TOOLS)
	return (pi) => {
		pi.on("tool_call", (event) => {
			if (event.toolName === recordingTool) return undefined
			if (!readTools.has(event.toolName)) {
				return {
					block: true,
					reason: `${phaseLabel} is read-only: only read, grep, find, ls, and ${recordingTool} are available in this phase.`,
				}
			}
			if (!root) {
				return {
					block: true,
					reason: `No source view is available for this phase; work from the supplied objective and contract text only.`,
				}
			}
			const input = isRecord(event.input) ? event.input : {}
			for (const raw of draftToolPaths(event.toolName, input)) {
				if (isDraftReadablePath(raw, root, event.toolName)) continue
				return {
					block: true,
					reason: `Read access is confined to the source view ${root}. ${JSON.stringify(
						typeof raw === "string" ? raw : String(raw ?? ""),
					)} resolves outside it, escapes it through a symlink, or reaches .git metadata; use paths inside the view.`,
				}
			}
			return undefined
		})
	}
}

/**
 * The drafter's host-side boundary: only the read/list/search tools and
 * `record_requirements` pass; every other tool (shell, write, edit, subagents,
 * extension tools) is blocked before it runs, and every read path is confined
 * to the source view root. A view of `none` (objective-only recovery) blocks
 * all reads.
 */
export function createRequirementsDraftGuard(root: string | undefined): InlineExtension {
	return createSourceViewGuard(root, RECORD_REQUIREMENTS_TOOL, "Requirements drafting")
}

/**
 * The amendment ruler's host-side boundary: only the read/list/search tools
 * and the ruling submission tool pass, with read paths confined to the
 * workspace the ruling runs in.
 */
export function createRequirementsAmendmentRulingGuard(root: string): InlineExtension {
	return createSourceViewGuard(root, AMENDMENT_RULING_TOOL_NAME, "Requirements amendment ruling")
}

export interface FermentV2RequirementsDraftLedger {
	extension: InlineExtension
	/** The last accepted list, or undefined when the run never recorded one. */
	readonly items: readonly VerifierRequirement[] | undefined
}

/**
 * The drafter's `record_requirements` tool: the same schema as the verifier's
 * ledger, but a draft records exactly one complete list (the last accepted
 * call wins) and does not release implementation context — there is none
 * before the first implementer turn. Validation failures return errors so the
 * model can retry within the same bounded session.
 */
export function createRequirementsDraftLedger(
	previousContract?: FermentV2RequirementsDraftInput["previousContract"],
): FermentV2RequirementsDraftLedger {
	let items: VerifierRequirement[] | undefined
	const extension: InlineExtension = (pi) => {
		pi.registerTool(
			defineTool({
				name: RECORD_REQUIREMENTS_TOOL,
				label: "Record Draft Requirements",
				description:
					"Record the complete drafted requirements list for this objective. One call with the whole list; use stable r1, r2, … IDs, a category, an objective or repository source, and an observable acceptance condition per item.",
				parameters: REQUIREMENT_PARAMETERS,
				execute: async (_id, params) => {
					const parsed = parseVerifierRequirements(params.requirements)
					if (!parsed) {
						return {
							...textResult(
								"Requirements rejected: provide 1–64 items with distinct r1, r2, … IDs and nonempty requirement, source, and acceptance fields, each category one of behavior, constraint, delivery.",
							),
							isError: true,
						}
					}
					if (previousContract) {
						try {
							nextRequirementIdWatermark(previousContract.idWatermark, parsed, previousContract.items)
						} catch (error) {
							return { ...textResult(errorMessage(error)), isError: true }
						}
					}
					items = parsed
					return textResult("Draft requirements recorded. End your turn now; the host takes over from here.")
				},
			}),
		)
	}
	return {
		extension,
		get items() {
			return items
		},
	}
}

export function buildFermentV2RequirementsDraftPrompt(input: {
	objective: string
	planText?: string
	view: FermentV2RequirementsDraftSourceView
	previousContract?: FermentV2RequirementsDraftInput["previousContract"]
}): string {
	const sections: string[] = []
	sections.push(FERMENT_V2_REQUIREMENTS_DRAFT_MARKER)
	sections.push(
		`Objective (the authoritative task; derive every requirement from it and the source view below):\n${input.objective}`,
	)
	if (input.planText?.trim()) {
		sections.push(`Approved plan (already-authorized task context; obligations may come from it):\n${input.planText}`)
	}
	if (input.view.kind === "baseline") {
		sections.push(
			`Source view (host-provided, read-only): ${input.view.root}\nA frozen checkout of the repository as it was when the objective started (the goal's fixed baseline). Read source and repository contracts here to identify the relevant public interfaces and existing obligations. This view has no runtime environment: nothing can be built, run, or installed, and nothing here is candidate implementation.`,
		)
	} else if (input.view.kind === "workspace") {
		sections.push(
			`Source view (host-provided, read-only): ${input.view.root}\nThe working workspace before implementation begins. It is live, not a frozen historical checkout: external processes may change files while you read; report only what you can actually read. Nothing here is candidate implementation.`,
		)
	} else {
		sections.push(
			"Source view: none. Implementation has already begun and no historical source is available, so this draft must derive requirements from the objective and plan text alone. Do not inspect candidate code.",
		)
	}
	if (input.previousContract) {
		sections.push(
			[
				"Previous accepted obligations (identity context, not authority over the revised objective):",
				JSON.stringify(input.previousContract.items),
				`Preserve IDs for obligations retained by the current objective. Allocate new obligations starting at r${input.previousContract.idWatermark + 1}; IDs at or below r${input.previousContract.idWatermark} absent from this previous list are retired and cannot be reused. Derive the criteria from the current objective, retaining only obligations it still requires.`,
			].join("\n"),
		)
	}
	sections.push(
		[
			"Draft the complete initial list of observable requirements for this objective, call record_requirements once with the complete list, and end your turn.",
			"- Each requirement: a stable r1, r2, … ID; a category (behavior, constraint, or delivery); a source quoting the objective clause or naming the repository contract that establishes it; and an acceptance condition describing the observable result that would establish satisfaction.",
			"- Cover requested behavior, public entry points, named modes/input forms, placement or API constraints, and delivery conditions. Identify combinations the task implies across code paths; evidence for one combination does not establish another.",
			"- Preserve every explicit objective clause: consolidate related cases into one observable criterion rather than dropping or truncating them; at most 64 items.",
			"- Criteria describe observable obligations, not a design. Existing code may establish compatibility expectations where the objective does not supersede them; say precisely which source each criterion rests on.",
			"- Read source only as needed to identify the relevant public interface and existing obligations. Do not run tests or builds; this phase has no execution tools and must not need any.",
		].join("\n"),
	)
	return sections.join("\n\n")
}

function deriveProvenance(
	beforeImplementation: boolean,
	view: FermentV2RequirementsDraftSourceView,
): FermentV2RequirementsProvenance {
	if (beforeImplementation) return "pre_implementation"
	return view.kind === "baseline" ? "baseline_recovery" : "objective_only"
}

/**
 * Run one bounded draft attempt. Never throws: every failure maps to an
 * `unavailable` outcome with a concise reason, so the lifecycle can degrade
 * explicitly instead of pausing the goal. Usage is returned even for
 * cancelled or failed runs so accounting settles exactly once.
 */
export async function runFermentV2RequirementsDraft(
	input: FermentV2RequirementsDraftInput,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	deps?: FermentV2RequirementsDeps,
): Promise<FermentV2RequirementsDraftOutcome> {
	const startedAt = Date.now()
	const settings = getFermentV2Settings()
	const timeoutMs = settings.evaluationTimeoutMs ?? REQUIREMENTS_STAGE_TIMEOUT_MS
	const usageTracker = createUsageAccumulator()
	const timeoutSignal = AbortSignal.timeout(timeoutMs)
	const runSignal = input.signal ? AbortSignal.any([timeoutSignal, input.signal]) : timeoutSignal
	let worktree: BaselineWorktree | undefined
	let view: FermentV2RequirementsDraftSourceView = { kind: "none" }
	let provenance = deriveProvenance(input.beforeImplementation, view)
	let providerRequestCount = 0

	const unavailable = (
		reason: string,
		failureType: FermentV2EvaluatorFailureType,
		model?: string,
	): FermentV2RequirementsDraftOutcome => ({
		status: "unavailable",
		provenance,
		unavailableReason: reason,
		usage: usageTracker.usage,
		diagnostics: {
			durationMs: Math.max(0, Date.now() - startedAt),
			timeoutMs,
			providerRequestCount,
			...(model ? { model } : {}),
			failureType,
		},
		objectiveDigest: input.objectiveDigest,
		objectiveRevision: input.revision,
	})

	try {
		runSignal.throwIfAborted()
		if (input.baseline) worktree = (deps?.reserveWorktree ?? reserveBaselineWorktree)(input.cwd, input.baseline)
		if (worktree && (await worktree.ensure(runSignal))) view = { kind: "baseline", root: worktree.path }
		else if (input.beforeImplementation) view = { kind: "workspace", root: input.cwd }
		provenance = deriveProvenance(input.beforeImplementation, view)
		runSignal.throwIfAborted()
		const modelChoice = await (deps?.resolveModel ?? resolveFermentV2VerifierModel)(ctx, settings.evaluatorModels)
		if (!modelChoice) return unavailable("No model is available for requirements drafting.", "no_model")
		let prompt = buildFermentV2RequirementsDraftPrompt({
			objective: input.objective,
			...(input.planText ? { planText: input.planText } : {}),
			view,
			previousContract: input.previousContract,
		})
		if (getRedactionConfig().enabled) {
			try {
				prompt = await redactTextOrThrow(prompt)
			} catch {
				return unavailable("Requirements draft input redaction failed.", "redaction_failed", modelChoice.ref)
			}
		}
		runSignal.throwIfAborted()
		const ledger = createRequirementsDraftLedger(input.previousContract)
		const guard = createRequirementsDraftGuard(view.kind === "none" ? undefined : view.root)
		// The permissions extension rides along as in the verifier so a call the
		// guard lets through still follows the session's permission mode.
		const readToolNames: readonly string[] = REQUIREMENTS_DRAFT_READ_TOOLS
		const permissions = createPermissionsExtension({
			preApproved: (toolName) => toolName === RECORD_REQUIREMENTS_TOOL || readToolNames.includes(toolName),
		})
		const spawn = deps?.spawn ?? defaultSpawn
		providerRequestCount++
		const run = await spawn({
			model: modelChoice.model,
			prompt,
			cwd: view.kind === "none" ? input.cwd : view.root,
			extensionFactories: [piiRedactionExtension, permissions, guard, usageTracker.register, ledger.extension],
			signal: runSignal,
			maxDuration: Math.max(1, Math.ceil((timeoutMs - (Date.now() - startedAt)) / 1000)),
			thinkingLevel: settings.verifierThinking,
		})
		if (input.signal?.aborted) return unavailable("Requirements drafting was cancelled.", "cancelled", modelChoice.ref)
		if (timeoutSignal.aborted) {
			return unavailable(
				`Requirements drafting timed out after ${timeoutMs / 1_000} seconds.`,
				"timeout",
				modelChoice.ref,
			)
		}
		if (!run) {
			return unavailable(
				"The requirements drafter subagent system is not available.",
				"agent_unavailable",
				modelChoice.ref,
			)
		}
		if (run.status === "error") {
			const classified = classifyLLMGatewayError(run.error ?? "")
			return unavailable(
				`Requirements drafting failed: ${run.error ?? "unknown error"}`,
				classified?.reason ?? "call_failed",
				modelChoice.ref,
			)
		}
		if (run.status === "aborted" || run.status === "stopped") {
			return unavailable(
				`Requirements drafting was aborted (${run.abortReason ?? run.status}).`,
				"call_failed",
				modelChoice.ref,
			)
		}
		const items = ledger.items
		if (!items) {
			return unavailable(
				"The drafter finished without recording a requirements list.",
				"invalid_output",
				modelChoice.ref,
			)
		}
		return {
			status: "ready",
			provenance,
			items,
			usage: usageTracker.usage,
			diagnostics: {
				durationMs: Math.max(0, Date.now() - startedAt),
				timeoutMs,
				providerRequestCount,
				model: modelChoice.ref,
			},
			objectiveDigest: input.objectiveDigest,
			objectiveRevision: input.revision,
		}
	} catch (error) {
		if (input.signal?.aborted) return unavailable("Requirements drafting was cancelled.", "cancelled")
		if (timeoutSignal.aborted)
			return unavailable(`Requirements drafting timed out after ${timeoutMs / 1_000} seconds.`, "timeout")
		const classified = classifyLLMGatewayError(errorMessage(error))
		return unavailable(`Requirements drafting failed: ${errorMessage(error)}`, classified?.reason ?? "call_failed")
	} finally {
		if (worktree) {
			try {
				await worktree.dispose()
			} catch {
				// Best-effort: leftovers are pruned at the next session start.
			}
		}
	}

	async function defaultSpawn(
		spawnInput: FermentV2RequirementsSpawnInput,
	): Promise<FermentV2VerifierAgentRun | undefined> {
		return spawnFermentV2RequirementsDraftAgent(pi, ctx, spawnInput.prompt, {
			model: spawnInput.model,
			cwd: spawnInput.cwd,
			extensionFactories: spawnInput.extensionFactories,
			signal: spawnInput.signal,
			maxDuration: spawnInput.maxDuration,
			thinkingLevel: spawnInput.thinkingLevel,
		})
	}
}

/** Injection seams for the amendment ruling so every branch is unit-testable without a real subagent. */
export interface FermentV2RequirementsAmendmentDeps {
	spawn?: (input: FermentV2RequirementsSpawnInput) => Promise<FermentV2VerifierAgentRun | undefined>
	resolveModel?: typeof resolveFermentV2VerifierModel
}

export interface FermentV2RequirementsAmendmentInput {
	fermentV2Id: string
	revision: number
	/** Exact resolved objective text the contract targets. */
	objective: string
	/** Digest of `objective`; binds the result to the record it may settle. */
	objectiveDigest: string
	/** The contract version the proposal was captured against. */
	contractVersion: number
	currentItems: readonly VerifierRequirement[]
	proposedItems: readonly VerifierRequirement[]
	diff: RequirementsAmendmentDiff
	/** The implementer's nonempty source-grounded evidence for the batch. */
	reason: string
	/** The host working directory; the ruling's read view is rooted here. */
	cwd: string
	signal?: AbortSignal
}

export interface FermentV2RequirementsAmendmentDiagnostics {
	durationMs: number
	timeoutMs: number
	providerRequestCount: number
	model?: string
	failureType?: FermentV2EvaluatorFailureType
}

export interface FermentV2RequirementsAmendmentOutcome {
	status: "accepted" | "rejected" | "unavailable"
	/** The ruling's source-grounded reason, or why no ruling was available. */
	reason: string
	usage: FermentV2EvaluatorUsage
	diagnostics: FermentV2RequirementsAmendmentDiagnostics
	/** The digest the ruling ran for; the applier fences on it. */
	objectiveDigest: string
	objectiveRevision: number
}

/** The ruling tool's single accepted call, recorded by the host-side ledger. */
export interface FermentV2AmendmentRuling {
	decision: "accept" | "reject"
	reason: string
}

/**
 * The ruler's decision tool: exactly one atomic accept/reject call for the
 * whole amendment batch, with a nonempty source-grounded reason. Validation
 * failures return errors so the model can retry within the same bounded
 * session; the last valid call wins.
 */
export function createRequirementsAmendmentRulingLedger(): {
	extension: InlineExtension
	/** The submitted ruling, or undefined when the run never submitted one. */
	readonly ruling: FermentV2AmendmentRuling | undefined
} {
	let ruling: FermentV2AmendmentRuling | undefined
	const extension: InlineExtension = (pi) => {
		pi.registerTool(
			defineTool({
				name: AMENDMENT_RULING_TOOL_NAME,
				label: "Submit Amendment Ruling",
				description:
					'Submit your one atomic decision for the proposed requirements amendment: {"decision": "accept" | "reject", "reason": "…"}. Accept only when the objective or a repository contract establishes that the current criteria misstate the task (corrected interpretation, superseded compatibility expectation, or a newly discovered obligation). Reject scope weakening: implementation difficulty, candidate output, or an unexplained failing assertion never justify a change. The reason must cite the objective clause or repository contract that decides the batch.',
				parameters: Type.Object({
					decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
					reason: Type.String({ minLength: 1, maxLength: 4_000 }),
				}),
				execute: async (_id, params) => {
					const reason = params.reason.trim()
					if (!reason) {
						return {
							...textResult(
								"Ruling rejected: give a nonempty reason citing the deciding objective clause or repository contract.",
							),
							isError: true,
						}
					}
					ruling = { decision: params.decision, reason }
					return textResult(
						"Ruling recorded. End your turn now; the host applies or preserves the amendment from here.",
					)
				},
			}),
		)
	}
	return {
		extension,
		get ruling() {
			return ruling
		},
	}
}

function formatDiffItems(items: readonly VerifierRequirement[]): string {
	return JSON.stringify(items)
}

/** Build the ruler's task prompt: objective, current contract, proposal, diff, evidence, and the decision policy. */
export function buildFermentV2RequirementsAmendmentPrompt(input: FermentV2RequirementsAmendmentInput): string {
	const sections: string[] = []
	sections.push(FERMENT_V2_REQUIREMENTS_AMENDMENT_MARKER)
	sections.push(`Objective (authoritative; your decision interprets it, never rewrites it):\n${input.objective}`)
	sections.push(
		[`Current requirements contract (version ${input.contractVersion}):`, formatDiffItems(input.currentItems)].join(
			"\n",
		),
	)
	sections.push(`Proposed replacement list:\n${formatDiffItems(input.proposedItems)}`)
	const diffLines: string[] = []
	if (input.diff.added.length) diffLines.push(`Additions: ${input.diff.added.map((item) => item.id).join(", ")}`)
	if (input.diff.changed.length)
		diffLines.push(
			`Changes: ${input.diff.changed
				.map(
					({ current, proposed }) =>
						`${current.id} (current: ${JSON.stringify(current)}; proposed: ${JSON.stringify(proposed)})`,
				)
				.join("; ")}`,
		)
	if (input.diff.removed.length)
		diffLines.push(`Removals: ${input.diff.removed.map((item) => `${item.id} (${item.requirement})`).join("; ")}`)
	if (diffLines.length === 0) diffLines.push("(no differences)")
	sections.push(`Computed diff:\n${diffLines.join("\n")}`)
	sections.push(`Implementer's evidence for the batch:\n${input.reason}`)
	sections.push(
		[
			"Decide whether the evidence justifies this amendment against the objective:",
			"- Read the cited objective clauses and repository contracts with the read tools before deciding; verify the evidence's claims against what the sources actually say.",
			"- Accept only a corrected interpretation, a genuinely superseded compatibility expectation, or a newly discovered obligation the objective requires.",
			"- Reject scope weakening: implementation difficulty, the candidate's output or passing behavior, an unexplained failing assertion, preference, or convenience never justify a change or removal.",
			"- The decision is atomic for the whole batch: accept applies the complete proposed list; reject keeps the current contract.",
			`Call ${AMENDMENT_RULING_TOOL_NAME} exactly once with your decision and a source-grounded reason, then end your turn. Do not run tests, builds, or a verification campaign; this phase is read-only.`,
		].join("\n"),
	)
	return sections.join("\n\n")
}

/**
 * Run one bounded amendment ruling. Never throws: every failure maps to an
 * `unavailable` outcome with a concise reason, so a rejected-or-unavailable
 * decision always leaves the current contract intact and the goal active.
 * Usage is returned even for cancelled or failed runs so accounting settles
 * exactly once.
 */
export async function runFermentV2RequirementsAmendmentRuling(
	input: FermentV2RequirementsAmendmentInput,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	deps?: FermentV2RequirementsAmendmentDeps,
): Promise<FermentV2RequirementsAmendmentOutcome> {
	const startedAt = Date.now()
	const settings = getFermentV2Settings()
	const timeoutMs = settings.evaluationTimeoutMs ?? REQUIREMENTS_STAGE_TIMEOUT_MS
	const usageTracker = createUsageAccumulator()
	const timeoutSignal = AbortSignal.timeout(timeoutMs)
	const runSignal = input.signal ? AbortSignal.any([timeoutSignal, input.signal]) : timeoutSignal
	let providerRequestCount = 0

	const unavailable = (
		reason: string,
		failureType: FermentV2EvaluatorFailureType,
		model?: string,
	): FermentV2RequirementsAmendmentOutcome => ({
		status: "unavailable",
		reason,
		usage: usageTracker.usage,
		diagnostics: {
			durationMs: Math.max(0, Date.now() - startedAt),
			timeoutMs,
			providerRequestCount,
			...(model ? { model } : {}),
			failureType,
		},
		objectiveDigest: input.objectiveDigest,
		objectiveRevision: input.revision,
	})

	try {
		runSignal.throwIfAborted()
		const modelChoice = await (deps?.resolveModel ?? resolveFermentV2VerifierModel)(ctx, settings.evaluatorModels)
		if (!modelChoice) return unavailable("No model is available for the requirements amendment ruling.", "no_model")
		let prompt = buildFermentV2RequirementsAmendmentPrompt(input)
		if (getRedactionConfig().enabled) {
			try {
				prompt = await redactTextOrThrow(prompt)
			} catch {
				return unavailable("Requirements amendment ruling input redaction failed.", "redaction_failed", modelChoice.ref)
			}
		}
		runSignal.throwIfAborted()
		const ledger = createRequirementsAmendmentRulingLedger()
		// The ruling inspects the workspace itself (candidate code included —
		// judging evidence against source is the ruling's job), read-only and
		// confined to the workspace root.
		const guard = createSourceViewGuard(input.cwd, AMENDMENT_RULING_TOOL_NAME, "Requirements amendment ruling")
		const readToolNames: readonly string[] = REQUIREMENTS_DRAFT_READ_TOOLS
		const permissions = createPermissionsExtension({
			preApproved: (toolName) => toolName === AMENDMENT_RULING_TOOL_NAME || readToolNames.includes(toolName),
		})
		const spawn = deps?.spawn ?? defaultSpawn
		providerRequestCount++
		const run = await spawn({
			model: modelChoice.model,
			prompt,
			cwd: input.cwd,
			extensionFactories: [piiRedactionExtension, permissions, guard, usageTracker.register, ledger.extension],
			signal: runSignal,
			maxDuration: Math.max(1, Math.ceil((timeoutMs - (Date.now() - startedAt)) / 1000)),
			thinkingLevel: settings.verifierThinking,
		})
		if (input.signal?.aborted)
			return unavailable("The requirements amendment ruling was cancelled.", "cancelled", modelChoice.ref)
		if (timeoutSignal.aborted) {
			return unavailable(
				`The requirements amendment ruling timed out after ${timeoutMs / 1_000} seconds.`,
				"timeout",
				modelChoice.ref,
			)
		}
		if (!run) {
			return unavailable(
				"The requirements amendment ruler subagent system is not available.",
				"agent_unavailable",
				modelChoice.ref,
			)
		}
		if (run.status === "error") {
			const classified = classifyLLMGatewayError(run.error ?? "")
			return unavailable(
				`The requirements amendment ruling failed: ${run.error ?? "unknown error"}`,
				classified?.reason ?? "call_failed",
				modelChoice.ref,
			)
		}
		if (run.status === "aborted" || run.status === "stopped") {
			return unavailable(
				`The requirements amendment ruling was aborted (${run.abortReason ?? run.status}).`,
				"call_failed",
				modelChoice.ref,
			)
		}
		const ruling = ledger.ruling
		if (!ruling) {
			return unavailable(
				"The ruler finished without submitting an amendment decision.",
				"invalid_output",
				modelChoice.ref,
			)
		}
		return {
			status: ruling.decision === "accept" ? "accepted" : "rejected",
			reason: ruling.reason,
			usage: usageTracker.usage,
			diagnostics: {
				durationMs: Math.max(0, Date.now() - startedAt),
				timeoutMs,
				providerRequestCount,
				model: modelChoice.ref,
			},
			objectiveDigest: input.objectiveDigest,
			objectiveRevision: input.revision,
		}
	} catch (error) {
		if (input.signal?.aborted) return unavailable("The requirements amendment ruling was cancelled.", "cancelled")
		if (timeoutSignal.aborted)
			return unavailable(`The requirements amendment ruling timed out after ${timeoutMs / 1_000} seconds.`, "timeout")
		const classified = classifyLLMGatewayError(errorMessage(error))
		return unavailable(
			`The requirements amendment ruling failed: ${errorMessage(error)}`,
			classified?.reason ?? "call_failed",
		)
	}

	async function defaultSpawn(
		spawnInput: FermentV2RequirementsSpawnInput,
	): Promise<FermentV2VerifierAgentRun | undefined> {
		return spawnFermentV2RequirementsAmendmentAgent(pi, ctx, spawnInput.prompt, {
			model: spawnInput.model,
			cwd: spawnInput.cwd,
			extensionFactories: spawnInput.extensionFactories,
			signal: spawnInput.signal,
			maxDuration: spawnInput.maxDuration,
			thinkingLevel: spawnInput.thinkingLevel,
		})
	}
}
