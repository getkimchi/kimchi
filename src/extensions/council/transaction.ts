import type { Api, Model } from "@earendil-works/pi-ai"
import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { type TSchema, Type } from "typebox"
import type { ApplyReceipt, ChangeSet } from "../../agent-patch/index.js"
import { ChangeTransaction } from "../../agent-patch/index.js"
import { isReadOnlyBashCommand, isReadOnlyTool } from "../permissions/taxonomy.js"
import { type CandidateCheckOutcome, runCandidateCheck } from "./patch.js"
import { debugLog, isCouncilVirtualModel } from "./physical-invoker.js"
import { CouncilSessionCache, type RunBudgetLimits, type RunBudgetSnapshot } from "./run-context.js"
import type { CouncilDegradedReason, CouncilStage, CouncilTransactionSnapshot } from "./schemas.js"
import {
	filterExpectedOutputs,
	gitStatusPorcelain,
	hashPatchFiles,
	type PatchFileState,
	patchFilesChanged,
	restorePatchFiles,
	snapshotPatchFiles,
	type ValidationCheck,
	type ValidationCheckKind,
	type ValidationMutationPolicy,
	validationCatalogForPrompt,
	validationCommand,
} from "./validation.js"

interface CouncilTransactionLimits {
	maxFiles: number
	maxChangedLines: number
	maxPatchBytes: number
}

export const DEFAULT_COUNCIL_TRANSACTION_LIMITS: CouncilTransactionLimits = {
	maxFiles: 64,
	maxChangedLines: 12_000,
	maxPatchBytes: 512 * 1024,
}

export interface CouncilPromotionRequest {
	transactionId: string
	patchSha256: string
}

interface CouncilSettlementRequest extends CouncilPromotionRequest {
	action: "finalize" | "rollback"
}

interface CouncilPostApplyCheck {
	id: string
	kind: ValidationCheckKind
	toolName: string
	command: string
	ok: boolean
	exitCode: number | null
	durationMs: number
	beforeSha256: string
	afterSha256?: string
	mutationPolicy: ValidationMutationPolicy
	mutation: "none" | "expected_only" | "unexpected_restored" | "unexpected_restore_failed"
}

interface PendingPostApplyCheck {
	check: ValidationCheck
	command: string
	startedAt: number
	touchedPaths: string[]
	before: PatchFileState[]
	beforeGitStatus: string
}

interface CouncilRunBudgetState {
	limits: RunBudgetLimits
	startedAt: number
	deadlineAt: number
	snapshot: RunBudgetSnapshot
	repairsUsed: number
	repairedStages: CouncilStage[]
}

/**
 * Bound on how many times an already-emitted apply request, or a `finalize` settlement request, may
 * be re-emitted to a host that never executed the corresponding tool call. Both `apply()` and
 * `settle()` independently re-verify the transaction id and patch hash (and, for apply, the base
 * bytes) immediately before acting, so re-emitting an identical request cannot apply or finalize
 * anything that shouldn't be; the bound exists so a host that never executes the tool still
 * terminates instead of looping forever. It does not apply to `rollback` settlement requests — see
 * `settlementRequest()`.
 */
export const MAX_TRANSACTION_REEMISSIONS = 3

/**
 * Bound on how many times the lead may run `checkCandidate` per user turn. Each call materializes the
 * staged candidate into a throwaway workspace and shells out to a catalog check, so this exists purely
 * to stop a model from looping forever, independent of the whole-run deadline and budget it also draws
 * on.
 */
export const MAX_CANDIDATE_CHECKS_PER_TURN = 3

export class CouncilTransactionRuntime {
	readonly cache = new CouncilSessionCache()
	private transaction?: ChangeTransaction
	private applyEmitted = false
	private applyReemissions = 0
	private settlementEmitted = false
	private settlementReemissions = 0
	private postApplyChecks: CouncilPostApplyCheck[] = []
	private selectedValidationCheckIds: string[] = []
	private pendingValidation?: PendingPostApplyCheck
	private candidateCheckInvocations = 0
	private runBudget?: CouncilRunBudgetState
	private acceptedResponseText?: string
	private acceptedResponseDegradedReason?: CouncilDegradedReason
	private lastChangeSet?: ChangeSet
	private baseVerification: CouncilTransactionSnapshot["baseVerification"] = "not_run"

