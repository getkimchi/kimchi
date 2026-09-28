/**
 * board.ts — Host-owned coordination board for subagents in the same group.
 *
 * Board state lives in AgentManager, keyed by (rootSessionId, groupId).
 * The host supplies author identity, timestamp, and group membership from
 * live agent records — models never assert them.
 *
 * Manual posts are append-only. Host snapshots replace superseded progress.
 * Evictions emit body-free events.
 * Same-group scoping: reads and writes require a live agent in the same group.
 */

import { randomUUID } from "node:crypto"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"

export const BOARD_ENTRY_CUSTOM_TYPE = "agent-board:entry:v1"

/** Max length of a board entry title (host-truncated). */
export const BOARD_ENTRY_TITLE_MAX = 120
/** Max length of a board entry body (host-truncated). */
export const BOARD_ENTRY_BODY_MAX = 2048
/** Maximum entries per-board key (FIFO eviction). */
export const PER_BOARD_CAP = 200
/** Maximum entries across all boards. */
export const GLOBAL_BOARD_CAP = 2048
/** Dedupe window in ms (same author, kind, normalized title and exact body). */
export const BOARD_DEDUPE_WINDOW_MS = 120_000

export type BoardEntryKind = "note" | "work" | "finding" | "warning"

export interface BoardEntry {
	id: string // "bd-" + 8 hex
	rootSessionId: string
	groupId: string
	authorAgentId: string // host-stamped from live record, never model input
	kind: BoardEntryKind
	title: string // <= 120 chars, host-truncated + flag in receipt
	body: string // <= 2048 chars, host-truncated + flag in receipt
	postedAt: number // Date.now(), host-stamped
	/** Host-only identity for replaceable progress; absent on manual posts. */
	snapshotKey?: string
}

export interface BoardEntrySummary {
	id: string
	authorAgentId: string
	kind: BoardEntryKind
	title: string
	postedAt: number
}

export interface BoardSummary {
	total: number
	latest: BoardEntrySummary[]
}

export type BoardPostReceipt =
	| { ok: true; entry: BoardEntry; truncated: Array<"title" | "body">; deduped?: false }
	| { ok: true; deduped: true; entry: BoardEntry }
	| { ok: false; reason: "not_authorized_for_board" | "agent_not_live" }

export type BoardReadReceipt =
	| { ok: true; entries: BoardEntry[]; total: number }
	| { ok: false; reason: "not_authorized_for_board" | "agent_not_live" }
	| { ok: false; reason: "unknown_group"; availableGroupIds: string[] }

export type BoardEvent =
	| {
			action: "posted"
			entryId: string
			rootSessionId: string
			groupId: string
			authorAgentId: string
			kind: BoardEntryKind
			title: string
	  }
	| { action: "evicted"; entryId: string; rootSessionId: string; groupId: string }

/** Keep titles on one line; body whitespace may be significant code or evidence. */
function normalize(input: string): string {
	return input.trim().replace(/\s+/g, " ")
}

/** Generate a board entry ID ("bd-" + 8 hex chars). */
function createBoardId(): string {
	return `bd-${randomUUID().slice(0, 8)}`
}

/**
 * Dedupe key shape: authorAgentId + kind + normalized title + exact body
 * (own namespace — does NOT reuse AgentManager.loopGuardKeys).
 */
function createDedupeKey(
	authorAgentId: string,
	kind: BoardEntryKind,
	title: string,
	body: string,
	snapshotKey?: string,
): string {
	return JSON.stringify([authorAgentId, kind, normalize(title), body, snapshotKey ?? ""])
}

/** Session data may be from an older version or a manually edited journal. */
function isBoardEntry(value: unknown): value is BoardEntry {
	if (typeof value !== "object" || value === null) return false
	const entry = value as Partial<BoardEntry>
	return (
		typeof entry.id === "string" &&
		entry.id.startsWith("bd-") &&
		typeof entry.rootSessionId === "string" &&
		entry.rootSessionId.length > 0 &&
		typeof entry.groupId === "string" &&
		entry.groupId.length > 0 &&
		typeof entry.authorAgentId === "string" &&
		entry.authorAgentId.length > 0 &&
		["note", "work", "finding", "warning"].includes(entry.kind ?? "") &&
		typeof entry.title === "string" &&
		entry.title.length <= BOARD_ENTRY_TITLE_MAX &&
		typeof entry.body === "string" &&
		entry.body.length <= BOARD_ENTRY_BODY_MAX &&
		typeof entry.postedAt === "number" &&
		Number.isFinite(entry.postedAt) &&
		entry.postedAt >= 0 &&
		(entry.snapshotKey === undefined || typeof entry.snapshotKey === "string")
	)
}

/**
 * BoardStore — keyed map from (rootSessionId, groupId) → ordered entries.
 *
 * Per-board cap 200 (FIFO eviction, returns evicted ids).
 * Global ceiling 2048 (evict globally-oldest, returns evicted ids).
 * Dedupe within 120s (own key namespace).
 */
