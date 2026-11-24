import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	type InlineExtension,
	type ModelRegistry as PiModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../../config.js"
import { isResourceEnabled } from "../../../resources/store.js"
import { requireModelRuntime } from "../../../shared/model-runtime.js"
import { getAvailableModels } from "../../../startup-context.js"
import { readEffectiveTelemetryConfig } from "../../../telemetry-policy.js"
import {
	enterAgentPersonaEnv,
	getRegisteredWorkerParentSession,
	registerWorkerParentSession,
	runAsAgentWorker,
	setAgentWorkerInactivityHold,
	setAgentWorkerParentSessionId,
} from "../../agent-worker-context.js"
import { isAutoRoutedModel } from "../../auto-model/constants.js"
import { createAutoModelRoutingExtension } from "../../auto-model/index.js"
import { getEffectiveModel } from "../../auto-model/state.js"
import { DAP_ENTRY_TOOL_NAMES, DAP_SESSION_TOOL_NAMES } from "../../dap/tools.js"
import dapExtension from "../../dap.js"
import { FERMENT_TOOL_NAMES } from "../../ferment/tool-names.js"
import infrastructureBreakerExtension from "../../infrastructure-breaker.js"
import codexCorrelationExtension from "../../login/codex-correlation-extension.js"
import { createKimchiMcpAdapterExtension } from "../../mcp/index.js"
import { buildRoleGuidelinesSection } from "../../orchestration/model-registry/guidelines/guidelines-resolver.js"
import { ModelRegistry } from "../../orchestration/model-registry/index.js"
import type { ModelRole } from "../../orchestration/model-registry/types.js"
import { loadProjectContextFiles } from "../../prompt-construction/context-files.js"
import { pinnedLanguageSection } from "../../prompt-construction/system-prompt.js"
import requestTimingExtension from "../../request-timing.js"
import type { SkillTriggerHit } from "../../skills-manager/skill-triggers.js"
import telemetryExtension from "../../telemetry/index.js"
import { COST_PER_PR_RESOURCE_ID } from "../../work-attribution/resource.js"
import {
	createWorkAttributionExtension,
	getWorkId,
	getWorkSegment,
	tryWorkAttribution,
	type WorkSegment,
} from "../../work-attribution.js"
import { detectEnv } from "../env.js"
import { createInteractiveTimeBudget, type InteractiveTimeBudgetRef } from "../interactive-time-budget.js"
import { BUILTIN_TOOL_NAMES, getAgentConfig, getConfig, getToolNamesForType } from "../personas/agent-types.js"
import { DEFAULT_AGENTS } from "../personas/default-agents.js"
import {
	AGENT_GENERAL_PURPOSE,
	type AgentAbortReason,
	type SubagentType,
	type ThinkingLevel,
} from "../personas/types.js"
import { renderBriefSkillBlock, scanBriefSkills } from "../prompt/brief-skill-loader.js"
import { buildParentContext, extractText } from "../prompt/context.js"
import { buildAgentPrompt, formatTokenBudget, type PromptExtras } from "../prompt/prompts.js"
import { preloadSkills } from "../prompt/skill-loader.js"
import { createSubagentBashClampExtension, subagentBashDefaultTimeoutExtension } from "../subagent-bash-clamp.js"
import { createWorkerReportExtension, WORKER_REPORT_TOOL_NAME, type WorkerReportCapability } from "../worker-report.js"
import { PARENT_SESSION_ID_ENV_KEY } from "./constants.js"
import { sanitizeToolName } from "./result-text.js"
import { SubagentResourceLoader } from "./subagent-resource-loader.js"
import { subagentWebToolFactories } from "./subagent-web-tools.js"
import { addUsage, getLifetimeTotal, getOutputTotal, getSessionUsage, type LifetimeUsage } from "./usage.js"

/**
 * Names of tools that subagents must NOT inherit from the parent session.
 *
 * - Agent / get_subagent_result / steer_subagent: subagents must not spawn
 *   further nested subagents (the orchestrator owns delegation).
 * - All ferment lifecycle and planning tools: subagents must not mutate
 *   ferment state. The discovery tool (list_ferments)
 *   are also excluded — they are only meaningful to the top-level planner.
 */
const EXCLUDED_TOOL_NAMES = ["Agent", "resume_subagent", "get_subagent_result", "steer_subagent", ...FERMENT_TOOL_NAMES]

const WORKER_PERMISSIONS_EXTENSION_NAME = "kimchi-worker-permissions"
const WORKER_PERMISSIONS_EXTENSION_PATH = `<inline:${WORKER_PERMISSIONS_EXTENSION_NAME}>`

/** Per-session clock references stay alive for the session's inline factories across resumes. */
const sessionTimeBudgets = new WeakMap<AgentSession, InteractiveTimeBudgetRef>()

/** The native skill-loading tool name, appendable to a subagent's tool list
 *  when its skills config entails it. Not part of BUILTIN_TOOL_NAMES (which
 *  mirrors upstream's builtin set). */
const SKILL_TOOL_NAME = "Skill"

function isExcludedSubagentToolName(name: string, disallowedSet?: Set<string>): boolean {
	return EXCLUDED_TOOL_NAMES.includes(name) || disallowedSet?.has(name) === true
}

function getPromptToolNames(toolNames: string[], disallowedSet?: Set<string>): string[] {
	return toolNames.filter((name) => !isExcludedSubagentToolName(name, disallowedSet))
}

/**
 * Compute the child session's active tool list from the persona's requested
 * tools, the session's registered/active tools, and the persona's extension
 * policy. Exported for tests: this filter is the gate that decides whether
 * extension-registered tools (e.g. MCP) survive onto a subagent session.
 */
export function getActiveSubagentToolNames(
	requestedToolNames: string[],
	currentActiveToolNames: string[],
	extensions: true | string[],
	isRegisteredToolName: (name: string) => boolean,
	disallowedSet?: Set<string>,
	onDroppedUnregistered?: (names: string[]) => void,
): string[] {
	const requestedToolNameSet = new Set(requestedToolNames)
	const allBuiltinToolNames = new Set(BUILTIN_TOOL_NAMES)
	const candidates = new Set([...requestedToolNames, ...currentActiveToolNames])

	if (onDroppedUnregistered) {
		const dropped = requestedToolNames.filter(
			(name) => !isExcludedSubagentToolName(name, disallowedSet) && !isRegisteredToolName(name),
		)
		if (dropped.length > 0) onDroppedUnregistered(dropped)
	}

	return [...candidates].filter((name) => {
		if (isExcludedSubagentToolName(name, disallowedSet)) return false
		if (!isRegisteredToolName(name)) return false
		if (requestedToolNameSet.has(name)) return true
		if (allBuiltinToolNames.has(name)) return false
		if (Array.isArray(extensions)) return extensions.some((ext) => name.startsWith(ext) || name.includes(ext))
		return true
	})
}

/**
 * Requested names that did not make it into the child session's final active
 * set, for any reason: unregistered, allowlist-filtered, resource-gated, or
 * runner-excluded. `disallowed_tools` — the author's express opt-out — and
 * runner-internal appends (SKILL_TOOL_NAME: appended for prompt
 * documentation; no child session has ever registered a tool by that name,
 * skills load via the brief preload blocks) are the only legitimate silences.
 */
export function computeDroppedToolNames(
	requestedToolNames: string[],
	activeToolNames: string[],
	disallowedSet?: Set<string>,
): string[] {
	const activeSet = new Set(activeToolNames)
	return [
		...new Set(
			requestedToolNames.filter(
				(name) => name !== SKILL_TOOL_NAME && !disallowedSet?.has(name) && !activeSet.has(name),
			),
		),
	]
}

import { markOrchestratorSteer } from "../../steer-marker.js"