	constructor(
		private readonly cwd: string,
		private readonly limits: CouncilTransactionLimits = DEFAULT_COUNCIL_TRANSACTION_LIMITS,
		private readonly validationChecks: readonly ValidationCheck[] = [],
	) {}

	get current(): ChangeTransaction | undefined {
		return this.transaction
	}

	get hasStagedChanges(): boolean {
		return this.transaction?.hasChanges ?? false
	}

	get state(): ChangeTransaction["state"] | "idle" {
		return this.transaction?.state ?? "idle"
	}

	get checks(): readonly CouncilPostApplyCheck[] {
		return this.postApplyChecks
	}

	get pendingPostApplyCheck(): ValidationCheck | undefined {
		const id = this.selectedValidationCheckIds.find(
			(required) => !this.postApplyChecks.some((check) => check.id === required && check.ok),
		)
		return id ? this.validationChecks.find((check) => check.id === id) : undefined
	}

	get postApplyChecksComplete(): boolean {
		if (this.postApplyChecks.some(({ ok }) => !ok)) return true
		if (this.selectedValidationCheckIds.length === 0) return this.validationChecks.length === 0
		return this.pendingPostApplyCheck === undefined
	}

	get postApplyChecksPassed(): boolean {
		return this.postApplyChecksComplete && this.postApplyChecks.every(({ ok }) => ok)
	}

	get validationCatalog(): readonly ValidationCheck[] {
		return this.validationChecks
	}

	get validationCatalogPrompt(): ReturnType<typeof validationCatalogForPrompt> {
		return validationCatalogForPrompt(this.validationChecks)
	}

	get selectedValidationChecks(): readonly string[] {
		return this.selectedValidationCheckIds
	}

	/** Candidate-verification calls the lead has already spent this turn, against {@link MAX_CANDIDATE_CHECKS_PER_TURN}. */
	get candidateChecksUsed(): number {
		return this.candidateCheckInvocations
	}

	isExpectedPostApplyCheck(checkId: string): boolean {
		return this.state === "post_apply_checks" && this.pendingValidation?.check.id === checkId
	}

	get savedRunBudget(): CouncilRunBudgetState | undefined {
		return this.runBudget ? structuredClone(this.runBudget) : undefined
	}

	get acceptedResponse(): string | undefined {
		return this.acceptedResponseText
	}

	get acceptedDegradedReason(): CouncilDegradedReason | undefined {
		return this.acceptedResponseDegradedReason
	}

	snapshot(): CouncilTransactionSnapshot | undefined {
		const transaction = this.transaction
		if (!transaction) return undefined
		const changeSet = transaction.hasChanges ? transaction.changeSet() : this.lastChangeSet
		const state = transaction.state
		return {
			transactionId: transaction.id,
			state,
			outcome: this.outcome(state),
			patchSha256: changeSet?.patchSha256,
			stats: changeSet ? { ...changeSet.stats } : undefined,
			baseVerification: this.baseVerification,
			selectedValidationCheckIds: [...this.selectedValidationCheckIds],
			postApplyChecks: this.postApplyChecks.map((check) => ({ ...check })),
			rollbackState:
				state === "post_apply_checks"
					? "available"
					: state === "rolled_back"
						? "completed"
						: state === "hard_recovery"
							? "failed"
							: "not_available",
			hardRecoveryRequired: state === "hard_recovery",
		}
	}

	ensure(cwd = this.cwd): ChangeTransaction {
		if (cwd !== this.cwd) throw new Error("Council transaction workspace changed during the session")
		if (!this.transaction || this.isSafeTerminal(this.transaction.state)) {
			this.transaction = new ChangeTransaction(this.cwd)
			this.applyEmitted = false
			this.applyReemissions = 0
			this.settlementEmitted = false
			this.settlementReemissions = 0
			this.postApplyChecks = []
			this.selectedValidationCheckIds = []
			this.pendingValidation = undefined
			this.acceptedResponseText = undefined
			this.acceptedResponseDegradedReason = undefined
			this.lastChangeSet = undefined
			this.baseVerification = "not_run"
		}
		return this.transaction
	}