export class BoardStore {
	/** Flat map of "rootSessionId:groupId" → BoardEntry[] (preserves insertion order). */
	private boards = new Map<string, BoardEntry[]>()
	/** Dedupe map: key → { postedAt, entry } (entry returned on dedupe hit). Own namespace. */
	private dedupeKeys = new Map<string, { postedAt: number; entry: BoardEntry }>()
	private totalEntries = 0

	private boardKey(rootSessionId: string, groupId: string): string {
		return `${rootSessionId}:${groupId}`
	}

	private getOrCreateBoard(key: string): BoardEntry[] {
		let board = this.boards.get(key)
		if (!board) {
			board = []
			this.boards.set(key, board)
		}
		return board
	}

	/** Restore only this root's current branch; historical authors gain no live capabilities. */
	restoreRoot(rootSessionId: string, journal: readonly SessionEntry[]): void {
		this.cleanupRoot(rootSessionId)
		const seen = new Set<string>()
		for (const record of journal) {
			if (record.type !== "custom" || record.customType !== BOARD_ENTRY_CUSTOM_TYPE) continue
			const entry = record.data
			if (!isBoardEntry(entry) || entry.rootSessionId !== rootSessionId || seen.has(entry.id)) continue
			seen.add(entry.id)
			this.insert({ ...entry })
		}
	}

	/**
	 * Post a new board entry. Dedupe checks within 120s window (same author,
	 * kind, normalized title and exact body). Per-board FIFO at cap 200; global FIFO
	 * at cap 2048.
	 */
	post(
		rootSessionId: string,
		groupId: string,
		authorAgentId: string,
		kind: BoardEntryKind,
		title: string,
		body: string,
		now: number,
		snapshotKey?: string,
	): {
		entry: BoardEntry
		truncated: Array<"title" | "body">
		evicted?: BoardEntry
		deduped?: true
	} {
		const truncated: Array<"title" | "body"> = []
		let effectiveTitle = normalize(title)
		let effectiveBody = body
		if (effectiveTitle.length > BOARD_ENTRY_TITLE_MAX) {
			effectiveTitle = effectiveTitle.slice(0, BOARD_ENTRY_TITLE_MAX)
			truncated.push("title")
		}
		if (effectiveBody.length > BOARD_ENTRY_BODY_MAX) {
			effectiveBody = effectiveBody.slice(0, BOARD_ENTRY_BODY_MAX)
			truncated.push("body")
		}

		// Dedupe key uses EFFECTIVE (truncated) values so stored entries match.
		const dedupeKey = createDedupeKey(authorAgentId, kind, effectiveTitle, effectiveBody, snapshotKey)
		const cutoff = now - BOARD_DEDUPE_WINDOW_MS

		// Sweep expired dedupe keys (postedAt older than the dedupe window).
		for (const [k, { postedAt }] of this.dedupeKeys) {
			if (postedAt < cutoff) this.dedupeKeys.delete(k)
		}

		// Map hit is authoritative: evictions delete their dedupe keys, so the
		// stored entry is still on a board — return it without re-scanning.
		const existing = this.dedupeKeys.get(dedupeKey)
		if (existing !== undefined && existing.postedAt >= cutoff) {
			return { entry: existing.entry, truncated: [], deduped: true }
		}

		const entry: BoardEntry = {
			id: createBoardId(),
			rootSessionId,
			groupId,
			authorAgentId,
			kind,
			title: effectiveTitle,
			body: effectiveBody,
			postedAt: now,
			...(snapshotKey ? { snapshotKey } : {}),
		}
		return { entry, truncated, evicted: this.insert(entry) }
	}

	private insert(entry: BoardEntry): BoardEntry | undefined {
		const { rootSessionId, groupId, authorAgentId, snapshotKey } = entry
		const key = this.boardKey(rootSessionId, groupId)
		const board = this.getOrCreateBoard(key)
		let evicted: BoardEntry | undefined
		if (snapshotKey) {
			const previous = board.findIndex(
				(item) => item.authorAgentId === authorAgentId && item.snapshotKey === snapshotKey,
			)
			if (previous >= 0) {
				evicted = board.splice(previous, 1)[0]
				this.removeDedupeKey(evicted)
				this.totalEntries--
			}
		}
		board.push(entry)
		this.totalEntries++
		this.dedupeKeys.set(createDedupeKey(authorAgentId, entry.kind, entry.title, entry.body, snapshotKey), {
			postedAt: entry.postedAt,
			entry,
		})

		// Per-board eviction: FIFO at cap
		if (board.length > PER_BOARD_CAP) {
			const removed = board.shift()
			if (removed) {
				this.removeDedupeKey(removed)
				evicted = removed
				this.totalEntries--
			}
		}

		// Global eviction: evict globally-oldest when total exceeds cap
		if (this.totalEntries > GLOBAL_BOARD_CAP) {
			const oldest = this.findGloballyOldest()
			if (oldest) {
				const oldKey = this.boardKey(oldest.rootSessionId, oldest.groupId)
				const oldBoard = this.getOrCreateBoard(oldKey)
				const idx = oldBoard.indexOf(oldest)
				if (idx >= 0) {
					oldBoard.splice(idx, 1)
					this.removeDedupeKey(oldest)
					this.totalEntries--
					if (!evicted) evicted = oldest
				}
			}
		}

		return evicted
	}

