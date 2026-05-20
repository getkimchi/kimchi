import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	type AgentSession,
	type AgentSessionEvent,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../../../startup-context.js"
import { runAsAgentWorker } from "../../agent-worker-context.js"
import { buildPhaseGuidelinesSection } from "../../orchestration/model-registry/guidelines/guidelines-resolver.js"
import { ModelRegistry } from "../../orchestration/model-registry/index.js"
import { getCurrentPhase, setCurrentPhase } from "../../tags.js"
import { detectEnv } from "../env.js"
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../memory/memory.js"
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getConfig,
	getMemoryToolNames,
	getReadOnlyMemoryToolNames,
	getToolNamesForType,
} from "../personas/agent-types.js"
import { DEFAULT_AGENTS } from "../personas/default-agents.js"
import {
	AGENT_GENERAL_PURPOSE,
	type AgentAbortReason,
	type SubagentType,
	type ThinkingLevel,
} from "../personas/types.js"
import { buildParentContext, extractText } from "../prompt/context.js"
import { type PromptExtras, buildAgentPrompt, formatTokenBudget } from "../prompt/prompts.js"
import { preloadSkills } from "../prompt/skill-loader.js"
import { type LifetimeUsage, addUsage, getLifetimeTotal, getOutputTotal, getSessionUsage } from "./usage.js"

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"]

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
	registry: { find(provider: string, modelId: string): Model<Api> | undefined; getAvailable?(): Model<Api>[] },
	configModel?: string,
): Model<Api> | undefined {
	if (configModel) {
		const slashIdx = configModel.indexOf("/")
		if (slashIdx !== -1) {
			const provider = configModel.slice(0, slashIdx)
			const modelId = configModel.slice(slashIdx + 1)

			const available = registry.getAvailable?.()
			const availableKeys = available
				? new Set(
						available.map(
							(m: unknown) =>
								`${(m as { provider: string; id: string }).provider}/${(m as { provider: string; id: string }).id}`,
						),
					)
				: undefined
			const isAvailable = (p: string, id: string) => !availableKeys || availableKeys.has(`${p}/${id}`)

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
	type: "start" | "end"
	toolName: string
}

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
}

export interface RunResult {
	responseText: string
	session: AgentSession
	/** True if the agent was hard-aborted by max turns or token budget. */
	aborted: boolean
	abortReason?: AgentAbortReason
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered: boolean
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

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
	if (!signal) return () => {}
	const onAbort = () => session.abort()
	signal.addEventListener("abort", onAbort, { once: true })
	return () => signal.removeEventListener("abort", onAbort)
}

export async function runAgent(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
): Promise<RunResult> {
	return runAsAgentWorker(() => runAgentInner(ctx, type, prompt, options))
}

async function runAgentInner(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
): Promise<RunResult> {
	const config = getConfig(type)
	const agentConfig = getAgentConfig(type)

	const effectiveCwd = options.cwd ?? ctx.cwd

	const env = await detectEnv(options.pi, effectiveCwd)

	const parentSystemPrompt = ctx.getSystemPrompt()

	const extras: PromptExtras = {}

	const extensions = options.isolated ? false : config.extensions
	const skills = options.isolated ? false : config.skills

	if (Array.isArray(skills)) {
		const loaded = preloadSkills(skills, effectiveCwd)
		if (loaded.length > 0) {
			extras.skillBlocks = loaded
		}
	}

	let toolNames = getToolNamesForType(type)

	if (agentConfig?.memory) {
		const existingNames = new Set(toolNames)
		const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined
		const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name)
		const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit")

		if (hasWriteTools) {
			const extraNames = getMemoryToolNames(existingNames)
			if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames]
			extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd)
		} else {
			const extraNames = getReadOnlyMemoryToolNames(existingNames)
			if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames]
			extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd)
		}
	}

	const modelId = (options.model as { id?: string } | undefined)?.id
	const guidelinesBlock = buildPhaseGuidelinesSection(modelId, getCurrentPhase(), getGuidelinesRegistry())
	if (guidelinesBlock) extras.guidelinesBlock = guidelinesBlock

	const effectiveMaxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns)
	const MIN_TOKEN_BUDGET = 1024
	const rawTokenBudget = options.tokenBudget ?? agentConfig?.tokenBudget
	const effectiveTokenBudget = rawTokenBudget != null ? Math.max(rawTokenBudget, MIN_TOKEN_BUDGET) : undefined
	if (effectiveMaxTurns != null || effectiveTokenBudget != null) {
		extras.budget = { maxTurns: effectiveMaxTurns, tokenBudget: effectiveTokenBudget }
	}

	let systemPrompt: string
	if (agentConfig) {
		systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras)
	} else {
		const fallback = DEFAULT_AGENTS.get(AGENT_GENERAL_PURPOSE)
		if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`)
		systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras)
	}

	const debugSession = process.env.KIMCHI_DEBUG_SESSION
	if (debugSession) {
		try {
			const debugDir = join(effectiveCwd, ".kimchi", "debug", debugSession)
			mkdirSync(debugDir, { recursive: true })
			const agentLabel = agentConfig?.name ?? type
			writeFileSync(join(debugDir, `agent-${agentLabel}-${Date.now()}.md`), systemPrompt)
		} catch {
			// best-effort debug logging
		}
	}

	const noSkills = skills === false || Array.isArray(skills)

	const agentDir = getAgentDir()

	const loader = new DefaultResourceLoader({
		cwd: effectiveCwd,
		agentDir,
		noExtensions: extensions === false,
		noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	})
	await loader.reload()

	const model =
		options.model ??
		resolveDefaultModel(
			ctx.model as Model<Api> | undefined,
			ctx.modelRegistry as {
				find(provider: string, modelId: string): Model<Api> | undefined
				getAvailable?(): Model<Api>[]
			},
			agentConfig?.models?.[0],
		)

	const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking

	const sessionOpts: Parameters<typeof createAgentSession>[0] = {
		cwd: effectiveCwd,
		agentDir,
		sessionManager: options.sessionFile
			? SessionManager.open(options.sessionFile, options.sessionDir, effectiveCwd)
			: SessionManager.inMemory(effectiveCwd),
		settingsManager: SettingsManager.create(effectiveCwd, agentDir),
		modelRegistry: ctx.modelRegistry,
		model,
		resourceLoader: loader,
	}
	if (extensions === false) {
		sessionOpts.tools = toolNames
	}
	if (thinkingLevel) {
		sessionOpts.thinkingLevel = thinkingLevel
	}

	const { session } = await createAgentSession(sessionOpts)

	const disallowedSet = agentConfig?.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined

	await session.bindExtensions({
		onError: (err) => {
			options.onToolActivity?.({
				type: "end",
				toolName: `extension-error:${err.extensionPath}`,
			})
		},
	})

	if (extensions !== false) {
		const builtinToolNameSet = new Set(toolNames)
		const allBuiltinToolNames = new Set(BUILTIN_TOOL_NAMES)
		const activeTools = session.getActiveToolNames().filter((t) => {
			if (EXCLUDED_TOOL_NAMES.includes(t)) return false
			if (disallowedSet?.has(t)) return false
			if (builtinToolNameSet.has(t)) return true
			if (allBuiltinToolNames.has(t)) return false
			if (Array.isArray(extensions)) {
				return extensions.some((ext) => t.startsWith(ext) || t.includes(ext))
			}
			return true
		})
		session.setActiveToolsByName(activeTools)
	} else if (disallowedSet) {
		const activeTools = session.getActiveToolNames().filter((t) => !disallowedSet.has(t))
		session.setActiveToolsByName(activeTools)
	}

	options.onSessionCreated?.(session)

	let turnCount = 0
	let cumulativeTokens = 0
	const observedUsage: LifetimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	const windowObservedUsage: LifetimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	let softLimitReached = false
	let aborted = false
	let abortReason: AgentAbortReason | undefined
	let budgetAborted = false

	const inactivity = { lastActivityAt: Date.now(), steered: false }
	const inactivityTimeout = options.inactivityTimeout ?? DEFAULT_INACTIVITY_TIMEOUT

	const progressSteerThresholds = [0.5, 0.75]
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
		inactivity.lastActivityAt = Date.now()
		if (inactivity.steered) inactivity.steered = false

		if (event.type === "turn_end") {
			turnCount++
			options.onTurnEnd?.(turnCount)
			if (effectiveMaxTurns != null) {
				if (!softLimitReached && turnCount >= effectiveMaxTurns) {
					softLimitReached = true
					session.steer(
						"You have reached your turn limit. Stop exploring. Complete your current edit, ensure file syntax is valid, undo any git state mutations so your work is visible on the filesystem, and summarize progress for the orchestrator. Do not start new edits.",
					)
				} else if (softLimitReached && turnCount >= effectiveMaxTurns + graceTurns) {
					aborted = true
					abortReason = "max_turns"
					session.abort()
				} else if (!softLimitReached && nextProgressIdx < progressSteerThresholds.length) {
					const threshold = progressSteerThresholds[nextProgressIdx] ?? 1
					if (turnCount >= effectiveMaxTurns * threshold) {
						nextProgressIdx++
						session.steer(
							`Budget check: ${buildProgressSummary()}. Prioritize completing the most important remaining work.`,
						)
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
			options.onToolActivity?.({ type: "start", toolName: event.toolName })
		}
		if (event.type === "tool_execution_end") {
			options.onToolActivity?.({ type: "end", toolName: event.toolName })
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
				if (effectiveTokenBudget != null && !budgetAborted) {
					cumulativeTokens += getOutputTotal(usage)
					if (cumulativeTokens > effectiveTokenBudget) {
						budgetAborted = true
						abortReason = "token_budget"
						console.warn(
							`[agent-runner] token budget exceeded (cumulative=${cumulativeTokens}, budget=${effectiveTokenBudget}); aborting`,
						)
						session.abort()
					} else if (!tokenSoftLimitSteered && cumulativeTokens >= effectiveTokenBudget * 0.8) {
						tokenSoftLimitSteered = true
						session.steer(
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

	const inactivityInterval = setInterval(() => {
		const elapsed = Date.now() - inactivity.lastActivityAt
		if (inactivity.steered && elapsed >= inactivityTimeout) {
			aborted = true
			abortReason = "inactivity"
			session.abort()
		} else if (!inactivity.steered && elapsed >= inactivityTimeout) {
			inactivity.steered = true
			session.steer("You appear to be stalled. Resume work immediately or summarize your progress.")
		}
	}, INACTIVITY_CHECK_INTERVAL)

	const collector = collectResponseText(session)
	const cleanupAbort = forwardAbortSignal(session, options.signal)

	let effectivePrompt = prompt
	if (options.inheritContext) {
		const parentContext = buildParentContext(ctx)
		if (parentContext) {
			effectivePrompt = parentContext + prompt
		}
	}

	// Propagate agent persona to child environment so permission rules can
	// apply persona-specific path scopes (e.g. plan persona → .kimchi/plans/).
	const prevPersona = process.env.KIMCHI_AGENT_PERSONA
	if (agentConfig?.name) {
		process.env.KIMCHI_AGENT_PERSONA = agentConfig.name
	}

	const prevPhase = getCurrentPhase()
	const personaPhase = agentConfig?.strengths?.[0]
	if (personaPhase) {
		setCurrentPhase(personaPhase)
	}

	try {
		await session.prompt(effectivePrompt)
	} finally {
		clearInterval(inactivityInterval)
		unsubTurns()
		collector.unsubscribe()
		cleanupAbort()
		// Restore persona env — important for sequential runs in the same process.
		if (agentConfig?.name) {
			if (prevPersona === undefined) {
				// biome-ignore lint/performance/noDelete: must remove not set to undefined
				delete process.env.KIMCHI_AGENT_PERSONA
			} else {
				process.env.KIMCHI_AGENT_PERSONA = prevPersona
			}
		}
		if (personaPhase) {
			setCurrentPhase(prevPhase)
		}
	}

	const finalUsageDelta = usageDelta(getSessionUsage(session), windowObservedUsage)
	if (finalUsageDelta) {
		addUsage(observedUsage, finalUsageDelta)
		addUsage(windowObservedUsage, finalUsageDelta)
		cumulativeTokens += getOutputTotal(finalUsageDelta)
		options.onAssistantUsage?.(finalUsageDelta)
	}

	if (effectiveTokenBudget != null && !budgetAborted && getOutputTotal(observedUsage) > effectiveTokenBudget) {
		budgetAborted = true
		abortReason = "token_budget"
	}

	const responseText = collector.getText().trim() || getLastAssistantText(session)
	return { responseText, session, aborted: aborted || budgetAborted, abortReason, steered: softLimitReached }
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
	session: AgentSession,
	prompt: string,
	options: {
		onToolActivity?: (activity: ToolActivity) => void
		onAssistantUsage?: (usage: LifetimeUsage) => void
		onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void
		signal?: AbortSignal
		inactivityTimeout?: number
	} = {},
): Promise<string> {
	const collector = collectResponseText(session)
	const cleanupAbort = forwardAbortSignal(session, options.signal)

	const resumeInactivity = { lastActivityAt: Date.now(), steered: false }
	const resumeInactivityTimeout = options.inactivityTimeout ?? DEFAULT_INACTIVITY_TIMEOUT

	const unsubEvents = session.subscribe((event: AgentSessionEvent) => {
		resumeInactivity.lastActivityAt = Date.now()
		if (resumeInactivity.steered) resumeInactivity.steered = false

		if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName })
		if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName })
		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = (
				event.message as unknown as {
					usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
				}
			).usage
			if (u)
				options.onAssistantUsage?.({
					input: u.input ?? 0,
					output: u.output ?? 0,
					cacheRead: u.cacheRead ?? 0,
					cacheWrite: u.cacheWrite ?? 0,
				})
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore })
		}
	})

	const resumeInactivityInterval = setInterval(() => {
		const elapsed = Date.now() - resumeInactivity.lastActivityAt
		if (resumeInactivity.steered && elapsed >= resumeInactivityTimeout) {
			session.abort()
		} else if (!resumeInactivity.steered && elapsed >= resumeInactivityTimeout) {
			resumeInactivity.steered = true
			session.steer("You appear to be stalled. Resume work immediately or summarize your progress.")
		}
	}, INACTIVITY_CHECK_INTERVAL)

	try {
		await session.prompt(prompt)
	} finally {
		clearInterval(resumeInactivityInterval)
		collector.unsubscribe()
		unsubEvents()
		cleanupAbort()
	}

	return collector.getText().trim() || getLastAssistantText(session)
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