	async resetForNewTurn(): Promise<void> {
		try {
			await this.abandon()
		} finally {
			this.resetRunBudget()
		}
		this.candidateCheckInvocations = 0
		if (this.transaction && this.isSafeTerminal(this.transaction.state)) {
			this.transaction = undefined
			this.ensure()
		}
	}

	propose(): ChangeSet {
		const changeSet = this.ensure().propose()
		this.assertWithinLimits(changeSet)
		this.lastChangeSet = changeSet
		return changeSet
	}

	setRequiredPostApplyChecks(checkIds: string[]): void {
		if (this.state !== "proposed") {
			throw new Error(`Council cannot set post-apply checks while ${this.state}`)
		}
		const normalized = [...new Set(checkIds.map((id) => id.trim()).filter(Boolean))]
		if (normalized.length > 3) throw new Error("Council permits at most three required post-apply checks")
		const known = new Set(this.validationChecks.map(({ id }) => id))
		const unknown = normalized.find((id) => !known.has(id))
		if (unknown) throw new Error(`Council selected unknown validation check: ${unknown}`)
		this.selectedValidationCheckIds = normalized
	}

	/**
	 * Runs one catalog check against the staged candidate in an isolated temporary workspace, sourced
	 * from the live `ChangeTransaction` overlay rather than any re-derivation of model output. The real
	 * workspace is never opened for writing. Bounded by `MAX_CANDIDATE_CHECKS_PER_TURN` and, once a run
	 * budget has been saved, by whatever remains of the whole-run deadline.
	 */
	async checkCandidate(checkId: string, signal?: AbortSignal): Promise<CandidateCheckOutcome> {
		if (!this.hasStagedChanges) throw new Error("Council candidate verification requires staged changes")
		const check = this.validationChecks.find((entry) => entry.id === checkId)
		if (!check) throw new Error(`Unknown Council validation check: ${checkId}`)
		if (this.candidateCheckInvocations >= MAX_CANDIDATE_CHECKS_PER_TURN) {
			throw new Error(`Council candidate verification limit reached (${MAX_CANDIDATE_CHECKS_PER_TURN} per turn)`)
		}
		const deadlineAt = this.runBudget?.deadlineAt
		const remainingMs = deadlineAt !== undefined ? deadlineAt - Date.now() : undefined
		if (remainingMs !== undefined && remainingMs <= 0) {
			throw new Error("Council run deadline exceeded")
		}
		const timeoutMs =
			remainingMs !== undefined ? Math.max(1_000, Math.min(check.timeoutMs, remainingMs)) : check.timeoutMs
		this.candidateCheckInvocations += 1
		return runCandidateCheck(this.cwd, this.requireCurrent().changeSet(), check, timeoutMs, signal)
	}

	saveRunBudget(state: CouncilRunBudgetState): void {
		this.runBudget = structuredClone(state)
	}

	resetRunBudget(): void {
		this.runBudget = undefined
	}

	accept(
		expectedPatchSha256: string,
		publicResponse?: string,
		degradedReason?: CouncilDegradedReason,
	): CouncilPromotionRequest {
		const transaction = this.requireCurrent()
		transaction.accept(expectedPatchSha256)
		this.applyEmitted = true
		this.applyReemissions = 0
		if (publicResponse !== undefined) {
			if (!publicResponse.trim()) throw new Error("Council public response must not be empty")
			this.acceptedResponseText = publicResponse
			this.acceptedResponseDegradedReason = degradedReason
		}
		return { transactionId: transaction.id, patchSha256: expectedPatchSha256 }
	}

	/**
	 * Re-requests delivery of the already-accepted candidate's apply request. The initial request is
	 * returned by `accept()`; if the host never executes the corresponding apply tool call and the
	 * same accepted transaction is resumed, this re-emits the identical request (same transaction id
	 * and patch hash) up to `MAX_TRANSACTION_REEMISSIONS` times. Re-emitting is safe because `apply()`
	 * independently re-verifies the transaction id, patch hash, and base bytes before applying. Once
	 * the bound is exhausted this returns `undefined` so the caller discards the transaction instead
	 * of retrying forever.
	 */
	applyRequest(): CouncilPromotionRequest | undefined {
		if (this.state !== "accepted") return undefined
		if (this.applyEmitted) {
			if (this.applyReemissions >= MAX_TRANSACTION_REEMISSIONS) return undefined
			this.applyReemissions += 1
		} else {
			this.applyEmitted = true
		}
		const transaction = this.requireCurrent()
		return { transactionId: transaction.id, patchSha256: transaction.changeSet().patchSha256 }
	}

