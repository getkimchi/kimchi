import type { PromptResponse } from "@agentclientprotocol/sdk"

export type TurnContext = {
	cancelled: boolean
	hiddenToolCallIds: Set<string>
	announcedToolCallIds: Set<string>
	lastStreamedContent: Map<string, string>
	/**
	 * Terminal stopReason of the last assistant message_end; cleared by a
	 * later non-error one (pi retry recovered). Read at finalize (prompt()
	 * resolve) — an "error" surviving here must failTurn, never end_turn.
	 */
	lastAssistantError?: { stopReason: "error"; errorMessage?: string }
	/**
	 * Pre-write file contents read at tool_execution_start for `write` tool
	 * calls: the original file content if the file existed (later surfaced as
	 * the diff's oldText), null for a new file. Keyed by toolCallId; the entry
	 * is consumed and cleared at tool_execution_end. Args travel only on
	 * tool_execution_start (ToolExecutionEndEvent carries none), so everything
	 * the end event needs must be captured here.
	 */
	preWriteContents: Map<string, string | null>
	/**
	 * File changes derived from tool args at tool_execution_start for the
	 * mutation tools (edit, write). Emitted as ACP `diff` content blocks at
	 * tool_execution_end; key removed once consumed. Read-only tools never
	 * appear here. Write entries keep their operation undecided until the end
	 * event resolves add-vs-modify from preWriteContents.
	 */
	pendingFileChanges: Map<string, PendingFileChange[]>
	usage: TurnUsage
	resolve: (res: PromptResponse) => void
	reject: (err: unknown) => void
}

/**
 * Per-turn usage accumulator. pi-mono chains multiple agent.prompt /
 * agent.continue calls per turn, each producing an AssistantMessage with its
 * own pi-ai `usage`; ACP's (v1/experimental) PromptResponse.usage expects a
 * single summary, so message_end events fold their usage into this record and
 * finalizeTurn emits the summed totals. `messages` counts the assistant
 * usage records folded in — it gates the optional PromptResponse.usage field
 * (omitted when no usage data was collected, e.g. a cancel before the first
 * message).
 */
export type TurnUsage = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	reasoning: number
	/** Sum of the provider-computed usage.totalTokens across the chain. */
	total: number
	/** true once any provider actually reported a reasoning/thought count. */
	sawReasoning: boolean
	messages: number
}

/**
 * Internal file-mutation abstraction shared by the v1 and (future) v2 ACP
 * diff adapters. Populated from tool args at tool_execution_start so the v1
 * emission ({@link fileChangeToDiffContent}) is a pure adapter over data
 * already known before the tool ran — v2 migration is a pure adapter swap.
 */
export interface FileChange {
	path: string
	operation: "add" | "modify" | "delete"
	/** undefined for "add" */
	oldText?: string
	/** undefined for "delete" */
	newText?: string
}

/**
 * Captured-at-start representation of a pending diff. Edit calls resolve to
 * FileChange immediately (args carry both texts). Write calls carry the
 * "write" sentinel: whether the change is an add or a modify depends on
 * TurnContext.preWriteContents, which is only consulted at tool_execution_end
 * ({@link resolveFileChange}) — that is what keeps preWriteContents the
 * single source of truth for the write oldText.
 */
export type PendingFileChange = FileChange | { operation: "write"; path: string; newText: string }
