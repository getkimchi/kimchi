/**
 * types.ts — Type definitions for the agents extension.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent"
import type { LifetimeUsage } from "./usage.js"

/** Thinking/reasoning level for models that support it. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local"

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree"

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
	name: string
	displayName?: string
	description: string
	builtinToolNames?: string[]
	/** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
	disallowedTools?: string[]
	/** true = inherit all, string[] = only listed, false = none */
	extensions: true | string[] | false
	/** true = inherit all, string[] = only listed, false = none */
	skills: true | string[] | false
	model?: string
	thinking?: ThinkingLevel
	maxTurns?: number
	systemPrompt: string
	promptMode: "replace" | "append"
	/** Default for spawn: fork parent conversation. undefined = caller decides. */
	inheritContext?: boolean
	/** Default for spawn: run in background. undefined = caller decides. */
	runInBackground?: boolean
	/** Default for spawn: no extension tools. undefined = caller decides. */
	isolated?: boolean
	/** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
	memory?: MemoryScope
	/** Isolation mode — "worktree" runs the agent in a temporary git worktree */
	isolation?: IsolationMode
	/** true = this is an embedded default agent (informational) */
	isDefault?: boolean
	/** false = agent is hidden from the registry */
	enabled?: boolean
	/** Where this agent was loaded from */
	source?: "default" | "project" | "global"
}

export type JoinMode = "async" | "group" | "smart"

export interface AgentRecord {
	id: string
	type: SubagentType
	description: string
	status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error"
	result?: string
	error?: string
	toolUses: number
	startedAt: number
	completedAt?: number
	session?: AgentSession
	abortController?: AbortController
	promise?: Promise<string>
	groupId?: string
	joinMode?: JoinMode
	/** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
	resultConsumed?: boolean
	/** Steering messages queued before the session was ready. */
	pendingSteers?: string[]
	/** The tool_use_id from the original Agent tool call. */
	toolCallId?: string
	/** Path to the streaming output transcript file. */
	outputFile?: string
	/** Cleanup function for the output file stream subscription. */
	outputCleanup?: () => void
	/**
	 * Lifetime usage breakdown, accumulated via `message_end` events. Survives
	 * compaction. Total = input + output + cacheWrite (cacheRead deliberately
	 * excluded). Initialized to zeros at spawn.
	 */
	lifetimeUsage: LifetimeUsage
	/** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
	compactionCount: number
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
	id: string
	description: string
	status: string
	toolUses: number
	turnCount: number
	maxTurns?: number
	totalTokens: number
	durationMs: number
	outputFile?: string
	error?: string
	resultPreview: string
	/** Additional agents in a group notification. */
	others?: NotificationDetails[]
}

export interface EnvInfo {
	isGitRepo: boolean
	branch: string
	platform: string
}