	/** True once an apply request has been emitted and re-emitted up to its bound without being executed. */
	get applyDeliveryExhausted(): boolean {
		return this.applyEmitted && this.applyReemissions >= MAX_TRANSACTION_REEMISSIONS
	}

	async apply(request: CouncilPromotionRequest): Promise<ApplyReceipt> {
		const transaction = this.requireCurrent()
		if (request.transactionId !== transaction.id) {
			throw new Error("Council apply request does not match the active transaction")
		}
		let receipt: ApplyReceipt
		try {
			receipt = await transaction.applyExact(request.patchSha256)
			this.baseVerification = "passed"
		} catch (error) {
			this.baseVerification = this.state === "failed" ? "failed" : "passed"
			throw error
		}
		this.applyEmitted = false
		this.applyReemissions = 0
		this.settlementEmitted = false
		this.settlementReemissions = 0
		this.postApplyChecks = []
		this.pendingValidation = undefined
		return receipt
	}

	private touchedPaths(): string[] {
		const operations = this.lastChangeSet?.operations ?? []
		const paths = new Set<string>()
		for (const operation of operations) {
			paths.add(operation.path)
			if (operation.kind === "rename") paths.add(operation.fromPath)
		}
		return [...paths]
	}

	async preparePostApplyCheck(): Promise<{ id: string; command: string; timeoutSeconds: number } | undefined> {
		if (this.state !== "post_apply_checks") return undefined
		if (this.pendingValidation) {
			return {
				id: this.pendingValidation.check.id,
				command: this.pendingValidation.command,
				timeoutSeconds: Math.max(1, Math.ceil(this.pendingValidation.check.timeoutMs / 1_000)),
			}
		}
		const check = this.pendingPostApplyCheck
		if (!check) return undefined
		const command = validationCommand(check)
		const touchedPaths = this.touchedPaths()
		const before = await snapshotPatchFiles(this.cwd, touchedPaths)
		const beforeGitStatus = filterExpectedOutputs(await gitStatusPorcelain(this.cwd), check.expectedOutputs)
		this.pendingValidation = { check, command, startedAt: Date.now(), touchedPaths, before, beforeGitStatus }
		return {
			id: check.id,
			command,
			timeoutSeconds: Math.max(1, Math.ceil(check.timeoutMs / 1_000)),
		}
	}

	async recordPostApplyCheck(
		toolName: string,
		checkId: string,
		ok: boolean,
		exitCode: number | null = ok ? 0 : null,
	): Promise<void> {
		const pending = this.pendingValidation
		if (this.state !== "post_apply_checks" || !pending || pending.check.id !== checkId) return
		let mutation: CouncilPostApplyCheck["mutation"] =
			pending.check.mutationPolicy === "expected-output-only" ? "expected_only" : "none"
		let finalOk = ok
		let after: Awaited<ReturnType<typeof snapshotPatchFiles>> = pending.before
		try {
			after = await snapshotPatchFiles(this.cwd, pending.touchedPaths)
			const afterGitStatus = filterExpectedOutputs(await gitStatusPorcelain(this.cwd), pending.check.expectedOutputs)
			if (patchFilesChanged(pending.before, after) || afterGitStatus !== pending.beforeGitStatus) {
				finalOk = false
				try {
					await restorePatchFiles(this.cwd, pending.before)
					mutation = "unexpected_restored"
				} catch (error) {
					debugLog("restorePatchFiles failed after post-apply mutation", error)
					mutation = "unexpected_restore_failed"
				}
			}
		} catch (error) {
			debugLog("post-apply workspace verification failed", error)
			finalOk = false
			mutation = "unexpected_restore_failed"
		}
		this.postApplyChecks.push({
			id: pending.check.id,
			kind: pending.check.kind,
			toolName,
			command: pending.command,
			ok: finalOk,
			exitCode,
			durationMs: Math.max(0, Date.now() - pending.startedAt),
			beforeSha256: hashPatchFiles(pending.before),
			afterSha256: hashPatchFiles(after),
			mutationPolicy: pending.check.mutationPolicy,
			mutation,
		})
		this.pendingValidation = undefined
	}