	/**
	 * Read entries from a board. `sinceId` filters to only entries after
	 * the given id. Unknown sinceId → full list (no error — avoids stale
	 * cursor failures). `kind` filter narrows by kind. `limit` caps results.
	 */
	read(
		rootSessionId: string,
		groupId: string,
		opts?: { sinceId?: string; kind?: BoardEntryKind; limit?: number },
	): BoardEntry[] {
		const key = this.boardKey(rootSessionId, groupId)
		const board = this.boards.get(key) ?? []
		const sinceId = opts?.sinceId
		const kindFilter = opts?.kind
		const limit = Math.min(opts?.limit ?? 50, 200)

		let cursor: number | undefined
		if (sinceId) {
			const idx = board.findIndex((e) => e.id === sinceId)
			if (idx >= 0) cursor = idx
		}

		let results = cursor !== undefined ? board.slice(cursor + 1) : [...board]

		if (kindFilter) {
			results = results.filter((e) => e.kind === kindFilter)
		}

		return results.slice(0, limit)
	}

	/**
	 * Get a summary of a board: total count + up to 3 latest entries.
	 */
	getSummary(rootSessionId: string, groupId: string): BoardSummary {
		const key = this.boardKey(rootSessionId, groupId)
		const board = this.boards.get(key) ?? []
		return {
			total: board.length,
			latest: this.latestOf(board),
		}
	}

	/** Discovery metadata for deliberate peer posts; progress remains in full reads and parent summaries. */
	getPeerHint(rootSessionId: string, groupId: string, readerAgentId: string): { total: number; latestId?: string } {
		const board = this.boards.get(this.boardKey(rootSessionId, groupId)) ?? []
		const entries = board.filter((entry) => entry.authorAgentId !== readerAgentId && !entry.snapshotKey)
		return { total: entries.length, latestId: entries.at(-1)?.id }
	}

	/**
	 * Get summaries for ALL boards under a given rootSessionId.
	 * Returns only non-empty boards (total > 0), in insertion order of groupIds.
	 * The returned array preserves insertion order of boards.
	 */
	getSummariesForRoot(rootSessionId: string): Array<{ groupId: string; total: number; latest: BoardEntrySummary[] }> {
		const results: Array<{ groupId: string; total: number; latest: BoardEntrySummary[] }> = []
		const prefix = `${rootSessionId}:`
		for (const [key, board] of this.boards) {
			if (!key.startsWith(prefix)) continue
			if (board.length === 0) continue
			const groupId = key.slice(prefix.length)
			results.push({ groupId, total: board.length, latest: this.latestOf(board) })
		}
		return results
	}

	/**
	 * Cleanup boards for a given rootSessionId when all agents are gone.
	 */
	cleanupRoot(rootSessionId: string): void {
		const rootKeyPrefix = `${rootSessionId}:`
		for (const [key, board] of this.boards) {
			if (key.startsWith(rootKeyPrefix)) {
				for (const entry of board) {
					// Entries are stored with their effective (truncated) values —
					// reconstruct the dedupe key from those to match what post() stores.
					// normalize() is idempotent on stored values, so output is byte-identical.
					this.removeDedupeKey(entry)
				}
				this.totalEntries -= board.length
				this.boards.delete(key)
			}
		}
	}

	/** Latest-3 summaries of a board, newest first. */
	private latestOf(board: BoardEntry[]): BoardEntrySummary[] {
		return board
			.slice(-3)
			.reverse()
			.map((e) => ({
				id: e.id,
				authorAgentId: e.authorAgentId,
				kind: e.kind,
				title: e.title,
				postedAt: e.postedAt,
			}))
	}

	/**
	 * Delete an evicted entry's dedupe key so map hits can't return evicted
	 * entries. Skipped when a newer re-post (after window expiry) already
	 * owns the key.
	 */
	private removeDedupeKey(entry: BoardEntry): void {
		const key = createDedupeKey(entry.authorAgentId, entry.kind, entry.title, entry.body, entry.snapshotKey)
		if (this.dedupeKeys.get(key)?.entry === entry) this.dedupeKeys.delete(key)
	}

	private findGloballyOldest(): BoardEntry | undefined {
		let oldest: BoardEntry | undefined
		for (const board of this.boards.values()) {
			for (const entry of board) {
				if (!oldest || entry.postedAt < oldest.postedAt) {
					oldest = entry
				}
			}
		}
		return oldest
	}
}
