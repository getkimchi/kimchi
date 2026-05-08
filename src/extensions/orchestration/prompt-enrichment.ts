/**
 * Orchestration prompt enrichment extension.
 *
 * Behavior depends on whether this process is the main model or a subagent
 * (detected via the KIMCHI_SUBAGENT env var set during subagent spawning).
 *
 * Main model mode:
 * - "input": wraps the user prompt with the current model's own capabilities
 *   and the available subagent models so the model can self-classify the task
 *   and decide which steps to execute itself vs. delegate.
 * - "before_agent_start": injects the self-classification system prompt with
 *   full tool access (read, write, edit, bash, subagent).
 *
 * Subagent mode:
 * - "input": passes through unchanged.
 * - "before_agent_start": injects the pure worker system prompt. Filters out
 *   the subagent tool to prevent infinite delegation chains.
 *
 * Steering messages are excluded — when the agent is streaming, the handler
 * returns "continue" so the message passes through unchanged.
 */

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, platform, userInfo } from "node:os"
import { isAbsolute, join, normalize, resolve } from "node:path"
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai"
import { type ExtensionAPI, type Skill, getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import { ANSI, fg } from "../../ansi.js"
import { getCurrentPhase } from "../../extensions/tags.js"
import { getAvailableModels } from "../../startup-context.js"
import { getGitBranch } from "../../utils.js"
import {
	CONTINUATION_NUDGE_TEXT,
	ContinuationNudge,
	EMPTY_TURN_NUDGE_TEXT,
	EmptyTurnNudge,
	NUDGE_CUSTOM_TYPE,
	type OrchestratorMessages,
	stripStaleNudges,
} from "./continuation-nudge.js"
import { ModelRegistry } from "./model-registry/index.js"
import type { Phase } from "./model-registry/types.js"
import { type ContextFile, loadProjectContextFiles } from "./prompt-transformer/context-files.js"
import {
	type EnvironmentInfo,
	type PromptContext,
	buildOrchestratorSystemPrompt,
	buildSingleModelSystemPrompt,
	buildSubagentSystemPrompt,
	isSubagent,
	transformPrompt,
} from "./prompt-transformer/prompt-transformer.js"

function expandSkillPaths(configuredPaths: string[], cwd: string): string[] {
	const home = homedir()
	const expanded: string[] = []
	for (const p of configuredPaths) {
		if (isAbsolute(p)) {
			expanded.push(normalize(p))
		} else if (p.startsWith("~/")) {
			expanded.push(resolve(home, p.slice(2)))
		} else {
			const fromHome = resolve(home, p)
			const fromCwd = resolve(cwd, p)
			if (fromHome.startsWith(`${home}/`) || fromHome === home) expanded.push(fromHome)
			if (fromCwd.startsWith(`${cwd}/`) || fromCwd === cwd) expanded.push(fromCwd)
		}
	}
	return expanded
}

function safeUsername(): string {
	try {
		return userInfo().username
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "unknown"
	}
}

function readGitRemote(cwd: string): string | undefined {
	try {
		return (
			execSync("git remote get-url origin", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
			undefined
		)
	} catch {
		return undefined
	}
}

// Workaround: pi-mono's applyExtensionFlagValues ignores the actual value for boolean flags (always sets true). Read argv directly until upstream is fixed.
function readMultiModelArgv(): boolean {
	const args = process.argv
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "--multi-model=false") return false
		if (arg === "--multi-model=true") return true
		if (arg === "--multi-model") {
			const next = args[i + 1]
			if (next === "false") return false
			if (next === "true") return true
			return true
		}
	}
	return true
}

let multiModelEnabled = readMultiModelArgv()

// macOS terminals send the legacy escape sequence \x1b\t for Option+Tab
// instead of the Kitty protocol / CSI-u sequences handled by matchesKey()
const LEGACY_MACOS_ALT_TAB_SEQUENCE = "\x1b\t"

const ENRICHED_PROMPT_CUSTOM_TYPE = "enriched-prompt"

/**
 * Tracks which model and phase last received an enriched-prompt injection so
 * the capabilities block is only sent once per (model, phase) pair, not on
 * every user turn. Re-injects when either the model or the active phase
 * changes, keeping guidelines up to date for both transitions.
 */
export class EnrichmentGuard {
	private lastModelId: string | null = null
	private lastPhase: string | null = null

	/** Returns true if enrichment should be injected for this (model, phase) pair. */
	shouldEnrich(modelId: string, phase?: string): boolean {
		const phaseKey = phase ?? null
		if (modelId === this.lastModelId && phaseKey === this.lastPhase) return false
		this.lastModelId = modelId
		this.lastPhase = phaseKey
		return true
	}

