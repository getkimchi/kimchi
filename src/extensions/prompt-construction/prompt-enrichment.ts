/**
 * Prompt enrichment extension.
 *
 * Behavior depends on whether this process is the main model or an Agent worker
 * (detected via Agent worker context or the legacy KIMCHI_SUBAGENT env var).
 *
 * Main model mode:
 * - "input": keeps the user prompt intact while the selected model and its
 *   available tools determine how the task is handled.
 * - "before_agent_start": injects the single-model system prompt with full
 *   tool access (read, write, edit, bash, Agent).
 *
 * Subagent mode:
 * - "input": passes through unchanged.
 * - "before_agent_start": delegates to buildSystemPrompt in system-prompt.ts,
 *   which produces the worker system prompt and filters out delegation tools
 *   (to prevent infinite delegation chains). This file only strips phantom
 *   empty-name tool calls from the subagent context.
 *
 * Steering messages are excluded — when the agent is streaming, the handler
 * returns "continue" so the message passes through unchanged.
 */

import { execSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { arch, homedir, version as osVersion, platform, userInfo } from "node:os"
import { join } from "node:path"
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { resolveSkillPathsForDiscovery } from "../../shared/skill-discovery/resolve-skill-roots.js"
import { getAvailableModels } from "../../startup-context.js"
import { getGitBranch } from "../../utils.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { getConfiguredSkillResourcePaths } from "../claude-code-skills/definition.js"
import { bumpStallCounter } from "../ferment/todo-sync.js"
import {
	brandUnmarkedSteers,
	ContinuationNudge,
	EMPTY_TURN_NUDGE_TEXT,
	EmptyTurnNudge,
	NUDGE_CUSTOM_TYPE,
	type OrchestratorMessages,
	stripStaleNudges,
	stripUiOnlyMessages,
	tagSelfEchoes,
} from "../orchestration/continuation-nudge.js"
import { ModelRegistry } from "../orchestration/model-registry/index.js"
import { getEffectiveModel } from "../router/state.js"
import { type ContextFile, loadGlobalContextFiles, loadProjectContextFiles } from "./context-files.js"
import { isKimiK2Model, normalizeKimiToolCallIds } from "./normalize-kimi-tool-call-ids.js"
import {
	buildSystemPrompt,
	DELEGATION_TOOL_NAMES,
	type EnvironmentInfo,
	type PromptMode,
	type ToolInfo,
} from "./system-prompt.js"

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

// Tracks sessions that have already received a deprecation notification to avoid duplicate alerts.
const deprecatedNotificationFired = new Set<string>()

export function _resetDeprecatedNotificationTracking(): void {
	deprecatedNotificationFired.clear()
}

function isDelegationToolCallName(name: string | undefined): boolean {
	return name != null && DELEGATION_TOOL_NAMES.has(name)
}

function isToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
	return (
		typeof block === "object" &&
		block !== null &&
		"type" in block &&
		block.type === "toolCall" &&
		"name" in block &&
		typeof block.name === "string"
	)
}

function isEmptyToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
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

export function isSubagent(): boolean {
	return isAgentWorker()
}

