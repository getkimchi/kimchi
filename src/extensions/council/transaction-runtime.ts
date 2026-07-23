import { randomUUID } from "node:crypto"
import type { ApplyReceipt, ChangeSet } from "../../agent-patch/index.js"
import { ChangeTransaction } from "../../agent-patch/index.js"
import { CouncilSessionCache } from "./cache.js"
import type { RunBudgetLimits, RunBudgetSnapshot } from "./run-context.js"
import type { CouncilStage, CouncilTransactionSnapshot } from "./types.js"
import {
	captureWorkspaceSnapshot,
	restoreWorkspaceSnapshot,
	type ValidationCheck,
	type ValidationCheckKind,
	type ValidationMutationPolicy,
	validationCatalogForPrompt,
	validationCommand,
	type WorkspaceSnapshot,
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

interface AcceptanceCapability {
	token: string
	transactionId: string
	patchSha256: string
	used: boolean
}

interface SettlementCapability {
	token: string
	transactionId: string
	patchSha256: string
	used: boolean
}

export interface CouncilPromotionRequest {
	token: string
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
	before: WorkspaceSnapshot
}

export interface CouncilRunBudgetState {
	limits: RunBudgetLimits
	startedAt: number
	deadlineAt: number
	snapshot: RunBudgetSnapshot
	repairsUsed: number
	repairedStages: CouncilStage[]
}

export interface CouncilRevisionObligation {
	id: string
	kind: "finding" | "requirement" | "missing_evidence"
	statement: string
	severity?: "critical" | "high"
}

export interface CouncilRevisionGate {
	reviewedPatchSha256: string
	obligations: CouncilRevisionObligation[]
}

export class CouncilTransactionRuntime {
	readonly cache = new CouncilSessionCache()
	private transaction?: ChangeTransaction
	private acceptance?: AcceptanceCapability
	private settlement?: SettlementCapability
	private settlementEmitted = false
	private postApplyChecks: CouncilPostApplyCheck[] = []
	private selectedValidationCheckIds: string[] = []
	private pendingValidation?: PendingPostApplyCheck
	private revisionGate?: CouncilRevisionGate
	private runBudget?: CouncilRunBudgetState
	private reviewedResponse?: string
	private agreement?: "low" | "medium" | "high"
	private lastChangeSet?: ChangeSet
	private baseVerification: CouncilTransactionSnapshot["baseVerification"] = "not_run"
	private fullReviewCount = 0
	private revisionCount = 0
	private finalCheckCount = 0

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
		if (this.selectedValidationCheckIds.length === 0) return false
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

	isExpectedPostApplyValidationCommand(command: string): boolean {
		return this.state === "post_apply_checks" && this.pendingValidation?.command === command.trim()
	}

	get savedRunBudget(): CouncilRunBudgetState | undefined {
		return this.runBudget ? structuredClone(this.runBudget) : undefined
	}

	get acceptedResponse(): string | undefined {
		return this.reviewedResponse
	}

	get reviewAgreement(): "low" | "medium" | "high" | undefined {
		return this.agreement
	}

	get pendingRevisionGate(): CouncilRevisionGate | undefined {
		return this.revisionGate ? structuredClone(this.revisionGate) : undefined
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
			revisionCount: this.revisionCount,
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
			this.acceptance = undefined
			this.settlement = undefined
			this.settlementEmitted = false
			this.postApplyChecks = []
			this.selectedValidationCheckIds = []
			this.pendingValidation = undefined
			this.revisionGate = undefined
			this.reviewedResponse = undefined
			this.agreement = undefined
			this.lastChangeSet = undefined
			this.baseVerification = "not_run"
			this.fullReviewCount = 0
			this.revisionCount = 0
			this.finalCheckCount = 0
		}
		return this.transaction
	}

	async resetForNewTurn(): Promise<void> {
		try {
			await this.abandon()
		} finally {
			this.resetRunBudget()
		}
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

	markFullReview(): void {
		if (this.fullReviewCount >= 1) throw new Error("Council transaction already received its one full review")
		this.fullReviewCount++
	}

	setRevisionGate(reviewedPatchSha256: string, obligations: CouncilRevisionObligation[]): void {
		if (this.revisionGate) throw new Error("Council transaction revision gate is already set")
		this.revisionGate = { reviewedPatchSha256, obligations: structuredClone(obligations) }
	}

	reopenForRevision(expectedPatchSha256: string): void {
		if (this.revisionCount >= 1) throw new Error("Council transaction permits only one lead revision")
		this.requireCurrent().reopenForRevision(expectedPatchSha256)
		this.revisionCount++
		this.acceptance = undefined
		this.reviewedResponse = undefined
	}

	markFinalCheck(): CouncilRevisionGate {
		if (!this.revisionGate) throw new Error("Council transaction has no revision obligations")
		if (this.finalCheckCount >= 1) throw new Error("Council transaction permits only one focused final check")
		this.finalCheckCount++
		return structuredClone(this.revisionGate)
	}

	clearRevisionGate(): void {
		this.revisionGate = undefined
	}

	setRequiredPostApplyChecks(checkIds: string[]): void {
		if (!["proposed", "revision"].includes(this.state)) {
			throw new Error(`Council cannot set post-apply checks while ${this.state}`)
		}
		const normalized = [...new Set(checkIds.map((id) => id.trim()).filter(Boolean))]
		if (normalized.length > 3) throw new Error("Council permits at most three required post-apply checks")
		const known = new Set(this.validationChecks.map(({ id }) => id))
		const unknown = normalized.find((id) => !known.has(id))
		if (unknown) throw new Error(`Council selected unknown validation check: ${unknown}`)
		this.selectedValidationCheckIds = normalized
	}

	setReviewAgreement(agreement: "low" | "medium" | "high"): void {
		if (!["proposed", "revision"].includes(this.state)) {
			throw new Error(`Council cannot set review agreement while ${this.state}`)
		}
		this.agreement = agreement
	}

	saveRunBudget(state: CouncilRunBudgetState): void {
		this.runBudget = structuredClone(state)
	}

	resetRunBudget(): void {
		this.runBudget = undefined
	}

	accept(expectedPatchSha256: string, reviewedResponse?: string): CouncilPromotionRequest {
		const transaction = this.requireCurrent()
		transaction.accept(expectedPatchSha256)
		if (reviewedResponse !== undefined) {
			if (!reviewedResponse.trim()) throw new Error("Council reviewed response must not be empty")
			this.reviewedResponse = reviewedResponse
		}
		const capability: AcceptanceCapability = {
			token: randomUUID(),
			transactionId: transaction.id,
			patchSha256: expectedPatchSha256,
			used: false,
		}
		this.acceptance = capability
		return this.publicCapability(capability)
	}

	promotionRequest(): CouncilPromotionRequest | undefined {
		if (!this.acceptance || this.acceptance.used) return undefined
		return this.publicCapability(this.acceptance)
	}

	async apply(request: CouncilPromotionRequest): Promise<ApplyReceipt> {
		const capability = this.acceptance
		if (
			!capability ||
			capability.used ||
			capability.token !== request.token ||
			capability.transactionId !== request.transactionId ||
			capability.patchSha256 !== request.patchSha256
		) {
			throw new Error("Council apply capability is invalid or already consumed")
		}
		capability.used = true
		let receipt: ApplyReceipt
		try {
			receipt = await this.requireCurrent().applyExact(request.patchSha256)
			this.baseVerification = "passed"
		} catch (error) {
			this.baseVerification = this.state === "failed" ? "failed" : "passed"
			throw error
		}
		this.settlement = {
			token: randomUUID(),
			transactionId: request.transactionId,
			patchSha256: request.patchSha256,
			used: false,
		}
		this.settlementEmitted = false
		this.postApplyChecks = []
		this.pendingValidation = undefined
		return receipt
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
		const before = await captureWorkspaceSnapshot(this.cwd, check.expectedOutputs)
		this.pendingValidation = { check, command, startedAt: Date.now(), before }
		return {
			id: check.id,
			command,
			timeoutSeconds: Math.max(1, Math.ceil(check.timeoutMs / 1_000)),
		}
	}

	async recordPostApplyCheck(
		toolName: string,
		command: string,
		ok: boolean,
		exitCode: number | null = ok ? 0 : null,
	): Promise<void> {
		const pending = this.pendingValidation
		if (this.state !== "post_apply_checks" || !pending || pending.command !== command.trim()) return
		let afterSha256: string | undefined
		let mutation: CouncilPostApplyCheck["mutation"] =
			pending.check.mutationPolicy === "expected-output-only" ? "expected_only" : "none"
		let finalOk = ok
		try {
			const after = await captureWorkspaceSnapshot(this.cwd, pending.check.expectedOutputs)
			afterSha256 = after.sha256
			if (after.sha256 !== pending.before.sha256) {
				finalOk = false
				try {
					await restoreWorkspaceSnapshot(this.cwd, pending.before)
					mutation = "unexpected_restored"
				} catch {
					mutation = "unexpected_restore_failed"
				}
			}
		} catch {
			finalOk = false
			try {
				await restoreWorkspaceSnapshot(this.cwd, pending.before)
				mutation = "unexpected_restored"
			} catch {
				mutation = "unexpected_restore_failed"
			}
		}
		this.postApplyChecks.push({
			id: pending.check.id,
			kind: pending.check.kind,
			toolName,
			command: pending.command,
			ok: finalOk,
			exitCode,
			durationMs: Math.max(0, Date.now() - pending.startedAt),
			beforeSha256: pending.before.sha256,
			afterSha256,
			mutationPolicy: pending.check.mutationPolicy,
			mutation,
		})
		this.pendingValidation = undefined
	}

	settlementRequest(action: "finalize" | "rollback"): CouncilSettlementRequest | undefined {
		if (action === "finalize" && !this.postApplyChecksPassed) return undefined
		if (!this.settlement || this.settlement.used || this.settlementEmitted) return undefined
		this.settlementEmitted = true
		return { ...this.publicCapability(this.settlement), action }
	}

	async settle(request: CouncilSettlementRequest): Promise<void> {
		const capability = this.settlement
		if (
			!capability ||
			capability.used ||
			capability.token !== request.token ||
			capability.transactionId !== request.transactionId ||
			capability.patchSha256 !== request.patchSha256
		) {
			throw new Error("Council settlement capability is invalid or already consumed")
		}
		if (request.action === "finalize" && !this.postApplyChecksPassed) {
			throw new Error("Council cannot finalize without successful deterministic validation")
		}
		capability.used = true
		if (request.action === "finalize") await this.requireCurrent().finalizeApplied()
		else await this.requireCurrent().rollbackApplied()
	}

	async abandon(): Promise<void> {
		if (!this.transaction) return
		if (this.transaction.hasChanges) this.lastChangeSet = this.transaction.changeSet()
		if (this.transaction.state === "post_apply_checks") await this.transaction.rollbackApplied()
		else if (!this.isTerminal(this.transaction.state)) await this.transaction.discard()
		this.acceptance = undefined
		this.settlement = undefined
		this.settlementEmitted = false
		this.pendingValidation = undefined
		this.revisionGate = undefined
		this.reviewedResponse = undefined
		this.agreement = undefined
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

	private publicCapability(capability: AcceptanceCapability | SettlementCapability): CouncilPromotionRequest {
		return {
			token: capability.token,
			transactionId: capability.transactionId,
			patchSha256: capability.patchSha256,
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