	/** Resets the guard, e.g. when multi-model is toggled off and back on. */
	reset(): void {
		this.lastModelId = null
		this.lastPhase = null
	}
}

/**
 * Shape of a tool-call content block as emitted in assistant messages.
 * Defined narrowly here because the upstream `OrchestratorMessages` type does
 * not export the per-block discriminated-union members we need to narrow on.
 */
type ToolCallBlock = { type: "toolCall"; name: string; id?: string }

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		"type" in block &&
		(block as { type: unknown }).type === "toolCall" &&
		"name" in block &&
		typeof (block as { name: unknown }).name === "string"
	)
}

function isEmptyToolCallBlock(block: unknown): block is ToolCallBlock {
	return isToolCallBlock(block) && block.name.trim() === ""
}

/**
 * Strip empty-name tool calls and their error results from the context.
 *
 * Some models (notably Kimi K2.x) emit tool calls with empty name/id fields.
 * The runtime rejects these before the extension hook fires, producing
 * "Tool  not found" error results that accumulate in the context window and
 * waste tokens on every subsequent LLM call. This filter removes those
 * dead-end pairs so they do not inflate the context.
 *
 * Returns the original `messages` reference unchanged when there is nothing
 * to strip, so callers can use referential equality to detect a no-op.
 */
export function stripEmptyToolCalls(messages: OrchestratorMessages): OrchestratorMessages {
	// Collect tool-call IDs that have empty names so we can remove their results.
	const emptyCallIds = new Set<string>()

	for (const msg of messages) {
		if (msg.role === "assistant" && "content" in msg && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (isEmptyToolCallBlock(block)) {
					emptyCallIds.add(block.id ?? "")
				}
			}
		}
	}

	if (emptyCallIds.size === 0) return messages

	let changed = false
	const filtered: OrchestratorMessages = []
	for (const msg of messages) {
		if (msg.role === "assistant" && "content" in msg && Array.isArray(msg.content)) {
			const cleaned = msg.content.filter((block) => !isEmptyToolCallBlock(block))
			if (cleaned.length !== msg.content.length) {
				changed = true
				if (cleaned.length > 0) {
					filtered.push({ ...msg, content: cleaned } as OrchestratorMessages[number])
				}
				continue
			}
		}
		if (
			msg.role === "toolResult" &&
			"toolCallId" in msg &&
			emptyCallIds.has((msg as { toolCallId: string }).toolCallId)
		) {
			changed = true
			continue
		}
		filtered.push(msg)
	}

	return changed ? filtered : messages
}

export function deduplicateEnrichedPrompts(messages: OrchestratorMessages): OrchestratorMessages {
	const lastIdx = messages.findLastIndex(
		(m) =>
			m.role === "custom" &&
			"customType" in m &&
			(m as { customType: string }).customType === ENRICHED_PROMPT_CUSTOM_TYPE,
	)
	if (lastIdx === -1) return messages
	const filtered = messages.filter(
		(m, i) =>
			i === lastIdx ||
			!(
				m.role === "custom" &&
				"customType" in m &&
				(m as { customType: string }).customType === ENRICHED_PROMPT_CUSTOM_TYPE
			),
	)
	return filtered.length === messages.length ? messages : filtered
}

export function getMultiModelEnabled(): boolean {
	return multiModelEnabled
}