/** Send a steering message that is clearly marked as coming from the orchestrator, not the user. */
async function steerAsOrchestrator(session: AgentSession, message: string): Promise<void> {
	// upstream pi: steer() resolves to a QueuedInputDisposition we don't need here.
	await session.steer(markOrchestratorSteer(message))
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined = 30

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
	if (n == null || n === 0) return undefined
	return Math.max(1, n)
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined {
	return defaultMaxTurns
}
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void {
	defaultMaxTurns = normalizeMaxTurns(n)
}

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5

const INACTIVITY_CHECK_INTERVAL = 10_000
const DEFAULT_INACTIVITY_TIMEOUT = 120_000
/** Default wall-clock timeout for subagents (seconds). Prevents hangs on blocking operations. */
const DEFAULT_MAX_DURATION = 900
/**
 * Floor enforced on any non-null per-attempt token budget. Prevents a caller
 * from passing a sub-thousand budget that the runner would silently raise to
 * this value, masking a cumulative-budget overshoot. Shared with the manager,
 * which refuses to resume a Ferment worker whose remaining cumulative budget
 * falls below this floor.
 */
export const MIN_TOKEN_BUDGET = 1024

/**
 * Lower floor for report-finalization resumes. `finalize_report` is a bounded
 * operation (maxTurns: 2, maxDuration: 30) that only emits a structured
 * `submit_agent_report` payload — it needs a few hundred tokens, not a full
 * thousand. Using the continuation floor here would block workers that are
 * near-exhaustion but still capable of producing their report, leaving the
 * orchestrator unable to complete the step (no structured report →
 * `complete_ferment_step` hard-rejects). The overshoot is bounded to ≤ this
 * value against the cumulative budget.
 */
export const MIN_FINALIZE_TOKEN_BUDGET = 256

/** Get the grace turns value. */
export function getGraceTurns(): number {
	return graceTurns
}
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void {
	graceTurns = Math.max(1, n)
}

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.models[0] > parent model.
 */
function resolveDefaultModel(
	parentModel: Model<Api> | undefined,
	registry: Pick<PiModelRegistry, "find" | "getAvailable">,
	configModel?: string,
): Model<Api> | undefined {
	if (configModel) {
		const slashIdx = configModel.indexOf("/")
		if (slashIdx !== -1) {
			const provider = configModel.slice(0, slashIdx)
			const modelId = configModel.slice(slashIdx + 1)

			const availableKeys = new Set(registry.getAvailable().map((model) => `${model.provider}/${model.id}`))
			const isAvailable = (p: string, id: string) => availableKeys.has(`${p}/${id}`)

			const found = registry.find(provider, modelId)
			if (found && isAvailable(provider, modelId)) return found
		}
	}

	return parentModel
}

let cachedGuidelinesRegistry: ModelRegistry | undefined

function getGuidelinesRegistry(): ModelRegistry {
	cachedGuidelinesRegistry ??= new ModelRegistry(getAvailableModels())
	return cachedGuidelinesRegistry
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
	toolName: string
	toolCallId?: string
	/** ACP tool-call status — "in_progress" = start, "completed"/"failed" = end. */
	status: "pending" | "in_progress" | "completed" | "failed"
	/** Human-readable title describing the call (ACP title). */
	title?: string
	/** Tool arguments (ACP rawInput) — present on in_progress notifications. */
	rawInput?: unknown
	/** Structured tool result (ACP rawOutput — the pi AgentToolResult). */
	rawOutput?: unknown
}

/**
 * Inactivity accounting mode.
 *
 * - "any_event" (default): any session event (model or tool) counts as activity.
 * - "model_only": time spent inside a running tool is not inactivity — a
 *   silent long-running tool call must not steer or abort the agent, while
 *   genuine model inactivity (no events and no running tool) still does.
 */
export type InactivityMode = "any_event" | "model_only"

export interface RunOptions {
	/** ExtensionAPI instance — used for pi.exec() instead of execSync. */
	pi: ExtensionAPI
	model?: Model<Api>
	maxTurns?: number
	signal?: AbortSignal
	isolated?: boolean
	inheritContext?: boolean
	thinkingLevel?: ThinkingLevel
	/** Override working directory (e.g. for worktree isolation). */
	cwd?: string
	/** Persist this agent run to a pre-created session file. Omit for in-memory sessions. */
	sessionFile?: string
	/** Directory that owns sessionFile; used for later /new or branch operations. */
	sessionDir?: string
	/** Called on tool start/end with activity info. */
	onToolActivity?: (activity: ToolActivity) => void
	/** Called on streaming text deltas from the assistant response. */
	onTextDelta?: (delta: string, fullText: string) => void
	onSessionCreated?: (session: AgentSession) => void
	/** ID of this run as the manager tracks it — passed to the worker permission role. */
	agentId?: string
	/** Task description shown in escalated permission prompts. */
	description?: string
	/** Called at the end of each agentic turn with the cumulative count. */
	onTurnEnd?: (turnCount: number) => void
	/** Called once per assistant message_end with that message's usage delta. */
	onAssistantUsage?: (usage: LifetimeUsage) => void
	/** Called when the session successfully compacts. */
	onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void
	/** Maximum cumulative output tokens this agent is allowed to generate. Overrides agentConfig.tokenBudget. */
	tokenBudget?: number
	/** Inactivity timeout in milliseconds. After this period of no session events, the agent is steered; after another period, aborted. */
	inactivityTimeout?: number
	/** Maximum wall-clock duration in seconds. The agent is aborted when this limit is exceeded. */
	maxDuration?: number
	/** Host-bound report capability. Present only for Ferment-linked workers. */
	workerReport?: WorkerReportCapability
	/** Ends the session once the named tool completes and this returns true (an accepted terminal report). */
	shouldTerminateAfterTool?: (toolName: string) => boolean
	/** Enforce maxTurns as a hard cap instead of allowing ordinary-agent grace turns. */
	hardTurnLimit?: boolean
	/** Registers a hard-fallback cleanup for runner-owned resources. */
	onRuntimeCleanupRegistered?: (cleanup: () => void) => void
	/** Called with the built system prompt before the session starts. */
	onSystemPrompt?: (prompt: string) => void
	/** Inline extensions appended to the child session's loader. They load even when extensions are disabled. */
	extensionFactories?: readonly InlineExtension[]
	/** How inactivity is accounted. "model_only" keeps a running tool from counting as inactivity. */
	inactivityMode?: InactivityMode
}

export interface RunResult {
	responseText: string
	session: AgentSession
	/** True if the agent was hard-aborted by max turns or token budget. */
	aborted: boolean
	abortReason?: AgentAbortReason
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered: boolean
	turnsUsed?: number
	maxTurns?: number
	/** Absolute path to the saved plan file, if the agent produced a plan. */
	planPath?: string
	/** Skills auto-loaded into the system prompt because the task brief
	 *  matched their declared triggers. */
	autoLoadedSkills?: SkillTriggerHit[]
	/** Requested tool names dropped because the subagent session had no
	 *  registration for them (e.g. a `tools:` list naming a tool no extension
	 *  registered). Surfaced as a warning on the Agent tool's result text. */
	droppedToolNames?: string[]
}

function collectResponseText(session: AgentSession) {
	let text = ""
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start") {
			text = ""
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			text += event.assistantMessageEvent.delta
		}
	})
	return { getText: () => text, unsubscribe }
}

/**
 * Find the worker session's submit_plan tool result and return the saved plan
 * path from the structured `details` payload (`{ submitted: true, planPath }`).
 * pi-mono preserves `details` on stored tool-result messages, so this is the
 * sole extraction path.
 */
function extractSubmitPlanPath(session: AgentSession): string | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const msg = session.messages[i]
		if (msg.role !== "toolResult" || msg.toolName !== "submit_plan") continue
		const details = msg.details as { submitted?: boolean; planPath?: unknown } | undefined
		if (details?.submitted === true && typeof details.planPath === "string" && details.planPath) {
			return details.planPath
		}
	}
	return undefined
}

