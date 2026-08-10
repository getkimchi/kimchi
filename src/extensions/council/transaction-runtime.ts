import type { ApplyReceipt, ChangeSet } from "../../agent-patch/index.js"
import { ChangeTransaction } from "../../agent-patch/index.js"
import { CouncilSessionCache } from "./cache.js"
import { type CandidateCheckOutcome, runCandidateCheck } from "./candidate-check.js"
import { debugLog } from "./debug.js"
import type { RunBudgetLimits, RunBudgetSnapshot } from "./run-context.js"
import type { CouncilDegradedReason, CouncilStage, CouncilTransactionSnapshot } from "./types.js"
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

export interface CouncilTransactionLimits {
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

export interface CouncilSettlementRequest extends CouncilPromotionRequest {
	action: "finalize" | "rollback"
}

export interface CouncilPostApplyCheck {
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

export interface CouncilRunBudgetState {
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