	/**
	 * Requests a settlement decision for the active transaction. The first call latches
	 * `settlementEmitted` and returns the request; if the host never executes the corresponding
	 * settle tool call and the same resumed state is dispatched again, subsequent calls re-emit the
	 * identical request (same transaction id, patch hash, and action). Re-emitting is safe because
	 * `settle()` independently re-verifies the transaction id, patch hash, and post-apply outcome
	 * before acting.
	 *
	 * Only `finalize` counts against `MAX_TRANSACTION_REEMISSIONS`: once exhausted this returns
	 * `undefined` so the caller rolls back explicitly instead of retrying finalize forever. `rollback`
	 * is the safety action — there is no more-conservative fallback to give up into — so it keeps being
	 * re-emitted without bound; the whole-run deadline (checked on every resume) is what eventually
	 * ends a session whose host never executes any tool call at all.
	 */
	settlementRequest(action: "finalize" | "rollback"): CouncilSettlementRequest | undefined {
		if (action === "finalize" && !this.postApplyChecksPassed) return undefined
		if (this.state !== "post_apply_checks") return undefined
		if (this.settlementEmitted) {
			if (action === "finalize") {
				if (this.settlementReemissions >= MAX_TRANSACTION_REEMISSIONS) return undefined
				this.settlementReemissions += 1
			}
		} else {
			this.settlementEmitted = true
		}
		const transaction = this.requireCurrent()
		return { transactionId: transaction.id, patchSha256: transaction.changeSet().patchSha256, action }
	}

	/**
	 * True once a `finalize` settlement request has been emitted and re-emitted up to its bound
	 * without being executed. Rollback delivery has no bound to exhaust: `settlementRequest("rollback")`
	 * only ever returns `undefined` when the transaction has left `post_apply_checks` entirely.
	 */
	get settlementDeliveryExhausted(): boolean {
		return this.settlementEmitted && this.settlementReemissions >= MAX_TRANSACTION_REEMISSIONS
	}

	async settle(request: CouncilSettlementRequest): Promise<void> {
		const transaction = this.requireCurrent()
		if (request.transactionId !== transaction.id || request.patchSha256 !== transaction.changeSet().patchSha256) {
			throw new Error("Council settlement request does not match the active transaction")
		}
		if (request.action === "finalize" && !this.postApplyChecksPassed) {
			throw new Error("Council cannot finalize without successful deterministic validation")
		}
		if (request.action === "finalize") await transaction.finalizeApplied()
		else await transaction.rollbackApplied()
	}

	async abandon(): Promise<void> {
		if (!this.transaction) return
		if (this.transaction.hasChanges) this.lastChangeSet = this.transaction.changeSet()
		if (this.transaction.state === "post_apply_checks") await this.transaction.rollbackApplied()
		else if (!this.isTerminal(this.transaction.state)) await this.transaction.discard()
		this.applyEmitted = false
		this.applyReemissions = 0
		this.settlementEmitted = false
		this.settlementReemissions = 0
		this.pendingValidation = undefined
		this.acceptedResponseText = undefined
		this.acceptedResponseDegradedReason = undefined
	}

	private requireCurrent(): ChangeTransaction {
		if (!this.transaction) throw new Error("Council transaction is unavailable")
		return this.transaction
	}

	private assertWithinLimits(changeSet: ChangeSet): void {
		const changedLines = changeSet.stats.addedLines + changeSet.stats.removedLines
		if (changeSet.stats.files > this.limits.maxFiles) {
			throw new Error(`Council candidate exceeds the ${this.limits.maxFiles}-file transaction limit`)
		}
		if (changedLines > this.limits.maxChangedLines) {
			throw new Error(`Council candidate exceeds the ${this.limits.maxChangedLines}-line transaction limit`)
		}
		if (changeSet.stats.patchBytes > this.limits.maxPatchBytes) {
			throw new Error(`Council candidate exceeds the ${this.limits.maxPatchBytes}-byte transaction limit`)
		}
	}