export default function (skillPaths: string[]) {
	return (pi: ExtensionAPI) => {
		const subagentMode = isSubagent()

		pi.registerFlag("debug-prompts", {
			type: "boolean",
			description: "Print enriched prompts in the UI (default: hidden)",
			default: false,
		})

		pi.registerFlag("multi-model", {
			type: "boolean",
			description: "Enable multi-model orchestration (default: enabled). Toggle with alt+tab.",
			default: true,
		})

		// For sub agents we don't want to transform the prompt sent from parent with model capabilities
		const registry = new ModelRegistry(getAvailableModels())
		if (!subagentMode) {
			// Announce newly available API models that have no capability entry yet.
			for (const warning of registry.warnings) {
				console.log(
					`${fg(ANSI.accent, ` New model available: "kimchi-dev/${warning.modelId}"`)}\n${fg(ANSI.dim, " Update the app or add the new model to model capabilities config to unlock orchestration support.")}`,
				)
			}

			// Global terminal input listener so alt+tab works even when a
			// dialog (e.g. permission prompt) has focus instead of the editor.
			let unsubAltTab: (() => void) | null = null
			pi.on("session_start", async (_event, ctx) => {
				if (unsubAltTab) unsubAltTab()
				// Reset so the first turn of every session always re-injects the
				// enriched prompt, even when model and phase are unchanged from the
				// previous session (e.g. same model, session always starts in explore).
				enrichmentGuard.reset()
				if (ctx.hasUI) {
					unsubAltTab = ctx.ui.onTerminalInput((data) => {
						if (matchesKey(data, "alt+tab") || data === LEGACY_MACOS_ALT_TAB_SEQUENCE) {
							if (!isKeyRelease(data)) {
								multiModelEnabled = !multiModelEnabled
								ctx.ui.setStatus("multi-model", undefined)
							}
							return { consume: true }
						}
						return undefined
					})
				}
			})

			// Detect the inverse of the context-event nudge below: the orchestrator reasons
			// in prose, announces it will delegate, and ends its turn without emitting the
			// `subagent` tool call. The agent loop would otherwise exit and wait for another
			// user prompt. Nudge once per user-input cycle, and only when no tool has fired
			// that cycle — so genuine end-of-task summaries are left alone. Mirrors AISI
			// Inspect's `on_continue`.
			//
			// The reset handler is registered BEFORE the enrichment handler below because
			// that one returns `{action: "handled"}` in interactive mode, which short-
			// circuits the input-handler chain.
			const continuationNudge = new ContinuationNudge()
			const emptyTurnNudge = new EmptyTurnNudge()
			const enrichmentGuard = new EnrichmentGuard()

			pi.on("input", async (event) => {
				if (event.source === "extension") {
					// Subagent result arriving. Clear the subagent-pending flag so the
					// continuation nudge can fire normally once the model has processed
					// the output (at the next turn_end, after any tool calls it makes).
					continuationNudge.clearSubagentPending()
					return
				}
				continuationNudge.resetForNewUserInput()
				emptyTurnNudge.resetForNewUserInput()
			})

			pi.on("tool_execution_start", async () => {
				continuationNudge.recordToolCall()
			})

			pi.on("message_update", (event) => {
				if (!continuationNudge.isNudgeResponsePending()) return
				const ame = event.assistantMessageEvent
				if (ame.type !== "text_delta") return
				const message = event.message as AssistantMessage
				const content = message.content[ame.contentIndex]
				if (content?.type === "text") {
					continuationNudge.accumulateResponse(content.text)
					content.text = ""
				}
			})

			pi.on("turn_end", async (event) => {
				if (event.message.role !== "assistant") return

				// Mark each subagent tool call so the continuation nudge stays
				// suppressed until all subagent results have been received.
				// A single turn may contain multiple parallel subagent calls.
				for (const c of event.message.content) {
					if (c.type === "toolCall" && (c as { name?: string }).name === "subagent") {
						continuationNudge.markSubagentCall()
					}
				}

				if (continuationNudge.isNudgeResponsePending()) {
					if (continuationNudge.isDoneSignalReceived()) {
						return
					}
				}

				if (emptyTurnNudge.evaluateTurn(event.message)) {
					pi.sendMessage(
						{ customType: NUDGE_CUSTOM_TYPE, content: EMPTY_TURN_NUDGE_TEXT, display: false },
						{ deliverAs: "followUp" },
					)
					return
				}

				if (!continuationNudge.evaluateTurn(event.message)) return
				pi.sendMessage(
					{ customType: NUDGE_CUSTOM_TYPE, content: CONTINUATION_NUDGE_TEXT, display: false },
					{ deliverAs: "followUp" },
				)
			})

			pi.on("input", async (event, ctx) => {
				if (event.source === "extension") {
					return { action: "continue" as const }
				}

				// Steering and follow-up messages arrive while the agent is streaming
				// (ctx.isIdle() === false, i.e. session.isStreaming === true).
				// Skip enrichment and let them pass through unchanged
				if (!ctx.isIdle()) {
					return { action: "continue" as const }
				}

				if (!multiModelEnabled) {
					return { action: "continue" as const }
				}

				const currentModel = ctx.model ? { id: ctx.model.id, name: ctx.model.id } : undefined
				const currentModelId = currentModel?.id ?? ""

				// Only inject capabilities on the first turn or when the model or phase
				// changes. Re-injecting every turn accumulates duplicate capability blocks
				// in the context window, inflating token usage and confusing the model.
				if (!enrichmentGuard.shouldEnrich(currentModelId, getCurrentPhase())) {
					return { action: "continue" as const }
				}

				// Non-interactive (--print/--mode rpc) and debug-prompts mode: replace the user
				// text inline. The "handled" + sendUserMessage path below relies on the TUI event
				// loop staying alive long enough for the queued message to drain — in --print mode
				// the loop returns as soon as session.prompt resolves and disposeRuntime cancels
				// the in-flight LLM call, so nothing is ever sent. Transforming inline lets the
				// caller's await session.prompt(enrichedPrompt) do the work synchronously.
				const debugPrompts = pi.getFlag("debug-prompts") === true
				if (debugPrompts || !ctx.hasUI) {
					const enrichedPrompt = transformPrompt(event.text, registry, currentModel)
					return { action: "transform" as const, text: enrichedPrompt, images: event.images }
				}

				// In UI mode the original user message is sent separately via sendUserMessage,
				// so the task text must not be duplicated inside the enriched-prompt header.
				const enrichedPrompt = transformPrompt(event.text, registry, currentModel, false)
				pi.sendMessage(
					{
						customType: ENRICHED_PROMPT_CUSTOM_TYPE,
						content: [{ type: "text", text: enrichedPrompt }],
						display: false,
					},
					{ deliverAs: "nextTurn" },
				)
				const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: event.text }]
				if (event.images) userContent.push(...event.images)
				pi.sendUserMessage(userContent)

				return { action: "handled" as const }
			})

			pi.on("context", async (event) => {
				let messages = stripStaleNudges(event.messages)
				messages = deduplicateEnrichedPrompts(messages)
				messages = stripEmptyToolCalls(messages)
				if (messages !== event.messages) return { messages }
			})
		} else {
			// Subagents skip orchestrator-specific transforms but still benefit from
			// stripping phantom empty-name tool calls. Some models (notably Kimi K2.x
			// and MiniMax M2.7) emit empty tool calls after a real write/edit call,
			// which the runtime rejects with a "Tool  not found" result that would
			// otherwise accumulate in the subagent's context across turns.
			pi.on("context", async (event) => {
				const messages = stripEmptyToolCalls(event.messages)
				if (messages !== event.messages) return { messages }
			})
		}

		const platformNames: Record<string, string> = { darwin: "macOS", win32: "Windows" }
		const cachedOs = platformNames[platform()] ?? platform()
		const cachedUsername = safeUsername()
		const cachedHomeDir = homedir()

		let cachedContextFiles: ContextFile[] | undefined
		let cachedSkills: Skill[] | undefined
		let cachedGitRemote: string | undefined | null = null

		pi.on("before_agent_start", async (_event, ctx) => {
			const tools = pi.getAllTools()
			cachedContextFiles ??= loadProjectContextFiles(ctx.cwd)
			cachedSkills ??= loadSkills({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				skillPaths: expandSkillPaths(skillPaths, ctx.cwd),
				includeDefaults: false,
			}).skills

			const now = new Date()
			const isGitRepo = existsSync(join(ctx.cwd, ".git", "HEAD"))
			if (isGitRepo && cachedGitRemote === null) {
				cachedGitRemote = readGitRemote(ctx.cwd)
			}
			const env: EnvironmentInfo = {
				os: cachedOs,
				username: cachedUsername,
				homeDir: cachedHomeDir,
				cwd: ctx.cwd,
				documentsDir: join(ctx.cwd, ".kimchi", "docs"),
				currentTime: now.toISOString(),
				localDate: now.toLocaleDateString("en-CA"),
				isGitRepo,
				gitBranch: isGitRepo ? getGitBranch(ctx.cwd) : undefined,
				gitRemote: isGitRepo ? (cachedGitRemote ?? undefined) : undefined,
			}

			const promptCtx: PromptContext = {
				currentModelId: ctx.model?.id,
				currentPhase: getCurrentPhase(),
				registry: registry,
			}

			if (subagentMode) {
				// Filter the subagent tool out to prevent infinite delegation chains.
				const activeTools = pi.getActiveTools().filter((name) => name !== "subagent")
				pi.setActiveTools(activeTools)
				const systemPrompt = buildSubagentSystemPrompt(tools, env, cachedContextFiles, cachedSkills, promptCtx)
				return { systemPrompt }
			}

			if (!multiModelEnabled) {
				const systemPrompt = buildSingleModelSystemPrompt(tools, env, cachedContextFiles, cachedSkills, promptCtx)
				return { systemPrompt }
			}

			const systemPrompt = buildOrchestratorSystemPrompt(tools, env, cachedContextFiles, cachedSkills, promptCtx)
			return { systemPrompt }
		})
	}
}
