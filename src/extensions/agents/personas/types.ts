/**
 * types.ts — Type definitions for the agents extension.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { ModelTier } from "../../orchestration/model-registry/types.js"
import type { ModelRole } from "../../orchestration/model-roles.js"
import type { LifetimeUsage } from "../manager/usage.js"
import type { FermentWorkerBudgetTier } from "../worker-budget-policy.js"

/** Thinking/reasoning level for models that support it. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

export type AgentAbortReason = "max_turns" | "token_budget" | "inactivity" | "max_duration"
export type AgentOutcomeKind = "completed" | "budget_exhausted" | "failed" | "stopped"

export interface AgentTaskRef {
	kind: "ferment_step"
	ferment_id: string
	phase_id: string
	step_id: string
	budget_tier?: FermentWorkerBudgetTier
}

export interface AgentResumeAttempt {
	attempt_id: number
	purpose: "continuation" | "finalize_report"
	startedAt: number
	completedAt?: number
	maxTurns?: number
	tokenBudget?: number
	outcome?: AgentOutcomeKind
	reason?: AgentAbortReason | "error"
}

export interface AgentReport {
	/** Host-assigned execution attempt. Workers cannot choose this value. */
	attempt_id: number
	status: "completed" | "partial" | "blocked"
	summary: string
	steps_completed: string[]
	remaining_steps: string[]
	files_touched?: string[]
	verification?: string[]
	blockers?: string[]
	notes?: string
	submitted_at: number
}

export interface AgentOutcome {
	agent_id: string
	/** Raw runtime status kept for UI/backward debugging; use outcome for orchestration decisions. */
	status: AgentRecord["status"]
	/** Stable classified result for model/orchestrator recovery decisions. */
	outcome: AgentOutcomeKind
	reason?: AgentAbortReason | "error"
	resumable: boolean
	turns_used?: number
	max_turns?: number
	token_usage: LifetimeUsage
	/** Total agent lifetime in milliseconds (completedAt - startedAt), NOT per-resume duration. Per-attempt timing is tracked in AgentResumeAttempt. */
	duration_ms: number
	report?: AgentReport
	summary?: string
	recovery_guidance?: string
	task_ref?: AgentTaskRef
	resume_attempts: number
}

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
export const AGENT_BUILDER = "Builder"
export const AGENT_REVIEWER = "Reviewer"
export const AGENT_FIXER = "Fixer"

/** Names of the embedded default agents (in canonical display order). */
export const DEFAULT_AGENT_NAMES = [
	AGENT_GENERAL_PURPOSE,
	AGENT_EXPLORE,
	AGENT_PLAN,
	AGENT_RESEARCHER,
	AGENT_BUILDER,
	AGENT_REVIEWER,
	AGENT_FIXER,
] as const

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local"

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree"

/** Re-export orchestration types used in agent configs. */
export type { ModelRole, ModelTier }

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
	 * Optional model list for custom personas. Default personas do not set
	 * this — model selection is the orchestrator's responsibility. Custom
	 * personas loaded from .md files may still declare `models:` or `model:`
	 * in frontmatter for backward compatibility.
	 */
	models?: string[]
	thinking?: ThinkingLevel
	maxTurns?: number
	tokenBudget?: number
	/** Maximum wall-clock duration in seconds before the agent is aborted. */
	maxDuration?: number
	systemPrompt: string
	promptMode: "replace" | "append"
	/** Default for spawn: fork parent conversation. undefined = caller decides. */
	inheritContext?: boolean
	/** Default for spawn: run in background. undefined = caller decides. */
	runInBackground?: boolean
	/** Default for spawn: no extension tools. undefined = caller decides. */
	isolated?: boolean
	/** Whether to inject project context files (CLAUDE.md, AGENTS.md) into the system prompt. Default: false. */
	includeContextFiles?: boolean
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
	 * Task roles this persona is optimized for. Used by the orchestrator
	 * auto-pick logic when no model is explicitly specified and models[] is empty.
	 */
	roles?: ModelRole[]
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
	modelId?: string
	abortReason?: AgentAbortReason
	taskRef?: AgentTaskRef
	currentAttemptId: number
	agentReport?: AgentReport
	latestOutcome?: AgentOutcome
	resumeAttempts?: AgentResumeAttempt[]
	lastTurnCount?: number
	maxTurns?: number
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
	/** Whether this agent is (or has been converted to) a background agent. */
	isBackground?: boolean
	/** Resolver to call when this foreground agent is detached to background via Ctrl+B. */
	detachResolver?: () => void
	/** Removes the parent abort signal listener so the agent survives after detach. */
	detachFromParent?: () => void
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