function getLastAssistantText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const msg = session.messages[i]
		if (msg.role !== "assistant") continue
		const text = extractText(msg.content).trim()
		if (text) return text
	}
	return ""
}

function usageDelta(total: LifetimeUsage | undefined, observed: LifetimeUsage): LifetimeUsage | undefined {
	if (!total) return undefined
	const delta = {
		input: Math.max(0, total.input - observed.input),
		output: Math.max(0, total.output - observed.output),
		cacheRead: Math.max(0, total.cacheRead - observed.cacheRead),
		cacheWrite: Math.max(0, total.cacheWrite - observed.cacheWrite),
	}
	return getLifetimeTotal(delta) > 0 ? delta : undefined
}

function resetUsage(usage: LifetimeUsage): void {
	usage.input = 0
	usage.output = 0
	usage.cacheRead = 0
	usage.cacheWrite = 0
}

/**
 * Hard-abort the session: kill any in-flight bash process tree, then abort the agent loop.
 * session.abort() alone does NOT kill in-flight bash (upstream gap), so we call abortBash()
 * to trigger killProcessTree on the bash subprocess. Uses optional chaining so test mocks
 * without abortBash don't break.
 */
function hardAbort(session: AgentSession): void {
	session.abortBash?.()
	session.abort()
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
	if (!signal) return () => {}
	const onAbort = () => hardAbort(session)
	signal.addEventListener("abort", onAbort, { once: true })
	return () => signal.removeEventListener("abort", onAbort)
}

/**
 * Inactivity accounting for one agent run. "any_event" (default) treats every
 * session event as activity. "model_only" additionally suspends the watchdog
 * while a tool is executing and re-arms it when the tool finishes, so a silent
 * long-running tool call is never mistaken for a stalled model — while genuine
 * model inactivity (no events, no running tool) still steers and then aborts.
 */
interface InactivityTracker {
	/** Milliseconds since the last activity that counts for this mode. */
	elapsedMs(): number
	/** True while a tool is executing in "model_only" mode (watchdog suspended). */
	suspended(): boolean
	/** Whether a steer has already been sent and not been answered by activity. */
	steered: boolean
	/** Record a steer was sent. */
	markSteered(): void
	/** Track one session event. */
	track(event: AgentSessionEvent): void
	/** An interactive wait ended: restart the clock and clear a pending steer. */
	touch(): void
}

function createInactivityTracker(mode: InactivityMode | undefined): InactivityTracker {
	const modelOnly = mode === "model_only"
	const state = { lastActivityAt: Date.now(), runningTools: 0, steered: false }
	return {
		get steered() {
			return state.steered
		},
		set steered(value: boolean) {
			state.steered = value
		},
		elapsedMs: () => Date.now() - state.lastActivityAt,
		suspended: () => modelOnly && state.runningTools > 0,
		markSteered: () => {
			state.steered = true
		},
		track(event: AgentSessionEvent) {
			if (modelOnly && (event.type === "tool_execution_start" || event.type === "tool_execution_end")) {
				if (event.type === "tool_execution_start") {
					state.runningTools++
				} else {
					state.runningTools = Math.max(0, state.runningTools - 1)
					// The model resumes control when the tool finishes — re-arm from now.
					state.lastActivityAt = Date.now()
					state.steered = false
				}
				return
			}
			state.lastActivityAt = Date.now()
			state.steered = false
		},
		touch() {
			state.lastActivityAt = Date.now()
			state.steered = false
		},
	}
}

async function withParentSessionEnv<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T> {
	const prevParentSessionId = process.env[PARENT_SESSION_ID_ENV_KEY]
	process.env[PARENT_SESSION_ID_ENV_KEY] = ctx.sessionManager.getSessionId()

	try {
		return await fn()
	} finally {
		if (prevParentSessionId === undefined) {
			delete process.env[PARENT_SESSION_ID_ENV_KEY]
		} else {
			process.env[PARENT_SESSION_ID_ENV_KEY] = prevParentSessionId
		}
	}
}

export async function runAgent(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
): Promise<RunResult> {
	// Per-run watchdog holds ride the async context, not process.env: parallel
	// runs share the env, so anything a child reads from it can belong to a sibling.
	return runAsAgentWorker(() => withParentSessionEnv(ctx, () => runAgentInner(ctx, type, prompt, options)), {
		parentSessionId: ctx.sessionManager.getSessionId(),
	})
}

