export type ChangeTransactionState =
	| "exploring"
	| "staging"
	| "proposed"
	| "revision"
	| "accepted"
	| "base_verification"
	| "applying"
	| "post_apply_checks"
	| "applied"
	| "discarded"
	| "rolled_back"
	| "failed"
	| "hard_recovery"

export interface BaseSnapshot {
	path: string
	exists: boolean
	sha256?: string
	mode?: number
}

interface ChangeOperationBase {
	path: string
	content?: string
	mode?: number
}

export interface CreateOperation extends ChangeOperationBase {
	kind: "create"
	content: string
}

export interface UpdateOperation extends ChangeOperationBase {
	kind: "update"
	baseSha256: string
	content: string
}

export interface DeleteOperation extends ChangeOperationBase {
	kind: "delete"
	baseSha256: string
}

export interface RenameOperation extends ChangeOperationBase {
	kind: "rename"
	fromPath: string
	baseSha256: string
	content: string
}

export type ChangeOperation = CreateOperation | UpdateOperation | DeleteOperation | RenameOperation

export interface ChangeSetStats {
	files: number
	addedLines: number
	removedLines: number
	patchBytes: number
}

export interface ChangeSet {
	transactionId: string
	operations: ChangeOperation[]
	base: BaseSnapshot[]
	patch: string
	patchSha256: string
	stats: ChangeSetStats
}

export interface BaseConflict {
	path: string
	reason: "appeared" | "missing" | "content_changed" | "mode_changed" | "unsafe_path"
}

export interface BaseVerification {
	ok: boolean
	conflicts: BaseConflict[]
}

export interface ApplyReceipt {
	transactionId: string
	patchSha256: string
	appliedPaths: string[]
	rollbackAvailable: boolean
}