	private isTerminal(state: ChangeTransaction["state"]): boolean {
		return this.isSafeTerminal(state) || state === "hard_recovery"
	}

	private isSafeTerminal(state: ChangeTransaction["state"]): boolean {
		return ["applied", "discarded", "rolled_back", "failed"].includes(state)
	}

	private outcome(state: ChangeTransaction["state"]): CouncilTransactionSnapshot["outcome"] {
		if (this.isTerminal(state)) return state as CouncilTransactionSnapshot["outcome"]
		return "pending"
	}
}

export const COUNCIL_DELETE_TOOL = "council_delete_file"
export const COUNCIL_RENAME_TOOL = "council_rename_file"
export const COUNCIL_CHECK_TOOL = "council_check_candidate"
export const COUNCIL_APPLY_TOOL = "apply_agent_patch"
export const COUNCIL_SETTLE_TOOL = "settle_agent_patch"

const COUNCIL_CUSTOM_TOOLS = [
	COUNCIL_DELETE_TOOL,
	COUNCIL_RENAME_TOOL,
	COUNCIL_CHECK_TOOL,
	COUNCIL_APPLY_TOOL,
	COUNCIL_SETTLE_TOOL,
] as const
const COUNCIL_INTERNAL_TOOLS = new Set([COUNCIL_APPLY_TOOL, COUNCIL_SETTLE_TOOL])
const COUNCIL_TRANSACTION_AWARE_TOOLS = new Set([
	"edit",
	"write",
	COUNCIL_DELETE_TOOL,
	COUNCIL_RENAME_TOOL,
	COUNCIL_APPLY_TOOL,
	COUNCIL_SETTLE_TOOL,
])
const COUNCIL_SAFE_CONTROL_TOOLS = new Set(["ask_user", COUNCIL_CHECK_TOOL])

type CouncilRuntimeLookup = (ctx: ExtensionContext) => CouncilTransactionRuntime | undefined

function councilSelected(model: Model<Api> | undefined): boolean {
	return model !== undefined && isCouncilVirtualModel(model)
}

function runtimeOrThrow(lookup: CouncilRuntimeLookup, ctx: ExtensionContext): CouncilTransactionRuntime {
	const runtime = lookup(ctx)
	if (!runtime) throw new Error("Council transaction route is unavailable")
	return runtime
}

/**
 * Describes the catalog check ids the lead may pass to `council_check_candidate`, so it can pick a
 * valid `check_id` without guessing. Built from the same validation catalog the runtime resolves
 * `checkCandidate()` against, so the two never drift.
 */
function candidateCheckToolDescription(validationCatalog: readonly ValidationCheck[]): string {
	const ids = validationCatalog.map((check) => `${check.id} (${check.kind})`).join(", ")
	return (
		"Run one deterministic validation check from the project's catalog against the staged Council " +
		"candidate. The check runs in an isolated temporary workspace built from the candidate; the real " +
		`workspace is never touched. Pass the exact check id from the validation catalog. Available check ids: ${ids}.`
	)
}

function formatCandidateCheckOutcome(outcome: CandidateCheckOutcome): string {
	const status = outcome.timedOut ? "timed out" : outcome.ok ? "passed" : "failed"
	const header =
		`Check "${outcome.id}" (${outcome.kind}) ${status} against the staged candidate in an isolated workspace ` +
		`(exit ${outcome.exitCode ?? "n/a"}, ${outcome.durationMs}ms). The real workspace was not touched.`
	return outcome.output.trim() ? `${header}\n\n${outcome.output}` : header
}

function wrapDefinition<TParams extends TSchema, TDetails, TState>(
	base: ToolDefinition<TParams, TDetails, TState>,
	createPassThrough: (ctx: ExtensionContext) => ToolDefinition<TParams, TDetails, TState>,
	createCandidate: (
		runtime: CouncilTransactionRuntime,
		ctx: ExtensionContext,
	) => ToolDefinition<TParams, TDetails, TState>,
	lookup: CouncilRuntimeLookup,
): ToolDefinition<TParams, TDetails, TState> {
	return {
		...base,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!councilSelected(ctx.model)) {
				return createPassThrough(ctx).execute(toolCallId, params, signal, onUpdate, ctx)
			}
			const runtime = runtimeOrThrow(lookup, ctx)
			return createCandidate(runtime, ctx).execute(toolCallId, params, signal, onUpdate, ctx)
		},
	}
}