async function runAgentInner(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
): Promise<RunResult> {
	const inheritedWorkId = tryWorkAttribution(() => getWorkId(ctx))
	const inheritedSegment = getWorkSegment(ctx)
	const config = getConfig(type)
	const agentConfig = getAgentConfig(type)

	// Fail closed at the runner boundary too: a caller that bypasses the Agent
	// tool's execute() validation (internal spawn points, get_subagent_result
	// resume flows) must never run a persona with no permission profile — that
	// would silently burn tokens on a tool-less dead run (issue #1678).
	if (type !== "Remote-Runner" && (!agentConfig || agentConfig.enabled === false)) {
		throw new Error(`Refusing to run unknown or disabled agent type "${type}".`)
	}

	const effectiveCwd = options.cwd ?? ctx.cwd

	const env = await detectEnv(options.pi, effectiveCwd)

	const parentSystemPrompt = ctx.getSystemPrompt()

	const extensions = options.isolated ? false : config.extensions
	const effectiveExtensions = options.workerReport && extensions === false ? [] : extensions
	const skills = options.isolated ? false : config.skills

	const pinnedLanguage = loadConfig({ cwd: effectiveCwd }).language
	const extras: PromptExtras = {
		contextFiles:
			agentConfig?.includeContextFiles && !options.isolated ? loadProjectContextFiles(effectiveCwd) : undefined,
		// "replace"-mode agents do not inherit the parent prompt, so the pinned
		// language rule has to be carried explicitly; "append" mode inherits it.
		languageBlock: pinnedLanguage === undefined ? undefined : pinnedLanguageSection(pinnedLanguage),
	}

	let toolNames = getToolNamesForType(type)

	// Skills preloaded because the task brief matched their declared
	// triggers; surfaced in the run result for the tool-result note.
	let autoLoadedSkills: SkillTriggerHit[] | undefined

	if (Array.isArray(skills)) {
		const loaded = preloadSkills(skills, effectiveCwd)
		if (loaded.length > 0) {
			extras.skillBlocks = loaded
		}
	} else if (skills === true) {
		// skills === true (the default for Builder, Fixer, Explore, Plan, GP):
		// one scan per spawn feeds both the Available Skills list and the
		// trigger-matched preloads (subagent skill auto-load — see
		// docs/skills-autoload.md). The Skill tool is added so sub-agents can
		// also load skills on demand.
		const scan = await scanBriefSkills(prompt, effectiveCwd, {
			// inherit_context forks the parent conversation, which already
			// carries the parent's loaded skills — don't match the brief again.
			matchBrief: !options.inheritContext,
		})
		if (scan.matched.length > 0) {
			extras.skillBlocks = scan.matched.map((m) => ({ name: m.name, content: renderBriefSkillBlock(m) }))
			autoLoadedSkills = scan.matched.map(({ name, matched }) => ({ name, matched }))
		}
		if (scan.available.length > 0) {
			const skillLines = scan.available.map((s) => `- **${s.name}**: ${s.description}`).join("\n")
			extras.skillListBlock = `## Available Skills

Use the Skill tool to load a skill's full instructions when its description matches your task.

${skillLines}`
			// Add the Skill tool to the available tools (unless disallowed by persona config)
			const disallowed = agentConfig?.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined
			if (!toolNames.includes(SKILL_TOOL_NAME) && !disallowed?.has(SKILL_TOOL_NAME)) {
				toolNames = [...toolNames, SKILL_TOOL_NAME]
			}
		}
	}

	const disallowedSet = agentConfig?.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined

	const guidelineRole = agentConfig?.roles?.[0] as ModelRole | undefined

	const effectiveMaxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns)
	const MIN_TOKEN_BUDGET = 1024
	const rawTokenBudget = options.tokenBudget ?? agentConfig?.tokenBudget
	const effectiveTokenBudget = rawTokenBudget != null ? Math.max(rawTokenBudget, MIN_TOKEN_BUDGET) : undefined
	// Wall-clock budget (max_duration), resolved here so both the prompt's
	// budget block and the bash clamp extension below see the same value.
	// Computed before extras.budget so the agent is told its time limit up
	// front — without it, a time-based clamp firing later is unexplainable
	// to the agent (see subagent-bash-clamp.ts).
	const effectiveMaxDuration = options.maxDuration ?? agentConfig?.maxDuration ?? DEFAULT_MAX_DURATION
	const timeBudget = { budget: createInteractiveTimeBudget(effectiveMaxDuration, Date.now()) }
	if (effectiveMaxTurns != null || effectiveTokenBudget != null || effectiveMaxDuration > 0) {
		extras.budget = {
			maxTurns: effectiveMaxTurns,
			tokenBudget: effectiveTokenBudget,
			// 0 means unlimited — no time limit to communicate.
			...(effectiveMaxDuration > 0 ? { maxDurationSeconds: effectiveMaxDuration } : {}),
		}
	}

	const model = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.models?.[0])

	const buildSystemPrompt = (activeToolNames: string[], promptModelId = model?.id) => {
		extras.activeToolNames = activeToolNames
		const guidelinesBlock = buildRoleGuidelinesSection(promptModelId, guidelineRole, getGuidelinesRegistry())
		extras.guidelinesBlock = guidelinesBlock
		if (agentConfig) return buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras)
		const fallback = DEFAULT_AGENTS.get(AGENT_GENERAL_PURPOSE)
		if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`)
		return buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras)
	}

	let systemPrompt = buildSystemPrompt(getPromptToolNames(toolNames, disallowedSet))
	options.onSystemPrompt?.(systemPrompt)

	const debugSession = process.env.KIMCHI_DEBUG_SESSION
	const debugPromptName = `agent-${agentConfig?.name ?? type}-${Date.now()}.md`
	const captureDebugPrompt = (prompt: string) => {
		if (!debugSession) return
		try {
			const debugDir = join(effectiveCwd, ".kimchi", "debug", debugSession)
			mkdirSync(debugDir, { recursive: true })
			writeFileSync(join(debugDir, debugPromptName), prompt)
		} catch {
			// Best-effort debug logging; never change the agent's behavior.
		}
	}

	const noSkills = skills === false || Array.isArray(skills)

	const agentDir = getAgentDir()

	// Construct the gate before the resource loader: a failed import or
	// initialization must prevent the child from running unchecked.
	// The import is dynamic on purpose: a static one closes a cycle
	// (permissions/index -> remote-run/runner -> agents/index -> this file).
	const parentSessionId = ctx.sessionManager.getSessionId()
	const { createWorkerPermissionsExtension, getPermissionsExtensionOptions } = await import(
		"../../permissions/index.js"
	)
	// A host that tunes the gate (the Ferment V2 verifier's pre-approvals)
	// passes a createPermissionsExtension() factory with its inline
	// extensions. The child keeps one gate: those options are folded into the
	// worker gate and the host's factory is not loaded. Such a host-run child
	// also keeps failing closed instead of asking the user in the main session.
	const callerExtensions = options.extensionFactories ?? []
	const callerGates = callerExtensions.filter((extension) => getPermissionsExtensionOptions(extension) !== undefined)
	if (callerGates.length > 1) {
		throw new Error("A subagent accepts at most one permission gate from its host.")
	}
	const hostGateOptions = callerGates[0] ? getPermissionsExtensionOptions(callerGates[0]) : undefined
	const workerPermissionsExtension = createWorkerPermissionsExtension({
		...(hostGateOptions?.preApproved ? { preApproved: hostGateOptions.preApproved } : {}),
		...(hostGateOptions ? { askParent: false } : {}),
		parentSessionId,
		persona: agentConfig?.name ?? type,
		agentId: options.agentId,
		description: options.description ?? prompt.slice(0, 200),
	})
	const extensionFactories = buildInlineExtensionFactories({
		effectiveMaxDuration,
		timeBudget,
		type,
		parentSessionId,
		workerPermissionsExtension,
		model,
		toolNames,
		workerReport: options.workerReport,
		costPerPrEnabled: isResourceEnabled(COST_PER_PR_RESOURCE_ID),
		mcpAppsEnabled: isResourceEnabled("plugins.mcp-apps"),
		inheritedWorkId,
		inheritedSegment,
		effectiveExtensions,
		effectiveCwd,
		buildSystemPrompt,
		onSystemPrompt: options.onSystemPrompt,
	})

	// Web tools only exist for extension-enabled sessions: with extensions
	// disabled the session is contractually hermetic, so don't register the
	// factories at all (off means off — registration included).
	if (effectiveExtensions !== false) {
		extensionFactories.push(...subagentWebToolFactories())
	}
	// Caller-provided inline extensions (e.g. the Ferment V2 verifier guard)
	// load even when extensions are disabled — the resource loader always
	// processes its inline factories. A caller's permission gate is left out:
	// its options already went into the worker gate above.
	extensionFactories.push(...callerExtensions.filter((extension) => !callerGates.includes(extension)))
	// SubagentResourceLoader reads the system prompt live via the
	// readSystemPrompt callback (see subagent-resource-loader.ts): after the
	// final active-tool list is known, reassigning `systemPrompt` and calling
	// session.setActiveToolsByName() is enough for the session to rebuild its
	// prompt options from the current value — NO second loader.reload(). That
	// second reload used to exist only to re-evaluate systemPromptOverride, and
	// it re-ran every inline extension factory against the loader's shared
	// event bus, leaving orphaned duplicate copies whose bus subscriptions
	// duplicated channel events (e.g. 2× subagent.bash_clamped telemetry).
	const loader = new SubagentResourceLoader({
		cwd: effectiveCwd,
		agentDir,
		noExtensions: effectiveExtensions === false,
		noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		readSystemPrompt: () => systemPrompt,
		appendSystemPromptOverride: () => [],
		extensionFactories,
	})
	await loader.reload()
	const workerGateLoadError = loader
		.getExtensions()
		.errors.find(({ path }) => path === WORKER_PERMISSIONS_EXTENSION_PATH)
	if (workerGateLoadError) {
		throw new Error(`${WORKER_PERMISSIONS_EXTENSION_PATH}: ${workerGateLoadError.error}`)
	}

	const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking

	const settingsManager = SettingsManager.create(effectiveCwd, agentDir)
	const modelRuntime = requireModelRuntime(ctx.modelRegistry)

	const sessionOpts: CreateAgentSessionOptions = {
		cwd: effectiveCwd,
		agentDir,
		sessionManager: options.sessionFile
			? SessionManager.open(options.sessionFile, options.sessionDir, effectiveCwd)
			: SessionManager.inMemory(effectiveCwd),
		settingsManager,
		model,
		resourceLoader: loader,
		modelRuntime,
	}
	if (effectiveExtensions === false) {
		if (agentConfig?.source != null) {
			// Fail fast for CUSTOM agents (source set by the user-agent loader):
			// with extensions disabled, declared tools are honored only if the
			// child session can actually register them — the upstream builtin
			// set, the native Skill tool, or the DAP debugger's inline
			// registration. Web tools intentionally do NOT qualify: an agent
			// that wants web tools must enable extensions — fail fast with
			// guidance instead of silently honoring or silently dropping.
			// Built-in personas (no `source`) are untouched by this check, and
			// disallowed_tools wins over everything — an agent that opted a
			// name out is not failing to register it.
			const dapRegistrable = shouldRegisterDapForTools(toolNames)
			const unregistrableTools = toolNames.filter((name) => {
				if (disallowedSet?.has(name)) return false
				if (BUILTIN_TOOL_NAMES.includes(name) || name === SKILL_TOOL_NAME) return false
				if (dapRegistrable && isDapToolName(name)) return false
				return true
			})
			if (unregistrableTools.length > 0) {
				// Two distinct classes with different honest remedies:
				//   1. provisionable names — enabling extensions would fix them
				//      (DAP-only failures have yet another remedy: the debugger
				//      registers inline but its resource is disabled);
				//   2. always-excluded names (Agent, resume_subagent, ferment tools)
				//      — subagents NEVER receive these, regardless of the extensions
				//      flag, so "enable extensions" would be a dead-end remedy.
				const provisionable = unregistrableTools.filter((name) => !isExcludedSubagentToolName(name))
				const neverReceived = unregistrableTools.filter((name) => isExcludedSubagentToolName(name))
				const clauses: string[] = []
				if (provisionable.length > 0) {
					const remedy = provisionable.every(isDapToolName)
						? `enable the "extensions.dap" resource in settings, enable extensions for this agent, or`
						: "enable extensions for this agent, or"
					clauses.push(
						`${provisionable.map((n) => `"${sanitizeToolName(n)}"`).join(", ")} — ${remedy} remove these names from its 'tools:' list`,
					)
				}
				if (neverReceived.length > 0) {
					clauses.push(
						`${neverReceived.map((n) => `"${sanitizeToolName(n)}"`).join(", ")} — subagents never receive these tools, remove them from its 'tools:' list`,
					)
				}
				throw new Error(`Agent "${type}" declares non-builtin tool(s) but disables extensions — ${clauses.join("; ")}.`)
			}
		}
		sessionOpts.tools = toolNames
	}
	if (thinkingLevel) {
		sessionOpts.thinkingLevel = thinkingLevel
	}

	const { session } = await createAgentSession(sessionOpts)
	registerWorkerParentSession(session, parentSessionId)
	sessionTimeBudgets.set(session, timeBudget)

	await session.bindExtensions({
		onError: (err) => {
			options.onToolActivity?.({
				status: "completed",
				toolName: `extension-error:${err.extensionPath}`,
			})
		},
	})

	// Requested-but-unregistered tool names (e.g. a `tools:` list naming a tool
	// no extension registered in the child session) — filled during tool
	// resolution below, surfaced as a warning on the run result.
	let droppedToolNames: string[] | undefined

	if (effectiveExtensions !== false) {
		const activeTools = getActiveSubagentToolNames(
			toolNames,
			session.getActiveToolNames(),
			effectiveExtensions,
			(name) => session.getToolDefinition(name) !== undefined,
			disallowedSet,
		)
		const dropped = computeDroppedToolNames(toolNames, activeTools, disallowedSet)
		if (dropped.length > 0) droppedToolNames = dropped
		// upstream pi: only ACTIVE tools are callable (registered-but-inactive now
		// fails tool lookup at execution time). The report tool registers for a
		// ferment-linked worker but the extension-prefix filter above drops it
		// because workerReport makes effectiveExtensions an empty list — keep it
		// active explicitly so the worker can submit its report.
		if (
			options.workerReport &&
			!activeTools.includes(WORKER_REPORT_TOOL_NAME) &&
			session.getToolDefinition(WORKER_REPORT_TOOL_NAME)
		) {
			activeTools.push(WORKER_REPORT_TOOL_NAME)
		}
		systemPrompt = buildSystemPrompt(activeTools)
		// No loader.reload() here: SubagentResourceLoader reads the prompt live
		// on every getSystemPrompt() call, so reassigning `systemPrompt` above
		// is all setActiveToolsByName needs to rebuild the session's prompt
		// options from the final tool list.
		session.setActiveToolsByName(activeTools)
	} else {
		const activeTools = session.getActiveToolNames().filter((t) => !disallowedSet?.has(t))
		systemPrompt = buildSystemPrompt(activeTools)
		session.setActiveToolsByName(activeTools)
	}

	// Capture after extension binding determines the actual active tools.
	captureDebugPrompt(systemPrompt)
	options.onSessionCreated?.(session)

	let turnCount = 0
	let cumulativeTokens = 0
	const observedUsage: LifetimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	const windowObservedUsage: LifetimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	let softLimitReached = false
	let aborted = false
	let abortReason: AgentAbortReason | undefined
	let budgetAborted = false
	let reportAccepted = false

	const inactivity = createInactivityTracker(options.inactivityMode)
	const inactivityTimeout = options.inactivityTimeout ?? DEFAULT_INACTIVITY_TIMEOUT
	// Interactive waits (a permission prompt escalated to the parent) emit no
	// session events, so the watchdog would steer then abort a worker that is
	// legitimately waiting for a human. The gate takes this hold for the wait.
	const inactivityHolds = { count: 0 }
	setAgentWorkerInactivityHold({
		acquire: () => {
			const releaseTimeBudget = timeBudget.budget.pause()
			inactivityHolds.count += 1
			let released = false
			return () => {
				if (released) return
				released = true
				inactivityHolds.count -= 1
				releaseTimeBudget()
				// The wait was the activity: restart the clock, clear a pending steer.
				inactivity.touch()
			}
		},
	})

	const PROGRESS_STEER_POINTS: { threshold: number; message: string }[] = [
		{
			threshold: 0.5,
			message:
				"You're at 50% of your turn budget. Pause briefly to evaluate your progress and confirm you're still on the right path. Adjust course if needed.",
		},
		{
			threshold: 0.75,
			message:
				"You're at 75% of your turn budget. Finish your current edit, run verification, and summarize any remaining work.",
		},
		{
			threshold: 0.9,
			message:
				"You're at 90% of your turn budget. Finish your current edit, run verification, and summarize any remaining work.",
		},
	]
	let nextProgressIdx = 0
	let tokenSoftLimitSteered = false

	function buildProgressSummary(): string {
		const parts: string[] = []
		if (effectiveMaxTurns != null) parts.push(`Turn ${turnCount}/${effectiveMaxTurns}`)
		if (effectiveTokenBudget != null) {
			parts.push(
				`~${formatTokenBudget(cumulativeTokens)}/${formatTokenBudget(effectiveTokenBudget)} output tokens used`,
			)
		}
		return parts.join(", ")
	}

	let currentMessageText = ""
	const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
		inactivity.track(event)

		if (event.type === "turn_end") {
			turnCount++
			options.onTurnEnd?.(turnCount)
			if (!reportAccepted && effectiveMaxTurns != null) {
				if (options.hardTurnLimit && turnCount >= effectiveMaxTurns) {
					aborted = true
					abortReason = "max_turns"
					hardAbort(session)
				} else if (!softLimitReached && turnCount >= effectiveMaxTurns) {
					softLimitReached = true
					steerAsOrchestrator(
						session,
						"You have reached your turn limit. Stop exploring. Complete your current edit, ensure file syntax is valid, undo any git state mutations so your work is visible on the filesystem, and summarize progress for the orchestrator. Do not start new edits.",
					)
				} else if (softLimitReached && turnCount >= effectiveMaxTurns + graceTurns) {
					aborted = true
					abortReason = "max_turns"
					hardAbort(session)
				} else if (!softLimitReached && nextProgressIdx < PROGRESS_STEER_POINTS.length) {
					const point = PROGRESS_STEER_POINTS[nextProgressIdx]
					if (point && turnCount >= effectiveMaxTurns * point.threshold) {
						nextProgressIdx++
						steerAsOrchestrator(session, point.message)
					}
				}
			}
		}
		if (event.type === "message_start") {
			currentMessageText = ""
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			currentMessageText += event.assistantMessageEvent.delta
			options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText)
		}
		if (event.type === "tool_execution_start") {
			if (budgetAborted) {
				// R2: token_budget was exceeded on a previous message_end. Re-abort
				// to ensure the agent loop halts and this tool call is skipped.
				hardAbort(session)
			} else {
				options.onToolActivity?.({ status: "in_progress", toolName: event.toolName })
			}
		}
		if (event.type === "tool_execution_end") {
			options.onToolActivity?.({ status: "completed", toolName: event.toolName })
			if (
				(event.toolName === WORKER_REPORT_TOOL_NAME && options.workerReport?.isAccepted()) ||
				options.shouldTerminateAfterTool?.(event.toolName)
			) {
				reportAccepted = true
				queueMicrotask(() => hardAbort(session))
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = (
				event.message as unknown as {
					usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
				}
			).usage
			if (u) {
				const usage = {
					input: u.input ?? 0,
					output: u.output ?? 0,
					cacheRead: u.cacheRead ?? 0,
					cacheWrite: u.cacheWrite ?? 0,
				}
				addUsage(observedUsage, usage)
				addUsage(windowObservedUsage, usage)
				options.onAssistantUsage?.(usage)
				if (!reportAccepted && effectiveTokenBudget != null && !budgetAborted) {
					cumulativeTokens += getOutputTotal(usage)
					if (cumulativeTokens > effectiveTokenBudget) {
						budgetAborted = true
						abortReason = "token_budget"
						console.warn(
							`[agent-runner] token budget exceeded (cumulative=${cumulativeTokens}, budget=${effectiveTokenBudget}); aborting`,
						)
						hardAbort(session)
					} else if (!tokenSoftLimitSteered && cumulativeTokens >= effectiveTokenBudget * 0.8) {
						tokenSoftLimitSteered = true
						steerAsOrchestrator(
							session,
							`Budget check: ${buildProgressSummary()}. You are approaching your output token limit. Wrap up your current work and summarize any remaining tasks.`,
						)
					}
				}
			}
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			resetUsage(windowObservedUsage)
			options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore })
		}
	})

	let inactivityInterval: ReturnType<typeof setInterval> | undefined = setInterval(() => {
		if (inactivity.suspended()) return
		if (inactivityHolds.count > 0) return // interactive wait (e.g. escalated permission prompt)
		const elapsed = inactivity.elapsedMs()
		if (inactivity.steered && elapsed >= inactivityTimeout) {
			aborted = true
			abortReason = "inactivity"
			hardAbort(session)
		} else if (!inactivity.steered && elapsed >= inactivityTimeout) {
			inactivity.markSteered()
			steerAsOrchestrator(session, "You appear to be stalled. Resume work immediately or summarize your progress.")
		}
	}, INACTIVITY_CHECK_INTERVAL)
	const cleanupInactivityInterval = () => {
		if (!inactivityInterval) return
		clearInterval(inactivityInterval)
		inactivityInterval = undefined
	}
	options.onRuntimeCleanupRegistered?.(cleanupInactivityInterval)

	// The worker's clock starts here. The budget object was created earlier
	// because the prompt and the bash clamp need a reference to it, but
	// building the loader and the session takes time that must not be charged
	// to max_duration. No tool call has run yet, so nothing holds the old one.
	timeBudget.budget.dispose()
	timeBudget.budget = createInteractiveTimeBudget(effectiveMaxDuration, Date.now())
	timeBudget.budget.setOnExpire(() => {
		aborted = true
		abortReason = "max_duration"
		hardAbort(session)
	})

	const collector = collectResponseText(session)
	const cleanupAbort = forwardAbortSignal(session, options.signal)

	let effectivePrompt = prompt
	if (options.inheritContext) {
		const parentContext = buildParentContext(ctx)
		if (parentContext) {
			effectivePrompt = parentContext + prompt
		}
	}

	// The commands and hooks this run starts read its persona from the
	// environment. The child's own gate gets it as an argument, and the
	// session that started the run keeps the persona it was launched with.
	const leavePersonaEnv = agentConfig?.name ? enterAgentPersonaEnv(agentConfig.name) : undefined

	try {
		await session.prompt(effectivePrompt)
	} finally {
		cleanupInactivityInterval()
		timeBudget.budget.dispose()
		unsubTurns()
		collector.unsubscribe()
		cleanupAbort()
		// Emit session_shutdown so extensions (e.g. telemetry) can flush and
		// clear timers. Mirrors the ACP server pattern in modes/acp/server.ts.
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
		leavePersonaEnv?.()
	}

	const finalUsageDelta = usageDelta(getSessionUsage(session), windowObservedUsage)
	if (finalUsageDelta) {
		addUsage(observedUsage, finalUsageDelta)
		addUsage(windowObservedUsage, finalUsageDelta)
		cumulativeTokens += getOutputTotal(finalUsageDelta)
		options.onAssistantUsage?.(finalUsageDelta)
	}

	if (
		!reportAccepted &&
		effectiveTokenBudget != null &&
		!budgetAborted &&
		getOutputTotal(observedUsage) > effectiveTokenBudget
	) {
		budgetAborted = true
		abortReason = "token_budget"
	}

	const responseText = collector.getText().trim() || getLastAssistantText(session)

	// A Plan agent completes by calling the submit_plan tool, which saves the
	// plan itself (see permissions/index.ts) and terminates the turn. Extract
	// the saved path from the tool result so the parent orchestrator can
	// surface it. Stays undefined for non-Plan agents and when no submit_plan
	// call happened.
	let planPath: string | undefined
	if (type === "Plan") {
		planPath = extractSubmitPlanPath(session)
	}

	return {
		responseText,
		session,
		aborted: reportAccepted ? false : aborted || budgetAborted,
		abortReason: reportAccepted ? undefined : abortReason,
		steered: softLimitReached,
		turnsUsed: turnCount,
		maxTurns: effectiveMaxTurns,
		planPath,
		autoLoadedSkills,
		droppedToolNames,
	}
}

/** Inputs for {@link buildInlineExtensionFactories}. */
export interface InlineExtensionFactoryDeps {
	/** Resolved wall-clock budget in seconds; 0 = unlimited (default bash timeout instead of the clamp). */
	effectiveMaxDuration: number
	/** Shared run/resume clock used by the expiry timer and bash timeout clamp. */
	timeBudget: InteractiveTimeBudgetRef
	/** Subagent persona type — labels the bash clamp telemetry. */
	type: SubagentType
	/** Fully constructed worker gate, appended after every tool provider. */
	workerPermissionsExtension: ExtensionFactory
	/** Main session whose live mode governs MCP gateway calls. */
	parentSessionId: string
	/** Resolved run model; an auto-routed model adds the routing + prompt-rebuild factories. */
	model: Model<Api> | undefined
	/** Persona tool allowlist; debug_/step_ tool names gate the DAP extension via shouldRegisterDapForTools. */
	toolNames: string[]
	/** Host-bound report capability. Present only for Ferment-linked workers. */
	workerReport?: WorkerReportCapability
	/** Whether the cost-per-PR resource is enabled; false drops the work-attribution extension. */
	costPerPrEnabled: boolean
	/**
	 * Whether the mcp-apps resource toggle is on (plugins.mcp-apps, same id as
	 * the parent's gate in cli.ts). Off means off for subagents too, matching
	 * the DAP sibling gate.
	 */
	mcpAppsEnabled: boolean
	/** Work attribution inherited from the parent session; null marks attribution as unavailable. */
	inheritedWorkId?: string | null
	/** Work segment inherited from the parent session. */
	inheritedSegment?: WorkSegment
	/**
	 * Post-workerReport-adjustment extensions gate resolved by the caller
	 * (`options.workerReport && extensions === false ? [] : extensions`).
	 * `false` marks an isolated child, which stays bare — no MCP tools. The
	 * MCP adapter registers only for `true` or an allowlist containing "mcp";
	 * allowlists without "mcp" (including the worker-report `[]` edge) skip it.
	 */
	effectiveExtensions: true | string[] | false
	/** Resolved working directory; handed to the MCP adapter for config discovery. */
	effectiveCwd: string
	/** Rebuilds the subagent system prompt for an active-tool list / routed model id. */
	buildSystemPrompt: (activeToolNames: string[], promptModelId?: string) => string
	/** Notified with each rebuilt prompt (RunOptions.onSystemPrompt). */
	onSystemPrompt?: (prompt: string) => void
}

/**
 * Build the inline extension factory list for one subagent session.
 *
 * Composes the child session's inline extension list from `deps` plus a few
 * process-level reads: the effective telemetry config, the DAP resource gate
 * (shouldRegisterDapForTools), and the wall clock (`Date.now()`) feeding the
 * bash clamp deadline. Assembles the factories in the canonical order —
 * telemetry, work-attribution, request-timing, auto-model routing + prompt
 * rebuild, bash clamp/default-timeout, infrastructure breaker, DAP,
 * worker-report, MCP adapter.
 */
export function buildInlineExtensionFactories(deps: InlineExtensionFactoryDeps): InlineExtension[] {
	// The subagent budget clamp must be wired with the deadline computed
	// at run time (startTimeMs + maxDuration).
	//
	// Repo-native extensions registered directly by the Kimchi CLI are not
	// discovered by a child session's DefaultResourceLoader. Register this
	// safety hook explicitly so worker bash calls get a deterministic upper
	// bound. When max_duration is 0 (unlimited), skip the wall-clock clamp
	// and use the plain default-timeout extension instead.
	const bashExtension =
		deps.effectiveMaxDuration > 0
			? createSubagentBashClampExtension(deps.effectiveMaxDuration, Date.now(), deps.type, () =>
					deps.timeBudget.budget.getRemainingMs(),
				)
			: subagentBashDefaultTimeoutExtension
	// Subagents share this process and its patched retry classifier, so their
	// successes must close the shared infrastructure breaker just like the parent's.
	// Child sessions of a routed virtual model get the auto-model extension so
	// pick learning and capability sync run there too, plus the system-prompt
	// rebuild once a pick is known. No-op for concrete models (responseModel
	// equals the requested id).
	const autoExtensionFactories: InlineExtension[] = isAutoRoutedModel(deps.model)
		? [
				createAutoModelRoutingExtension(),
				(pi) => {
					pi.on("before_agent_start", (_event, childCtx) => {
						const effectiveModel = getEffectiveModel(childCtx)
						const rebuilt = deps.buildSystemPrompt(pi.getActiveTools(), effectiveModel?.id)
						deps.onSystemPrompt?.(rebuilt)
						return { systemPrompt: rebuilt }
					})
				},
			]
		: []
	const extensionFactories: InlineExtension[] = [
		telemetryExtension(readEffectiveTelemetryConfig()),
		...(deps.costPerPrEnabled
			? [createWorkAttributionExtension(deps.inheritedWorkId ?? null, deps.inheritedSegment)]
			: []),
		requestTimingExtension,
		...autoExtensionFactories,
		bashExtension,
		infrastructureBreakerExtension,
		codexCorrelationExtension,
	]
	if (shouldRegisterDapForTools(deps.toolNames)) {
		extensionFactories.push(dapExtension)
	}
	if (deps.workerReport) {
		extensionFactories.push(createWorkerReportExtension(deps.workerReport))
	}
	// Non-isolated children get MCP tools (LLM-4465): repo-native extensions are
	// invisible to a child session's resource loader, so the adapter must be
	// registered inline. Gated on the persona asking for MCP — `true` (inherit
	// everything) or an allowlist containing "mcp" — so an allowlist that
	// excludes MCP (and the worker-report `[]` edge) never starts the adapter
	// or spawns servers merely to filter its tool out afterwards. Appended
	// last on purpose; the DAP × MCP ordering was verified safe for LLM-4472
	// (per-session profile state, no ordering interaction).
	// An allowlist entry is allowed to name the MCP namespace (the plain `mcp`
	// proxy, or an mcp-prefixed tool/server name) — any such entry installs the
	// adapter; the tool filter then decides which MCP tools actually surface.
	if (
		deps.mcpAppsEnabled &&
		(deps.effectiveExtensions === true ||
			(deps.effectiveExtensions !== false && deps.effectiveExtensions.some((ext) => ext.startsWith("mcp"))))
	) {
		// Headless children: drop config warnings (no UI; console output is noise
		// in the parent process) and use lazy gateway discovery so a subagent
		// never retains an eager gateway connection.
		extensionFactories.push(
			createKimchiMcpAdapterExtension({
				cwd: deps.effectiveCwd,
				suppressWarnings: true,
				lazyGatewayConnect: true,
				parentSessionId: deps.parentSessionId,
			}),
		)
	}
	// The caller constructs this before loader initialization so a load failure
	// cannot be swallowed into an unchecked child. Isolation never disables the gate.
	extensionFactories.push({ name: WORKER_PERMISSIONS_EXTENSION_NAME, factory: deps.workerPermissionsExtension })
	return extensionFactories
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
	session: AgentSession,
	prompt: string,
	options: {
		onToolActivity?: (activity: ToolActivity) => void
		onTurnEnd?: (turnCount: number) => void
		onAssistantUsage?: (usage: LifetimeUsage) => void
		onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void
		signal?: AbortSignal
		maxTurns?: number
		tokenBudget?: number
		minTokenBudget?: number
		inactivityTimeout?: number
		inactivityMode?: InactivityMode
		maxDuration?: number
		hardTurnLimit?: boolean
		shouldTerminateAfterTool?: (toolName: string) => boolean
		/** Registers a hard-fallback cleanup for runner-owned resources. */
		onRuntimeCleanupRegistered?: (cleanup: () => void) => void
	} = {},
): Promise<RunResult> {
	// runAgentInner emits session_shutdown after every run (the per-run flush,
	// mirroring the ACP pattern), which tears the MCP adapter's connections down
	// terminally (its lifecycle manager cannot reconnect). A resumed session is
	// the same AgentSession object, so restart its extensions with a fresh
	// session_start — reason "resume", matching pi's own resumption event.
	const ownerSessionId = getRegisteredWorkerParentSession(session)
	if (ownerSessionId) setAgentWorkerParentSessionId(ownerSessionId)
	await session.extensionRunner?.emit({ type: "session_start", reason: "resume" })

	const collector = collectResponseText(session)
	const cleanupAbort = forwardAbortSignal(session, options.signal)

	const resumeInactivity = createInactivityTracker(options.inactivityMode)
	const resumeInactivityTimeout = options.inactivityTimeout ?? DEFAULT_INACTIVITY_TIMEOUT
	// Same interactive-wait hold as the fresh-run path: resumes also escalate
	// permission prompts to the parent during a classifier outage.
	const resumeInactivityHolds = { count: 0 }
	setAgentWorkerInactivityHold({
		acquire: () => {
			const releaseTimeBudget = timeBudget.budget.pause()
			resumeInactivityHolds.count += 1
			let released = false
			return () => {
				if (released) return
				released = true
				resumeInactivityHolds.count -= 1
				releaseTimeBudget()
				resumeInactivity.touch()
			}
		},
	})
	const effectiveMaxTurns = normalizeMaxTurns(options.maxTurns)
	const minBudget = options.minTokenBudget ?? MIN_TOKEN_BUDGET
	const effectiveTokenBudget = options.tokenBudget != null ? Math.max(options.tokenBudget, minBudget) : undefined
	const effectiveMaxDuration = options.maxDuration ?? DEFAULT_MAX_DURATION
	const resumeTimeBudget = createInteractiveTimeBudget(effectiveMaxDuration, Date.now())
	const timeBudget = sessionTimeBudgets.get(session) ?? { budget: resumeTimeBudget }
	timeBudget.budget = resumeTimeBudget
	sessionTimeBudgets.set(session, timeBudget)
	const observedUsage: LifetimeUsage = getSessionUsage(session) ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	}
	let turnCount = 0
	let cumulativeTokens = 0
	let softLimitReached = false
	let tokenSoftLimitSteered = false
	let aborted = false
	let budgetAborted = false
	let abortReason: AgentAbortReason | undefined
	let terminationToolCompleted = false

	const unsubEvents = session.subscribe((event: AgentSessionEvent) => {
		resumeInactivity.track(event)

		if (event.type === "turn_end") {
			turnCount++
			options.onTurnEnd?.(turnCount)
			if (!terminationToolCompleted && effectiveMaxTurns != null) {
				if (options.hardTurnLimit && turnCount >= effectiveMaxTurns) {
					aborted = true
					abortReason = "max_turns"
					hardAbort(session)
				} else if (!softLimitReached && turnCount >= effectiveMaxTurns) {
					softLimitReached = true
					steerAsOrchestrator(
						session,
						"You have reached this resume's turn limit. Stop exploring. Complete your current edit, ensure file syntax is valid, and summarize progress plus remaining work for the orchestrator. Do not start new edits.",
					)
				} else if (softLimitReached && turnCount >= effectiveMaxTurns + graceTurns) {
					aborted = true
					abortReason = "max_turns"
					hardAbort(session)
				}
			}
		}
		if (event.type === "tool_execution_start") {
			if (budgetAborted) {
				hardAbort(session)
			} else {
				options.onToolActivity?.({ status: "in_progress", toolName: event.toolName })
			}
		}
		if (event.type === "tool_execution_end") {
			options.onToolActivity?.({ status: "completed", toolName: event.toolName })
			if (options.shouldTerminateAfterTool?.(event.toolName)) {
				terminationToolCompleted = true
				queueMicrotask(() => hardAbort(session))
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = (
				event.message as unknown as {
					usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
				}
			).usage
			if (u) {
				const usage = {
					input: u.input ?? 0,
					output: u.output ?? 0,
					cacheRead: u.cacheRead ?? 0,
					cacheWrite: u.cacheWrite ?? 0,
				}
				addUsage(observedUsage, usage)
				cumulativeTokens += getOutputTotal(usage)
				options.onAssistantUsage?.(usage)
				if (!terminationToolCompleted && effectiveTokenBudget != null && !budgetAborted) {
					if (cumulativeTokens > effectiveTokenBudget) {
						budgetAborted = true
						abortReason = "token_budget"
						console.warn(
							`[agent-runner] resume token budget exceeded (cumulative=${cumulativeTokens}, budget=${effectiveTokenBudget}); aborting`,
						)
						hardAbort(session)
					} else if (!tokenSoftLimitSteered && cumulativeTokens >= effectiveTokenBudget * 0.8) {
						tokenSoftLimitSteered = true
						steerAsOrchestrator(
							session,
							"You are approaching this resume's output token limit. Wrap up current work and summarize remaining tasks.",
						)
					}
				}
			}
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore })
		}
	})

	let resumeInactivityInterval: ReturnType<typeof setInterval> | undefined = setInterval(() => {
		if (resumeInactivity.suspended()) return
		if (resumeInactivityHolds.count > 0) return // interactive wait (e.g. escalated permission prompt)
		const elapsed = resumeInactivity.elapsedMs()
		if (resumeInactivity.steered && elapsed >= resumeInactivityTimeout) {
			aborted = true
			abortReason = "inactivity"
			hardAbort(session)
		} else if (!resumeInactivity.steered && elapsed >= resumeInactivityTimeout) {
			resumeInactivity.markSteered()
			steerAsOrchestrator(session, "You appear to be stalled. Resume work immediately or summarize your progress.")
		}
	}, INACTIVITY_CHECK_INTERVAL)
	const cleanupResumeInactivityInterval = () => {
		if (!resumeInactivityInterval) return
		clearInterval(resumeInactivityInterval)
		resumeInactivityInterval = undefined
	}
	options.onRuntimeCleanupRegistered?.(cleanupResumeInactivityInterval)
	resumeTimeBudget.setOnExpire(() => {
		aborted = true
		abortReason = "max_duration"
		hardAbort(session)
	})

	try {
		await session.prompt(prompt)
	} finally {
		cleanupResumeInactivityInterval()
		resumeTimeBudget.dispose()
		collector.unsubscribe()
		unsubEvents()
		cleanupAbort()
	}

	const finalUsageDelta = usageDelta(getSessionUsage(session), observedUsage)
	if (finalUsageDelta) {
		addUsage(observedUsage, finalUsageDelta)
		cumulativeTokens += getOutputTotal(finalUsageDelta)
		options.onAssistantUsage?.(finalUsageDelta)
	}

	if (
		!terminationToolCompleted &&
		effectiveTokenBudget != null &&
		!budgetAborted &&
		cumulativeTokens > effectiveTokenBudget
	) {
		budgetAborted = true
		abortReason = "token_budget"
	}

	const responseText = collector.getText().trim() || getLastAssistantText(session)
	return {
		responseText,
		session,
		aborted: terminationToolCompleted ? false : aborted || budgetAborted,
		abortReason: terminationToolCompleted ? undefined : abortReason,
		steered: softLimitReached,
		turnsUsed: turnCount,
		maxTurns: effectiveMaxTurns,
	}
}

/**
 * Send a steering message to a running subagent.
 */
export async function steerAgent(session: AgentSession, message: string): Promise<void> {
	await session.steer(message)
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
	const parts: string[] = []

	for (const msg of session.messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content)
			if (text.trim()) parts.push(`[User]: ${text.trim()}`)
		} else if (msg.role === "assistant") {
			const textParts: string[] = []
			const toolCalls: string[] = []
			for (const c of msg.content) {
				if (c.type === "text" && c.text) textParts.push(c.text)
				else if (c.type === "toolCall")
					toolCalls.push(
						`  Tool: ${(c as unknown as { name?: string; toolName?: string }).name ?? (c as unknown as { name?: string; toolName?: string }).toolName ?? "unknown"}`,
					)
			}
			if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`)
			if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`)
		} else if (msg.role === "toolResult") {
			const text = extractText(msg.content)
			const truncated = text.length > 200 ? `${text.slice(0, 200)}...` : text
			parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`)
		}
	}

	return parts.join("\n\n")
}

// Personas that request DAP debugger tools (e.g. Debugger) need the dap
// extension registered in the child session: repo-native extensions wired
// directly in cli.ts are not discovered by a child DefaultResourceLoader.
// The extension registers its tools on the child's session_start, and the SDK
// activates them because their names are in the session's tool allowlist.
// Honors the extensions.dap /resources toggle: off means off for subagents too.
function isDapToolName(name: string): boolean {
	// Exact membership, not a debug_*/step_* prefix: a non-DAP tool (e.g. an
	// MCP-provided "debug_metrics") must not be treated as a debugger name —
	// it would escape the fail-fast check and then silently drop.
	return (
		(DAP_ENTRY_TOOL_NAMES as readonly string[]).includes(name) ||
		(DAP_SESSION_TOOL_NAMES as readonly string[]).includes(name)
	)
}

export function shouldRegisterDapForTools(toolNames: readonly string[]): boolean {
	return isResourceEnabled("extensions.dap") && toolNames.some(isDapToolName)
}
