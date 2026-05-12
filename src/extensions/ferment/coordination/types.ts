/**
 * types.ts — Ferment coordination work-item types and store interface.
 *
 * Derived from docs/ferment-coordination-layout.md (spec v1).
 */

// ─── Work-item state machine ──────────────────────────────────────────────────

export type WorkItemState = "todo" | "ready" | "in-progress" | "blocked" | "done" | "archive"

export const WORK_ITEM_STATES: readonly WorkItemState[] = ["todo", "ready", "in-progress", "blocked", "done", "archive"]

// ─── Agent role ───────────────────────────────────────────────────────────────

export type AgentRole = "planner" | "judge" | "worker"

// ─── Core work-item ───────────────────────────────────────────────────────────

export interface WorkItem {
	schema_version: 1
	id: string
	title: string
	body: string
	ferment_id: string
	phase_id?: string
	agent_role?: AgentRole
	parents: string[]
	created_at: string
	updated_at: string
	claimed_by?: string
	claimed_at?: string
	result_summary?: string
	block_reason?: string
}

// ─── Creation input (dispatcher-authored fields) ──────────────────────────────

export interface WorkItemCreateInput {
	title: string
	body: string
	ferment_id: string
	phase_id?: string
	agent_role?: AgentRole
	parents?: string[]
}

// ─── CoordinationStore interface ──────────────────────────────────────────────

export interface CoordinationStore {
	/**
	 * Create a new work item in `todo/`.
	 *
	 * Generates id, timestamps, and persists JSON.
	 */
	create(input: WorkItemCreateInput): WorkItem

	/**
	 * Claim a work item: `ready` → `in-progress`.
	 *
	 * Acquires a lock, writes `claimed_by`/`claimed_at`, and atomically renames
	 * the file. Returns the updated item or undefined if the item is not in
	 * `ready` or lock acquisition fails.
	 */
	claim(itemId: string, agentId: string): WorkItem | undefined

	/**
	 * Complete a work item: `in-progress` → `done`.
	 *
	 * Sets `result_summary`, releases the lock, and atomically renames the file.
	 */
	complete(itemId: string, result_summary: string): WorkItem | undefined

	/**
	 * Block a work item: `in-progress` → `blocked`.
	 *
	 * Sets `block_reason`, releases the lock, and atomically renames the file.
	 */
	block(itemId: string, reason: string): WorkItem | undefined

	/**
	 * Unblock a work item: `blocked` → `ready`.
	 *
	 * Clears `block_reason` and atomically renames the file.
	 */
	unblock(itemId: string): WorkItem | undefined

	/**
	 * Archive a work item: `done` → `archive`.
	 *
	 * Atomically renames the file into the archive directory.
	 */
	archive(itemId: string): WorkItem | undefined

	/**
	 * Delete a work item from any state directory.
	 *
	 * Returns true if a file was removed.
	 */
	delete(itemId: string): boolean

	/**
	 * Load a work item by id (searching all state directories).
	 */
	get(itemId: string): WorkItem | undefined

	/**
	 * List work items.
	 *
	 * If `state` is provided, only that directory is scanned.
	 * Otherwise all directories are scanned.
	 */
	list(state?: WorkItemState): WorkItem[]

	/**
	 * Promote items from `todo` to `ready` when all their parents are in `done`.
	 *
	 * Returns the number of items promoted.
	 */
	promoteReady(): number

	/**
	 * Absolute path to the coordination root directory.
	 */
	getDir(): string
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class CoordinationError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
	) {
		super(message)
		this.name = "CoordinationError"
	}
}
