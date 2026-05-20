/**
 * types.ts — Type definitions for the agents extension.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { ModelStrength, ModelTier } from "../../orchestration/model-registry/types.js"
import type { LifetimeUsage } from "../manager/usage.js"

/** Thinking/reasoning level for models that support it. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

export type AgentAbortReason = "max_turns" | "token_budget" | "inactivity"

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string

/**
 * Named constants for the embedded default agents.
 * Use these instead of hardcoded string literals so renames stay safe.
 */
export const AGENT_GENERAL_PURPOSE = "General-Purpose"
export const AGENT_EXPLORE = "Explore"
export const AGENT_PLAN = "Plan"
export const AGENT_RESEARCHER = "Researcher"

/** Names of the embedded default agents (in canonical display order). */
export const DEFAULT_AGENT_NAMES = [AGENT_GENERAL_PURPOSE, AGENT_EXPLORE, AGENT_PLAN, AGENT_RESEARCHER] as const

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local"

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree"

/** Re-export orchestration types used in agent configs. */
export type { ModelStrength, ModelTier }

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
	/**
	 * Set of models this persona may use. The list order has NO semantics —
	 * it is not a tier ranking. The calling LLM is shown the set in the Agent
	 * tool's description and picks per spawn based on capability metadata
	 * (tier, strengths) it knows from the orchestration model registry. If
	 * the caller omits `model`, the runtime falls back to the first entry as
	 * a stable default — that is NOT a complexity-aware pick. Each entry is
	 * a "<provider>/<id>" string. Legacy `model:` frontmatter is
	 * auto-promoted to a single-element array on load.
	 */
	models?: string[]
	/** true = profile model selection wins over caller-provided model. */
	modelLocked?: boolean
	thinking?: ThinkingLevel
	maxTurns?: number
	tokenBudget?: number
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
	source?: "default" | "project" | "global" | "package"
	/**
	 * Task strengths this persona is optimized for. Used by the orchestrator
	 * auto-pick logic when no model is explicitly specified and models[] is empty.
	 */
	strengths?: ModelStrength[]
	/**
	 * Preferred model tier for auto-pick. Defaults to "standard" when strengths
	 * are set. Ignored when models[] is populated or model is passed explicitly.
	 */
	preferTier?: ModelTier
}

export type JoinMode = "async" | "group" | "smart"
export type AgentVisibility = "user" | "system"

export interface AgentRecord {
	id: string
	type: SubagentType
	description: string
	/** user = visible in UI/notifications; system = hidden technical/background work. */
	visibility: AgentVisibility
	status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error"
	abortReason?: AgentAbortReason
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
	/** Persisted session file for this agent run, when the parent session is persisted. */
	sessionFile?: string
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
	abortReason?: AgentAbortReason
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