export default function (skillPathsFromConfig: string[]) {
	return (pi: ExtensionAPI) => {
		const subagentMode = isSubagent()

		pi.registerFlag("debug-prompts", {
			type: "boolean",
			description: "Print enriched prompts in the UI (default: hidden)",
			default: process.env.KIMCHI_DEBUG_PROMPTS === "1",
		})

		// For sub agents we don't want to transform the prompt sent from parent with model capabilities
		const registry = new ModelRegistry(getAvailableModels())

		// Build a map of deprecated model IDs for quick lookup during session_start.
		const deprecatedWarnings = new Map<string, string | undefined>()
		for (const w of registry.warnings) {
			if (w.kind === "deprecated_model") {
				deprecatedWarnings.set(w.modelId, w.replacement)
			}
		}

		if (!subagentMode) {
			function notifyIfDeprecated(ctx: ExtensionContext) {
				const sessionId = ctx.sessionManager.getSessionId() ?? "unknown"
				if (ctx.model && deprecatedWarnings.has(ctx.model.id) && !deprecatedNotificationFired.has(sessionId)) {
					deprecatedNotificationFired.add(sessionId)
					const replacement = deprecatedWarnings.get(ctx.model.id)
					const replacementAvailable = replacement && registry.getAll().some((m) => m.id === replacement)
					const message =
						replacement && replacementAvailable
							? `Model "${ctx.model.id}" is deprecated. Switch to "${replacement}" for better performance.`
							: `Model "${ctx.model.id}" is deprecated. It may be removed in a future update.`
					ctx.ui?.notify(message, "warning")
				}
			}

			pi.on("session_shutdown", async (_event, ctx) => {
				const sessionId = ctx.sessionManager.getSessionId()
				deprecatedNotificationFired.delete(sessionId)
			})

			pi.on("session_start", async (_event, ctx) => {
				notifyIfDeprecated(ctx)
			})

			pi.on("model_select", async (event, ctx) => {
				notifyIfDeprecated(ctx)

				// A user-initiated model switch (UI picker, /model, or cycling)
				// is a fresh start for tool-calling behaviour from the new model's
				// perspective. Reset the session-level latch so the first text-only
				// turn after the switch is treated like the first turn of a new
				// session (nudge suppressed until the new model calls a tool).
				// Session restore is deliberately excluded: a restored session is
				// continuing an existing conversation, not starting fresh.
				if (event.source === "set" || event.source === "cycle") {
					const sessionId = ctx.sessionManager.getSessionId()
					const continuationNudge = getContinuationNudge(sessionId)
					const emptyTurnNudge = getEmptyTurnNudge(sessionId)
					continuationNudge.resetForModelSwitch()
					emptyTurnNudge.resetForModelSwitch()
				}
			})

			// Detect the inverse of the context-event nudge below: the main agent reasons
			// in prose, announces it will delegate, and ends its turn without emitting a
			// delegation tool call. The agent loop would otherwise exit and wait for another
			// user prompt. Nudge once per user-input cycle, and only when no tool has fired
			// that cycle — so genuine end-of-task summaries are left alone. Mirrors AISI
			// Inspect's `on_continue`.
			//
			// The reset handler is registered BEFORE the enrichment handler below because
			// that one returns `{action: "handled"}` in interactive mode, which short-
			// circuits the input-handler chain.
			const continuationNudgeMap = new Map<string, ContinuationNudge>()
			const emptyTurnNudgeMap = new Map<string, EmptyTurnNudge>()

			function getContinuationNudge(sessionId: string): ContinuationNudge {
				let nudge = continuationNudgeMap.get(sessionId)
				if (!nudge) {
					nudge = new ContinuationNudge()
					continuationNudgeMap.set(sessionId, nudge)
				}
				return nudge
			}

			function getEmptyTurnNudge(sessionId: string): EmptyTurnNudge {
				let nudge = emptyTurnNudgeMap.get(sessionId)
				if (!nudge) {
					nudge = new EmptyTurnNudge()
					emptyTurnNudgeMap.set(sessionId, nudge)
				}
				return nudge
			}

			pi.on("agent_start", async (_event, ctx) => {
				const sessionId = ctx.sessionManager.getSessionId()
				const continuationNudge = getContinuationNudge(sessionId)
				continuationNudge.resetForNewAgentRun()
			})

			pi.on("input", async (event, ctx) => {
				const sessionId = ctx.sessionManager.getSessionId()
				const continuationNudge = getContinuationNudge(sessionId)
				const emptyTurnNudge = getEmptyTurnNudge(sessionId)

				if (event.source === "extension") {
					// Agent result arriving. Clear the delegation-pending flag so the
					// continuation nudge can fire normally once the model has processed
					// the output (at the next turn_end, after any tool calls it makes).
					continuationNudge.clearDelegationPending()
					return
				}
				continuationNudge.resetForNewUserInput()
				emptyTurnNudge.resetForNewUserInput()
			})

			pi.on("tool_execution_start", async (_event, ctx) => {
				const sessionId = ctx.sessionManager.getSessionId()
				const continuationNudge = getContinuationNudge(sessionId)
				continuationNudge.recordToolCall()
			})

			pi.on("message_update", (event, ctx) => {
				const sessionId = ctx.sessionManager.getSessionId()
				const continuationNudge = getContinuationNudge(sessionId)

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

			pi.on("turn_end", async (event, ctx) => {
				if (event.message.role !== "assistant") return
				// Safe after the role guard: AgentMessage with role "assistant" is AssistantMessage.
				const assistantMsg = event.message as AssistantMessage

				const sessionId = ctx.sessionManager.getSessionId()
				const continuationNudge = getContinuationNudge(sessionId)
				const emptyTurnNudge = getEmptyTurnNudge(sessionId)

				// Track stall: increment counter each turn so the headless prompt
				// block can detect when the main agent hasn't updated step todos.
				// Scoped to this session so concurrent sessions do not share a counter.
				bumpStallCounter(sessionId)

				// Mark each delegation tool call so the continuation nudge stays
				// suppressed until all delegated-agent results have been received.
				// A single turn may contain multiple parallel agent calls.
				for (const c of assistantMsg.content) {
					if (c.type === "toolCall" && isDelegationToolCallName((c as { name?: string }).name)) {
						continuationNudge.markDelegationCall()
					}
				}

				if (continuationNudge.isNudgeResponsePending()) {
					if (continuationNudge.isDoneSignalReceived() || assistantMsg.stopReason === "stop") {
						// The model either explicitly sent the <done> signal or ended its
						// turn with stopReason "stop" (intentional end-of-turn). Either
						// way, respect the stop — do not send another nudge that would
						// trigger a new turn and make the model think it received user input.
						return
					}
					// While a continuation nudge response is pending, the model is already
					// in a recovery cycle. Skip empty-turn nudge here to avoid sending
					// mixed instructions ("call a tool" vs "summarize or continue").
					// Fall through to continuationNudge.evaluateTurn below.
				} else if (
					// Suppress the empty-turn nudge when any tool was called during this
					// agent run. After a completed tool sequence, an empty response is
					// almost certainly the model finishing, not a model glitch. Without
					// this check the model treats the nudge as user input and continues
					// working after it was already done.
					!continuationNudge.hasToolBeenCalledThisRun() &&
					emptyTurnNudge.evaluateTurn(assistantMsg)
				) {
					pi.sendMessage(
						{ customType: NUDGE_CUSTOM_TYPE, content: EMPTY_TURN_NUDGE_TEXT, display: false },
						{ deliverAs: "followUp" },
					)
					return
				}

				if (!continuationNudge.evaluateTurn(assistantMsg)) return
				pi.sendMessage(
					{
						customType: NUDGE_CUSTOM_TYPE,
						content: continuationNudge.getNudgeText(),
						display: false,
					},
					{ deliverAs: "followUp" },
				)
			})

			pi.on("context", async (event, ctx) => {
				const effectiveModel = getEffectiveModel(ctx)
				let messages = stripStaleNudges(event.messages)
				messages = stripEmptyToolCalls(messages)
				messages = stripUiOnlyMessages(messages)
				// kimi-k2.x stalls on historical tool calls whose IDs are not in
				// Moonshot's canonical format (issue #1063) — normalize for those
				// targets only.
				if (isKimiK2Model(effectiveModel?.id)) {
					messages = normalizeKimiToolCallIds(messages)
				}
				messages = tagSelfEchoes(messages)
				messages = brandUnmarkedSteers(messages)
				if (messages !== event.messages) return { messages }
			})
		}

		if (subagentMode) {
			// Subagents skip main-session transforms but still benefit from
			// stripping phantom empty-name tool calls. Some models (notably Kimi K2.x
			// and MiniMax M2.7) emit empty tool calls after a real write/edit call,
			// which the runtime rejects with a "Tool  not found" result that would
			// otherwise accumulate in the subagent's context across turns.
			pi.on("context", async (event, ctx) => {
				const effectiveModel = getEffectiveModel(ctx)
				let messages = stripEmptyToolCalls(event.messages)
				if (isKimiK2Model(effectiveModel?.id)) {
					messages = normalizeKimiToolCallIds(messages)
				}
				messages = brandUnmarkedSteers(messages)
				if (messages !== event.messages) return { messages }
			})
		}

		const platformNames: Record<string, string> = { darwin: "macOS", win32: "Windows" }
		const cachedRawPlatform = platform()
		const cachedOs = platformNames[cachedRawPlatform] ?? cachedRawPlatform
		const cachedCpuArchitecture = arch()
		const cachedShell = process.env.SHELL ?? process.env.ComSpec ?? "unknown"
		const cachedOsVersion = osVersion()
		const cachedUsername = safeUsername()
		const cachedHomeDir = homedir()

		let cachedContextFiles: ContextFile[] | undefined
		let cachedGitRemote: string | undefined | null = null

		pi.on("resources_discover", (event) => {
			// Contribute Kimchi-only skill sources to pi's resource inventory so
			// every downstream surface (base prompt skills section, /skill:<name>,
			// autocomplete, /resources) sees them. All discovery, filtering, and
			// collision-avoidance logic lives in resolveSkillPathsForDiscovery.
			const extraPaths = getConfiguredSkillResourcePaths(event.cwd, skillPathsFromConfig)
			const skillPaths = resolveSkillPathsForDiscovery(event.cwd, { extraPaths })
			if (skillPaths.length === 0) return undefined
			return { skillPaths }
		})

		pi.on("before_agent_start", async (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			const effectiveModel = getEffectiveModel(ctx)

			const activeToolNames = new Set(pi.getActiveTools())
			const tools = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name))
			cachedContextFiles ??= [...loadGlobalContextFiles(), ...loadProjectContextFiles(ctx.cwd)]
			// Read skills from pi's resolved resource inventory (system prompt
			// options) so the rebuilt prompt advertises exactly what pi
			// loaded — honoring settings.json, --skill/--no-skills, trust,
			// packages, precedence and collision rules — rather than a second,
			// divergent view composed here. Kimchi-specific sources reach pi
			// through resources_discover above.
			const skills = event.systemPromptOptions?.skills ?? []

			const now = new Date()
			const isGitRepo = existsSync(join(ctx.cwd, ".git", "HEAD"))
			if (isGitRepo && cachedGitRemote === null) {
				cachedGitRemote = readGitRemote(ctx.cwd)
			}
			const env: EnvironmentInfo = {
				os: cachedOs,
				rawPlatform: cachedRawPlatform,
				cpuArchitecture: cachedCpuArchitecture,
				shell: cachedShell,
				osVersion: cachedOsVersion,
				username: cachedUsername,
				homeDir: cachedHomeDir,
				cwd: ctx.cwd,
				documentsDir: join(ctx.cwd, ".kimchi", "docs"),
				localDate: now.toLocaleDateString("en-CA"),
				isGitRepo,
				gitBranch: isGitRepo ? getGitBranch(ctx.cwd) : undefined,
				gitRemote: isGitRepo ? (cachedGitRemote ?? undefined) : undefined,
			}

			const mode: PromptMode = subagentMode ? "subagent" : "single"

			let systemPrompt = buildSystemPrompt({
				tools: tools as readonly ToolInfo[],
				env,
				contextFiles: cachedContextFiles,
				skills: skills,
				currentModelId: effectiveModel?.id,
				mode,
				sessionId,
			})

			// The rebuilt prompt replaces pi's base prompt entirely, which would
			// silently drop --append-system-prompt flag values (and SYSTEM/
			// APPEND_SYSTEM.md content) collected by pi's resource loader.
			// Re-append them so per-session prompt extensions keep working,
			// e.g. a parent process embedding kimchi as a managed agent.
			const appendSystemPrompt = event.systemPromptOptions?.appendSystemPrompt?.trim()
			if (appendSystemPrompt) {
				systemPrompt = `${systemPrompt}\n\n${appendSystemPrompt}`
			}

			const debugSession = process.env.KIMCHI_DEBUG_SESSION
			const debugFlag = pi.getFlag("debug-prompts") === true
			if (debugFlag || debugSession) {
				const sessionId = debugSession ?? randomUUID().slice(0, 8)
				process.env.KIMCHI_DEBUG_PROMPTS = "1"
				process.env.KIMCHI_DEBUG_SESSION = sessionId

				const debugDir = join(ctx.cwd, ".kimchi", "debug", sessionId)
				mkdirSync(debugDir, { recursive: true })

				const label = subagentMode ? "subagent" : `main-agent-${mode}`
				const filePath = join(debugDir, `${label}-${Date.now()}.md`)
				writeFileSync(filePath, systemPrompt)

				if (ctx.hasUI) {
					ctx.ui.notify(`[debug-prompts] ${filePath}`, "info")
				}
			} else {
				delete process.env.KIMCHI_DEBUG_PROMPTS
				delete process.env.KIMCHI_DEBUG_SESSION
			}

			return { systemPrompt }
		})
	}
}