export function registerCouncilTransactionTools(
	pi: ExtensionAPI,
	cwd: string,
	lookup: CouncilRuntimeLookup,
	validationCatalog: readonly ValidationCheck[] = [],
): void {
	const localRead = createReadToolDefinition(cwd)
	const localEdit = createEditToolDefinition(cwd)
	const localWrite = createWriteToolDefinition(cwd)
	pi.registerTool(
		wrapDefinition(
			localRead,
			(ctx) => createReadToolDefinition(ctx.cwd),
			(runtime, ctx) => {
				const transaction = runtime.ensure(ctx.cwd)
				return createReadToolDefinition(ctx.cwd, {
					operations: {
						readFile: (path) => transaction.readBuffer(path),
						access: (path) => transaction.assertAccessible(path),
					},
				})
			},
			lookup,
		),
	)
	pi.registerTool(
		wrapDefinition(
			localEdit,
			(ctx) => createEditToolDefinition(ctx.cwd),
			(runtime, ctx) => {
				const transaction = runtime.ensure(ctx.cwd)
				return createEditToolDefinition(ctx.cwd, {
					operations: {
						readFile: (path) => transaction.readBuffer(path),
						writeFile: (path, content) => transaction.stageWrite(path, content),
						access: (path) => transaction.assertAccessible(path),
					},
				})
			},
			lookup,
		),
	)
	pi.registerTool(
		wrapDefinition(
			localWrite,
			(ctx) => createWriteToolDefinition(ctx.cwd),
			(runtime, ctx) => {
				const transaction = runtime.ensure(ctx.cwd)
				return createWriteToolDefinition(ctx.cwd, {
					operations: {
						writeFile: (path, content) => transaction.stageWrite(path, content),
						mkdir: (path) => transaction.stageDirectory(path),
					},
				})
			},
			lookup,
		),
	)
	pi.registerTool(
		defineTool({
			name: COUNCIL_DELETE_TOOL,
			label: "delete",
			description:
				"Delete a file from the Council candidate. The real workspace is unchanged until review and approval.",
			promptSnippet: "Stage a file deletion in the Council candidate",
			parameters: Type.Object(
				{ path: Type.String({ description: "Workspace-relative or absolute file path" }) },
				{ additionalProperties: false },
			),
			async execute(_toolCallId, { path }, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council candidate tools require a Council model")
				await runtimeOrThrow(lookup, ctx).ensure(ctx.cwd).stageDelete(path)
				return { content: [{ type: "text", text: `Staged deletion: ${path}` }], details: undefined }
			},
		}),
	)
	pi.registerTool(
		defineTool({
			name: COUNCIL_RENAME_TOOL,
			label: "rename",
			description: "Rename a file in the Council candidate. The real workspace is unchanged until review and approval.",
			promptSnippet: "Stage a file rename in the Council candidate",
			parameters: Type.Object(
				{
					from_path: Type.String({ description: "Existing candidate file path" }),
					to_path: Type.String({ description: "New candidate file path" }),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, { from_path, to_path }, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council candidate tools require a Council model")
				await runtimeOrThrow(lookup, ctx).ensure(ctx.cwd).stageRename(from_path, to_path)
				return {
					content: [{ type: "text", text: `Staged rename: ${from_path} -> ${to_path}` }],
					details: undefined,
				}
			},
		}),
	)
	// A workspace with no catalog checks has nothing council_check_candidate could ever verify, so it
	// is left unregistered rather than advertised as a tool the lead can call but that can never succeed.
	if (validationCatalog.length > 0) {
		pi.registerTool(
			defineTool({
				name: COUNCIL_CHECK_TOOL,
				label: "verify candidate",
				description: candidateCheckToolDescription(validationCatalog),
				promptSnippet: "Verify the staged Council candidate against a catalog check before finishing",
				parameters: Type.Object(
					{ check_id: Type.String({ description: "Validation catalog check id" }) },
					{ additionalProperties: false },
				),
				async execute(_toolCallId, { check_id }, signal, _onUpdate, ctx) {
					if (!councilSelected(ctx.model)) throw new Error("Council candidate verification requires a Council model")
					const outcome = await runtimeOrThrow(lookup, ctx).checkCandidate(check_id, signal)
					return {
						content: [{ type: "text", text: formatCandidateCheckOutcome(outcome) }],
						details: outcome,
					}
				},
			}),
		)
	}
	pi.registerTool(
		defineTool({
			name: COUNCIL_APPLY_TOOL,
			label: "apply reviewed patch",
			description: "Internal Council promotion tool.",
			parameters: Type.Object(
				{
					transaction_id: Type.String(),
					patch_sha256: Type.String(),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council promotion requires a Council model")
				const request: CouncilPromotionRequest = {
					transactionId: params.transaction_id,
					patchSha256: params.patch_sha256,
				}
				const receipt = await runtimeOrThrow(lookup, ctx).apply(request)
				return {
					content: [
						{
							type: "text",
							text: `Applied reviewed patch ${receipt.patchSha256}. Continue Council settlement.`,
						},
					],
					details: receipt,
				}
			},
		}),
	)
	pi.registerTool(
		defineTool({
			name: COUNCIL_SETTLE_TOOL,
			label: "settle reviewed patch",
			description: "Internal Council finalization or rollback tool.",
			parameters: Type.Object(
				{
					transaction_id: Type.String(),
					patch_sha256: Type.String(),
					action: Type.Union([Type.Literal("finalize"), Type.Literal("rollback")]),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council settlement requires a Council model")
				const request: CouncilSettlementRequest = {
					transactionId: params.transaction_id,
					patchSha256: params.patch_sha256,
					action: params.action,
				}
				await runtimeOrThrow(lookup, ctx).settle(request)
				return {
					content: [
						{
							type: "text",
							text: request.action === "finalize" ? "Council patch finalized." : "Council patch rolled back.",
						},
					],
					details: undefined,
				}
			},
		}),
	)
}

export function syncCouncilTransactionToolVisibility(pi: ExtensionAPI, model: Model<Api> | undefined): void {
	const councilTools: readonly string[] = COUNCIL_CUSTOM_TOOLS
	const withoutCouncil = pi.getActiveTools().filter((name) => !councilTools.includes(name))
	pi.setActiveTools(councilSelected(model) ? [...withoutCouncil, ...COUNCIL_CUSTOM_TOOLS] : withoutCouncil)
}

export function installCouncilMutationGuard(pi: ExtensionAPI, lookup: CouncilRuntimeLookup): void {
	pi.on("tool_call", (event, ctx) => {
		if (!councilSelected(ctx.model)) return undefined
		const runtime = lookup(ctx)
		const toolName = event.toolName.toLowerCase()
		if (COUNCIL_TRANSACTION_AWARE_TOOLS.has(toolName)) return undefined
		if (COUNCIL_SAFE_CONTROL_TOOLS.has(toolName)) return undefined
		if (isReadOnlyTool(toolName)) return undefined
		if (toolName === "bash") {
			const input = event.input && typeof event.input === "object" ? event.input : undefined
			const command = input && "command" in input ? (input as { command?: unknown }).command : undefined
			if (typeof command === "string" && isReadOnlyBashCommand(command)) return undefined
			const checkId =
				input && "council_check_id" in input ? (input as { council_check_id?: unknown }).council_check_id : undefined
			if (
				runtime?.state === "post_apply_checks" &&
				typeof checkId === "string" &&
				runtime.isExpectedPostApplyCheck(checkId)
			) {
				return undefined
			}
		}
		return {
			block: true,
			reason:
				"Council stages mutations through edit, write, delete, and rename. Other mutating or unknown tools are blocked until the reviewed patch is settled.",
		}
	})
}

export function withoutInternalCouncilTools<T extends { name: string }>(tools: T[]): T[] {
	return tools.filter((tool) => !COUNCIL_INTERNAL_TOOLS.has(tool.name))
}
