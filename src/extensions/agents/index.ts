/**
 * kimchi sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	defineTool,
	getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { isToolExpanded, registerToolCall } from "../../expand-state.js"
import { filterThinkingForDisplay } from "../hide-thinking.js"
import { sessionHasImages } from "../model-guard.js"
import { KIMCHI_DEV_PROVIDER, MODEL_CAPABILITIES } from "../orchestration/model-registry/index.js"
import { AgentManager } from "./manager/agent-manager.js"
import {
	getAgentConversation,
	getDefaultMaxTurns,
	getGraceTurns,
	normalizeMaxTurns,
	setDefaultMaxTurns,
	setGraceTurns,
	steerAgent,
} from "./manager/agent-runner.js"
import {
	type BudgetRetryBlock,
	type BudgetRetryCandidate,
	createBudgetRetryBlockFromCompletion,
	shouldBlockBudgetRetry,
} from "./manager/budget-retry-guard.js"
import { GroupJoinManager } from "./manager/group-join.js"
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./manager/output-file.js"
import { prepareAgentSessionFile } from "./manager/session-file.js"
import { type LifetimeUsage, addUsage, getLifetimeTotal, getSessionContextPercent } from "./manager/usage.js"
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getAllTypes,
	getAvailableTypes,
	getDefaultAgentNames,
	getUserAgentNames,
	registerAgents,
	resolveType,
} from "./personas/agent-types.js"
import { loadCustomAgents } from "./personas/custom-agents.js"
import {
	AGENT_GENERAL_PURPOSE,
	type AgentAbortReason,
	type AgentConfig,
	type AgentRecord,
	type AgentVisibility,
	type JoinMode,
	type NotificationDetails,
	type SubagentType,
} from "./personas/types.js"
import { resolveAgentInvocationConfig, resolveJoinMode } from "./resolution/invocation-config.js"
import { type ModelRegistry, resolveModel } from "./resolution/model-resolver.js"
import { type SubagentsSettings, applyAndEmitLoaded, saveAndEmitChanged } from "./settings.js"
import {
	type AgentActivity,
	type AgentDetails,
	AgentWidget,
	SPINNER,
	type Theme,
	type UICtx,
	describeActivity,
	formatDuration,
	formatMs,
	formatTokens,
	formatTurns,
	getDisplayName,
	getPromptModeLabel,
} from "./ui/agent-widget.js"

// ---- Shared helpers ----

function textResult<T = AgentDetails>(msg: string, details?: T) {
	return { content: [{ type: "text" as const, text: msg }], details: details as unknown }
}

interface GetSubagentResultDetails {
	agentId: string
	displayName: string
	description: string
	status: string
	visibility?: AgentVisibility
	abortReason?: AgentAbortReason
	toolUses: number
	tokens: string
	contextPercent: number | null
	compactionCount?: number
	durationMs?: number
	error?: string
	bodyText: string
}

function formatAgentBodyForDisplay(raw: string): string {
	const cleaned = filterThinkingForDisplay(raw)
	return cleaned.replace(/\n{3,}/g, "\n\n").trimEnd()
}

function getSubagentResultIcon(status: string, theme: Theme): string {
	switch (status) {
		case "running":
		case "queued":
			return theme.fg("accent", SPINNER[0])
		case "error":
		case "aborted":
			return theme.fg("error", "✗")
		case "stopped":
			return theme.fg("dim", "■")
		case "steered":
			return theme.fg("warning", "✓")
		default:
			return theme.fg("success", "✓")
	}
}

function extractImagePathsFromSession(ctx: ExtensionContext): string[] {
	const entries = ctx.sessionManager.getBranch()
	const imagePaths = new Set<string>()
	const readPathsByToolCallId = new Map<string, string>()

	for (const entry of entries) {
		if (entry.type !== "message") continue
		const msg = entry.message

		if (msg.role === "assistant") {
			const content = msg.content
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type !== "toolCall") continue
					const toolBlock = block as { id?: string; name?: string; arguments?: Record<string, unknown> }
					if (toolBlock.name === "read" && toolBlock.id && typeof toolBlock.arguments?.path === "string") {
						readPathsByToolCallId.set(toolBlock.id, toolBlock.arguments.path)
					}
				}
			}
		} else if (msg.role === "toolResult") {
			const toolResultMsg = msg as { toolCallId?: string; content?: unknown[] }
			const content = toolResultMsg.content
			if (Array.isArray(content)) {
				const hasImage = content.some((block) => (block as { type?: string }).type === "image")
				const path = toolResultMsg.toolCallId ? readPathsByToolCallId.get(toolResultMsg.toolCallId) : undefined
				if (hasImage && path) {
					imagePaths.add(path)
				}
			}
			if (toolResultMsg.toolCallId) {
				readPathsByToolCallId.delete(toolResultMsg.toolCallId)
			}
		}
	}

	return Array.from(imagePaths)
}

export function summaryForStatus(status: string, error?: string, abortReason?: AgentAbortReason): string {
	switch (status) {
		case "running":
		case "queued":
			return "Still running"
		case "completed":
			return "Done"
		case "steered":
			return "Wrapped up (turn limit)"
		case "aborted":
			return getAbortLabel(abortReason)
		case "stopped":
			return "Stopped"
		case "error":
			return `Error: ${error?.split("\n")[0]?.trim() || "unknown"}`
		default:
			return status
	}
}

function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
	const t = getLifetimeTotal(o.lifetimeUsage)
	return t > 0 ? formatTokens(t) : ""
}

function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
	const state: AgentActivity = {
		activeTools: new Map(),
		toolUses: 0,
		turnCount: 1,
		maxTurns,
		responseText: "",
		session: undefined,
		lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}

	const callbacks = {
		onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
			if (activity.type === "start") {
				state.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName)
			} else {
				for (const [key, name] of state.activeTools) {
					if (name === activity.toolName) {
						state.activeTools.delete(key)
						break
					}
				}
				state.toolUses++
			}
			onStreamUpdate?.()
		},
		onTextDelta: (_delta: string, fullText: string) => {
			state.responseText = fullText
			onStreamUpdate?.()
		},
		onTurnEnd: (turnCount: number) => {
			state.turnCount = turnCount
			onStreamUpdate?.()
		},
		onSessionCreated: (session: unknown) => {
			state.session = session as AgentActivity["session"]
		},
		onAssistantUsage: (usage: LifetimeUsage) => {
			addUsage(state.lifetimeUsage, usage)
			onStreamUpdate?.()
		},
	}

	return { state, callbacks }
}

function getAbortLabel(reason?: AgentAbortReason): string {
	switch (reason) {
		case "max_turns":
			return "Aborted (max turns exceeded)"
		case "token_budget":
			return "Aborted (token budget exceeded)"
		case "inactivity":
			return "Aborted (inactivity timeout)"
		default:
			return "Aborted"
	}
}

function getAbortNote(reason?: AgentAbortReason): string {
	switch (reason) {
		case "max_turns":
			return " (aborted — max turns exceeded, output may be incomplete)"
		case "token_budget":
			return " (aborted — token budget exceeded, output may be incomplete)"
		case "inactivity":
			return " (aborted — agent became unresponsive, output may be incomplete)"
		default:
			return " (aborted, output may be incomplete)"
	}
}

function getStatusLabel(status: string, error?: string, abortReason?: AgentAbortReason): string {
	switch (status) {
		case "error":
			return `Error: ${error ?? "unknown"}`
		case "aborted":
			return getAbortLabel(abortReason)
		case "steered":
			return "Wrapped up (turn limit)"
		case "stopped":
			return "Stopped"
		default:
			return "Done"
	}
}

function getStatusNote(status: string, abortReason?: AgentAbortReason): string {
	switch (status) {
		case "aborted":
			return getAbortNote(abortReason)
		case "steered":
			return " (wrapped up — reached turn limit)"
		case "stopped":
			return " (stopped by user)"
		default:
			return ""
	}
}

function getStatusInstruction(status: string, abortReason?: AgentAbortReason): string {
	if (status === "aborted" && abortReason === "token_budget") {
		return "\nThe agent ran out of its token budget. Do NOT retry the same task with a higher budget. If the work is incomplete, you may spawn a NEW follow-up Agent scoped to only the remaining unfinished work — keep the same or lower budget."
	}
	if (status === "aborted" && abortReason === "inactivity") {
		return "\nThe agent stopped producing output and was terminated. Review any partial results. If the work is incomplete, you may spawn a follow-up Agent to continue from where this one left off."
	}
	return ""
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
	const status = getStatusLabel(record.status, record.error, record.abortReason)
	const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0
	const totalTokens = getLifetimeTotal(record.lifetimeUsage)
	const contextPercent = getSessionContextPercent(record.session)
	const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : ""
	const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : ""

	const resultPreview = record.result
		? record.result.length > resultMaxLen
			? `${record.result.slice(0, resultMaxLen)}\n...(truncated, use get_subagent_result for full output)`
			: record.result
		: "No output."

	return [
		"<task-notification>",
		`<task-id>${record.id}</task-id>`,
		record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
		record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
		`<status>${escapeXml(status)}</status>`,
		`<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
		`<result>${escapeXml(resultPreview)}</result>`,
		`<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
		"</task-notification>",
	]
		.filter(Boolean)
		.join("\n")
}

function buildDetails(
	base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags" | "visibility">,
	record: {
		toolUses: number
		startedAt: number
		completedAt?: number
		status: string
		abortReason?: AgentAbortReason
		error?: string
		id?: string
		sessionFile?: string
		session?: unknown
		lifetimeUsage: LifetimeUsage
	},
	activity?: AgentActivity,
	overrides?: Partial<AgentDetails>,
): AgentDetails {
	return {
		...base,
		toolUses: record.toolUses,
		tokens: formatLifetimeTokens(record),
		tokenUsage: {
			input: record.lifetimeUsage.input,
			output: record.lifetimeUsage.output,
			cacheRead: record.lifetimeUsage.cacheRead,
			cacheWrite: record.lifetimeUsage.cacheWrite,
		},
		turnCount: activity?.turnCount,
		maxTurns: activity?.maxTurns,
		durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
		status: record.status as AgentDetails["status"],
		agentId: record.id,
		sessionFile: record.sessionFile,
		error: record.error,
		abortReason: record.abortReason,
		...overrides,
	}
}

function buildNotificationDetails(
	record: AgentRecord,
	resultMaxLen: number,
	activity?: AgentActivity,
): NotificationDetails {
	const totalTokens = getLifetimeTotal(record.lifetimeUsage)

	return {
		id: record.id,
		description: record.description,
		status: record.status,
		abortReason: record.abortReason,
		toolUses: record.toolUses,
		turnCount: activity?.turnCount ?? 0,
		maxTurns: activity?.maxTurns,
		totalTokens,
		durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
		outputFile: record.outputFile,
		error: record.error,
		resultPreview: record.result
			? record.result.length > resultMaxLen
				? `${record.result.slice(0, resultMaxLen)}…`
				: record.result
			: "No output.",
	}
}

let activeManager: AgentManager | undefined
let budgetRetryBlock: BudgetRetryBlock | undefined
const budgetRetryCandidates = new Map<string, BudgetRetryCandidate>()

function blockBudgetRetryIfNeeded(record: AgentRecord, candidate: BudgetRetryCandidate | undefined): void {
	const block = createBudgetRetryBlockFromCompletion(candidate, record)
	if (block) budgetRetryBlock = block
}

export function getActiveAgentCount(): number {
	return activeManager?.getRunningCount() ?? 0
}

export default function (pi: ExtensionAPI) {
	pi.on("message_start", (event) => {
		if (event.message.role === "user") budgetRetryBlock = undefined
	})

	// ---- Register custom notification renderer ----
	pi.registerMessageRenderer<NotificationDetails>("subagent-notification", (message, { expanded }, theme) => {
		const d = message.details
		if (!d) return undefined

		function renderOne(d: NotificationDetails): string {
			const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted"
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓")
			const statusText =
				d.status === "aborted"
					? getAbortLabel(d.abortReason)
					: isError
						? d.status
						: d.status === "steered"
							? "completed (steered)"
							: "completed"

			let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`

			const parts: string[] = []
			if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns))
			if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`)
			if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens))
			if (d.durationMs > 0) parts.push(formatMs(d.durationMs))
			if (parts.length) {
				line += `\n  ${parts.map((p) => theme.fg("dim", p)).join(` ${theme.fg("dim", "·")} `)}`
			}

			if (expanded) {
				const lines = d.resultPreview.split("\n").slice(0, 30)
				for (const l of lines) line += `\n${theme.fg("dim", `  ${l}`)}`
			} else {
				const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? ""
				line += `\n  ${theme.fg("dim", `⎿  ${preview}`)}`
			}

			if (d.outputFile) {
				line += `\n  ${theme.fg("muted", `transcript: ${d.outputFile}`)}`
			}

			return line
		}

		const all = [d, ...(d.others ?? [])]
		return new Text(all.map(renderOne).join("\n"), 0, 0)
	})

	const reloadCustomAgents = (cwd: string = process.cwd()) => {
		const userAgents = loadCustomAgents(cwd)
		registerAgents(userAgents)
	}

	reloadCustomAgents()

	const agentActivity = new Map<string, AgentActivity>()

	// ---- Cancellable pending notifications ----
	const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>()
	const NUDGE_HOLD_MS = 200

	function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
		cancelNudge(key)
		pendingNudges.set(
			key,
			setTimeout(() => {
				pendingNudges.delete(key)
				send()
			}, delay),
		)
	}

	function cancelNudge(key: string) {
		const timer = pendingNudges.get(key)
		if (timer != null) {
			clearTimeout(timer)
			pendingNudges.delete(key)
		}
	}

	function emitIndividualNudge(record: AgentRecord) {
		if (record.visibility === "system") return
		if (record.resultConsumed) return

		const notification = formatTaskNotification(record, 500)
		const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : ""

		pi.sendMessage<NotificationDetails>(
			{
				customType: "subagent-notification",
				content: notification + footer,
				display: true,
				details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
			},
			{ deliverAs: "followUp", triggerTurn: true },
		)
	}

	function sendIndividualNudge(record: AgentRecord) {
		agentActivity.delete(record.id)
		widget.markFinished(record.id)
		scheduleNudge(record.id, () => emitIndividualNudge(record))
		widget.update()
	}

	// ---- Group join manager ----
	const groupJoin = new GroupJoinManager((records, partial) => {
		for (const r of records) {
			agentActivity.delete(r.id)
			widget.markFinished(r.id)
		}

		const groupKey = `group:${records.map((r) => r.id).join(",")}`
		scheduleNudge(groupKey, () => {
			const unconsumed = records.filter((r) => !r.resultConsumed)
			if (unconsumed.length === 0) {
				widget.update()
				return
			}

			const notifications = unconsumed.map((r) => formatTaskNotification(r, 300)).join("\n\n")
			const label = partial
				? `${unconsumed.length} agent(s) finished (partial — others still running)`
				: `${unconsumed.length} agent(s) finished`

			const [first, ...rest] = unconsumed
			const details = buildNotificationDetails(first, 300, agentActivity.get(first.id))
			if (rest.length > 0) {
				details.others = rest.map((r) => buildNotificationDetails(r, 300, agentActivity.get(r.id)))
			}

			pi.sendMessage<NotificationDetails>(
				{
					customType: "subagent-notification",
					content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
					display: true,
					details,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			)
		})
		widget.update()
	}, 30_000)

	function buildEventData(record: AgentRecord) {
		const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt
		const u = record.lifetimeUsage
		const total = getLifetimeTotal(u)
		const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined
		return {
			id: record.id,
			type: record.type,
			description: record.description,
			result: record.result,
			error: record.error,
			status: record.status,
			visibility: record.visibility,
			abortReason: record.abortReason,
			toolUses: record.toolUses,
			durationMs,
			tokens,
		}
	}

	let currentBatchAgents: { id: string; joinMode: JoinMode }[] = []
	let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined
	let batchCounter = 0

	function finalizeBatch() {
		batchFinalizeTimer = undefined
		const batchAgents = [...currentBatchAgents]
		currentBatchAgents = []

		const smartAgents = batchAgents.filter((a) => a.joinMode === "smart" || a.joinMode === "group")
		if (smartAgents.length >= 2) {
			const groupId = `batch-${++batchCounter}`
			const ids = smartAgents.map((a) => a.id)
			groupJoin.registerGroup(groupId, ids)
			for (const id of ids) {
				const record = manager.getRecord(id)
				if (!record) continue
				record.groupId = groupId
				if (record.completedAt != null && !record.resultConsumed) {
					groupJoin.onAgentComplete(record)
				}
			}
		} else {
			for (const { id } of batchAgents) {
				const record = manager.getRecord(id)
				if (record?.completedAt != null && !record.resultConsumed) {
					sendIndividualNudge(record)
				}
			}
		}
	}

	const manager = new AgentManager(
		(record) => {
			const retryCandidate = budgetRetryCandidates.get(record.id)
			budgetRetryCandidates.delete(record.id)
			blockBudgetRetryIfNeeded(record, retryCandidate)

			const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted"
			const eventData = buildEventData(record)
			if (isError) {
				pi.events.emit("subagents:failed", eventData)
			} else {
				pi.events.emit("subagents:completed", eventData)
			}

			pi.appendEntry("subagents:record", {
				id: record.id,
				type: record.type,
				description: record.description,
				visibility: record.visibility,
				status: record.status,
				abortReason: record.abortReason,
				result: record.result,
				error: record.error,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
			})

			if (record.resultConsumed) {
				agentActivity.delete(record.id)
				widget.markFinished(record.id)
				widget.update()
				return
			}

			if (record.visibility === "system") {
				// System agents never appear in the widget (AgentWidget filters them
				// out at render time), so markFinished/update are no-ops that would
				// just accrue dead state in `finishedTurnAge` and trigger spurious
				// repaints. Just drop the activity entry and bail.
				agentActivity.delete(record.id)
				return
			}

			if (currentBatchAgents.some((a) => a.id === record.id)) {
				widget.update()
				return
			}

			const result = groupJoin.onAgentComplete(record)
			if (result === "pass") {
				sendIndividualNudge(record)
			}
			widget.update()
		},
		undefined,
		(record) => {
			pi.events.emit("subagents:started", {
				id: record.id,
				type: record.type,
				description: record.description,
				visibility: record.visibility,
			})
		},
		(record, info) => {
			pi.events.emit("subagents:compacted", {
				id: record.id,
				type: record.type,
				description: record.description,
				visibility: record.visibility,
				reason: info.reason,
				tokensBefore: info.tokensBefore,
				compactionCount: record.compactionCount,
			})
		},
	)
	activeManager = manager

	pi.on("session_start", async (_event, ctx) => {
		manager.clearCompleted()
		// Re-discover custom agents using the new session's cwd, so a session
		// that started in a different project picks up that project's
		// .kimchi/agents/ directory and forgets the previous one.
		reloadCustomAgents(ctx.cwd)
	})

	pi.on("session_before_switch", () => {
		manager.clearCompleted()
	})

	pi.events.emit("subagents:ready", {})

	pi.on("session_shutdown", async () => {
		manager.abortAll()
		budgetRetryCandidates.clear()
		for (const timer of pendingNudges.values()) clearTimeout(timer)
		pendingNudges.clear()
		manager.dispose()
	})

	const widget = new AgentWidget(manager, agentActivity)
	const listUserVisibleAgents = () => manager.listAgents().filter((a) => a.visibility !== "system")

	let defaultJoinMode: JoinMode = "smart"
	function getDefaultJoinMode(): JoinMode {
		return defaultJoinMode
	}
	function setDefaultJoinMode(mode: JoinMode) {
		defaultJoinMode = mode
	}

	pi.on("tool_execution_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx)
		widget.onTurnStart()
	})

	const buildTypeListText = () => {
		const defaultNames = getDefaultAgentNames()
		const userNames = getUserAgentNames()

		const formatModels = (cfg: ReturnType<typeof getAgentConfig>) => {
			if (!cfg?.models?.length) return ""
			if (cfg.models.length === 1) return ` [model: ${getModelLabelFromConfig(cfg.models[0])}]`
			const labels = cfg.models.map((m) => getModelLabelFromConfig(m))
			return ` [models: ${labels.join(" | ")}]`
		}

		const defaultDescs = defaultNames.map((name) => {
			const cfg = getAgentConfig(name)
			return `- ${name}: ${cfg?.description ?? name}${formatModels(cfg)}`
		})

		const customDescs = userNames.map((name) => {
			const cfg = getAgentConfig(name)
			return `- ${name}: ${cfg?.description ?? name}${formatModels(cfg)}`
		})

		return [
			"Default agents:",
			...defaultDescs,
			...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
			"",
			`Custom agents can be defined in .kimchi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.`,
		].join("\n")
	}

	function getModelLabelFromConfig(model: string): string {
		// biome-ignore lint/style/noNonNullAssertion: split() of a string containing "/" always yields >=2 elements
		const name = model.includes("/") ? model.split("/").pop()! : model
		return name.replace(/-\d{8}$/, "")
	}

	const typeListText = buildTypeListText()

	applyAndEmitLoaded(
		{
			setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
			setDefaultMaxTurns,
			setGraceTurns,
			setDefaultJoinMode,
		},
		(event, payload) => pi.events.emit(event, payload),
	)

	// ---- Agent tool ----

	pi.registerTool(
		defineTool({
			name: "Agent",
			label: "Agent",
			description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- If the user explicitly asks to use the Agent tool, call Agent exactly once with the requested agent type and token_budget. Do not refuse or preflight the budget in prose; let the tool enforce it.
- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.
- Use Explore for codebase searches and code understanding.
- Use Plan for architecture and implementation planning.
- Use Researcher for web/docs research with cited sources.
- Use General-Purpose for complex tasks that need file editing.
- Provide clear, detailed prompts so the agent can work autonomously.
- Agent results are returned as text — summarize them for the user.
- Use run_in_background for work you don't need immediately. You will be notified when it completes.
- Use resume with an agent ID to continue a previous agent's work.
- Use steer_subagent to send mid-run messages to a running background agent.
- Use thinking to request an extended thinking level when the selected agent profile does not fix one.
- Use token_budget to cap the agent's cumulative output token usage when the task scope is small or bounded. Only output tokens (tokens generated by the agent) count toward the budget; input tokens do not.
- Treat token_budget as a hard caller constraint. If an agent aborts because of token_budget, do not retry with a higher budget unless the user explicitly asks.
- Use inherit_context if the agent needs the parent conversation history.

Model selection — YOU choose based on task complexity:
- Each agent type's listing above shows the set of models it can use. The list order has no semantics — it is not a tier ranking.
- Assess the task (single lookup vs. multi-step refactor vs. deep architectural analysis) and pick the model whose capabilities (tier, strengths) best match. Refer to your knowledge of the kimchi-dev models or to your initial system-prompt model section.
- Pass \`model\` only when the user explicitly asks for a specific model or the profile does not lock model selection.
- If \`model\` is omitted, the runtime uses the persona's profile model. Profiles with locked model selection ignore caller model overrides.`,
			parameters: Type.Object({
				prompt: Type.String({
					description: "The task for the agent to perform.",
				}),
				description: Type.String({
					description: "A short (3-5 word) description of the task (shown in UI).",
				}),
				subagent_type: Type.String({
					description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .kimchi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
				}),
				model: Type.Optional(
					Type.String({
						description:
							'Model to use for this spawn — YOU pick based on task complexity. Each agent type advertises a set of models it may use; the list order is not a ranking. Match the task to the model\'s tier/strengths. Format "provider/modelId" (e.g. "kimchi-dev/minimax-m2.7") or fuzzy ("kimi", "minimax", "nemotron"). Omit to use the persona\'s default or let the orchestrator auto-pick based on persona strengths.',
					}),
				),
				thinking: Type.Optional(
					Type.String({
						description:
							"Requested thinking level: off, minimal, low, medium, high, xhigh. Agent profiles with fixed thinking keep their profile value.",
					}),
				),
				max_turns: Type.Optional(
					Type.Number({
						description:
							"Requested maximum agentic turns before stopping. Agent profiles with fixed maxTurns keep their profile value.",
						minimum: 1,
					}),
				),
				token_budget: Type.Optional(
					Type.Integer({
						description:
							"Maximum cumulative output tokens this agent is allowed to generate. Input tokens are not counted.",
						minimum: 1,
					}),
				),
				run_in_background: Type.Optional(
					Type.Boolean({
						description:
							"Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
					}),
				),
				resume: Type.Optional(
					Type.String({
						description: "Optional agent ID to resume from. Continues from previous context.",
					}),
				),
				isolated: Type.Optional(
					Type.Boolean({
						description: "If true, agent gets no extension/MCP tools — only built-in tools.",
					}),
				),
				inherit_context: Type.Optional(
					Type.Boolean({
						description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
					}),
				),
			}),

			renderCall(args, theme) {
				// Defense-in-depth: `visibility` is not in this tool's public schema (see execute()),
				// but if an LLM hallucinates the arg we'd rather hide the tool call than render it.
				if ((args as Record<string, unknown>).visibility === "system") return new Text("", 0, 0)
				const displayName = args.subagent_type ? getDisplayName(args.subagent_type as string) : "Agent"
				const desc = (args.description as string) ?? ""
				return new Text(
					`▸ ${theme.fg("toolTitle", theme.bold(displayName))}${desc ? `  ${theme.fg("muted", desc)}` : ""}`,
					0,
					0,
				)
			},

			renderResult(result, { expanded: piExpanded, isPartial }, theme, context) {
				// Wire kimchi's global ctrl+o cycle: register on first render, then read the
				// per-tool flag back. Falls back to pi's renderer flag if available.
				if (context?.toolCallId) registerToolCall(context.toolCallId)
				const expanded = piExpanded || (context?.toolCallId ? isToolExpanded(context.toolCallId) : false)

				const details = result.details as AgentDetails | undefined
				if (details?.visibility === "system") return new Text("", 0, 0)
				if (!details) {
					const text = result.content[0]?.type === "text" ? result.content[0].text : ""
					return new Text(text, 0, 0)
				}

				const stats = (d: AgentDetails) => {
					const parts: string[] = []
					if (d.modelName) parts.push(d.modelName)
					if (d.tags) parts.push(...d.tags)
					if (d.turnCount != null && d.turnCount > 0) {
						parts.push(formatTurns(d.turnCount, d.maxTurns))
					}
					if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`)
					if (d.tokens) parts.push(d.tokens)
					return parts.map((p) => theme.fg("dim", p)).join(` ${theme.fg("dim", "·")} `)
				}

				if (isPartial || details.status === "running") {
					const frame = SPINNER[details.spinnerFrame ?? 0]
					const s = stats(details)
					let line = theme.fg("accent", frame) + (s ? ` ${s}` : "")
					line += `\n${theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`)}`
					return new Text(line, 0, 0)
				}

				if (details.status === "background") {
					return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0)
				}

				if (details.status === "completed" || details.status === "steered") {
					const duration = formatMs(details.durationMs)
					const isSteered = details.status === "steered"
					const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓")
					const s = stats(details)
					let line = icon + (s ? ` ${s}` : "")
					line += ` ${theme.fg("dim", "·")} ${theme.fg("dim", duration)}`

					if (expanded) {
						const resultText = result.content[0]?.type === "text" ? result.content[0].text : ""
						if (resultText) {
							const lines = resultText.split("\n").slice(0, 50)
							for (const l of lines) {
								line += `\n${theme.fg("dim", `  ${l}`)}`
							}
							if (resultText.split("\n").length > 50) {
								line += `\n${theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)")}`
							}
						}
					} else {
						const doneText = isSteered ? "Wrapped up (turn limit)" : "Done"
						line += `\n${theme.fg("dim", `  ⎿  ${doneText}`)}`
					}
					return new Text(line, 0, 0)
				}

				if (details.status === "stopped") {
					const s = stats(details)
					let line = theme.fg("dim", "■") + (s ? ` ${s}` : "")
					line += `\n${theme.fg("dim", "  ⎿  Stopped")}`
					return new Text(line, 0, 0)
				}

				const s = stats(details)
				let line = theme.fg("error", "✗") + (s ? ` ${s}` : "")

				if (details.status === "error") {
					line += `\n${theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`)}`
				} else {
					line += `\n${theme.fg("warning", `  ⎿  ${getAbortLabel(details.abortReason)}`)}`
				}

				return new Text(line, 0, 0)
			},

			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				widget.setUICtx(ctx.ui as UICtx)

				reloadCustomAgents()

				const rawType = params.subagent_type as SubagentType
				const resolved = resolveType(rawType)
				const subagentType = resolved ?? AGENT_GENERAL_PURPOSE
				const fellBack = resolved === undefined

				const displayName = getDisplayName(subagentType)

				const customConfig = getAgentConfig(subagentType)

				const resolvedConfig = resolveAgentInvocationConfig(
					customConfig,
					params as Parameters<typeof resolveAgentInvocationConfig>[1],
				)

				let model = ctx.model
				if (resolvedConfig.modelInput) {
					const resolvedModel = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry as ModelRegistry)
					if (typeof resolvedModel === "string") {
						if (resolvedConfig.modelFromParams) return textResult(resolvedModel)
					} else {
						model = resolvedModel as typeof ctx.model
					}
				}

				const explicitTokenBudget =
					(params as { token_budget?: number; tokenBudget?: number }).token_budget ??
					(params as { token_budget?: number; tokenBudget?: number }).tokenBudget
				const activeBudgetRetryBlock = budgetRetryBlock
				if (
					activeBudgetRetryBlock &&
					shouldBlockBudgetRetry(activeBudgetRetryBlock, {
						tokenBudget: resolvedConfig.tokenBudget,
						subagentType,
						description: params.description as string,
						prompt: params.prompt as string,
					})
				) {
					return textResult(
						`Agent retry blocked: the previous Agent call for "${activeBudgetRetryBlock.description}" already aborted because the user-supplied token_budget (${formatTokens(activeBudgetRetryBlock.budget)}) was too small. Do not raise the budget or retry the Agent tool unless the user explicitly asks.`,
					)
				}

				const thinking = resolvedConfig.thinking
				const inheritContext = resolvedConfig.inheritContext
				const isolated = resolvedConfig.isolated
				// The `visibility` field is intentionally NOT exposed in this tool's public schema —
				// LLMs and personas cannot create hidden agents. Internal kimchi callers (e.g. permission
				// classifiers, future MCP adapters) spawn hidden agents directly via `AgentManager.spawn(..., { visibility: "system" })`,
				// which bypasses the tool layer entirely. Hardcoding "user" here ensures any defiant
				// LLM that hallucinates a `visibility` arg gets ignored at the source.
				const visibility: AgentVisibility = "user"
				const runInBackground = resolvedConfig.runInBackground

				// Image forwarding: when session has images and subagent model supports vision,
				// extract image paths from read tool calls and prepend them to the prompt.
				const effectivePrompt = (() => {
					const base = params.prompt as string
					if (!sessionHasImages()) return base
					const modelInput = (model as { input?: string[] } | undefined)?.input
					if (!modelInput?.includes("image")) return base

					const imagePaths = extractImagePathsFromSession(ctx)
					if (imagePaths.length === 0) return base

					const pathList = imagePaths.join(", ")
					return `Context images from parent session: ${pathList}. Read them if needed for your task.\n\n${base}`
				})()

				const parentModelId = ctx.model?.id
				const effectiveModelId = (model as { id?: string } | undefined)?.id
				const agentModelName =
					effectiveModelId && effectiveModelId !== parentModelId
						? ((model as { name?: string; id?: string } | undefined)?.name ?? effectiveModelId)
								.replace(/^Claude\s+/i, "")
								.toLowerCase()
						: undefined
				const agentTags: string[] = []
				const modeLabel = getPromptModeLabel(subagentType)
				if (modeLabel) agentTags.push(modeLabel)
				if (thinking) agentTags.push(`thinking: ${thinking}`)
				if (resolvedConfig.tokenBudget != null) agentTags.push(`budget: ${formatTokens(resolvedConfig.tokenBudget)}`)
				if (isolated) agentTags.push("isolated")
				const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns())
				const detailBase = {
					displayName,
					description: params.description as string,
					subagentType,
					visibility,
					modelName: agentModelName,
					tags: agentTags.length > 0 ? agentTags : undefined,
				}

				if (params.resume) {
					const existing = manager.getRecord(params.resume as string)
					if (!existing) {
						return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`)
					}
					if (!existing.session) {
						return textResult(`Agent "${params.resume}" has no active session to resume.`)
					}
					const record = await manager.resume(params.resume as string, params.prompt as string, signal)
					if (!record) {
						return textResult(`Failed to resume agent "${params.resume}".`)
					}
					return textResult(
						record.result?.trim() || record.error?.trim() || "No output.",
						buildDetails({ ...detailBase, visibility: existing.visibility }, record),
					)
				}

				if (runInBackground) {
					const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns)
					let childSessionFile: string | undefined
					const parentSessionDir = ctx.sessionManager.getSessionDir()
					try {
						childSessionFile = prepareAgentSessionFile(
							parentSessionDir,
							ctx.sessionManager.getSessionFile(),
							ctx.cwd,
						)?.sessionFile
					} catch (err) {
						const detail = err instanceof Error ? err.message : String(err)
						return textResult(`Failed to pre-write Agent session file under ${parentSessionDir}: ${detail}`)
					}

					let id: string
					const origBgOnSession = bgCallbacks.onSessionCreated
					bgCallbacks.onSessionCreated = (session: unknown) => {
						origBgOnSession(session)
						const rec = manager.getRecord(id)
						if (rec?.outputFile) {
							rec.outputCleanup = streamToOutputFile(
								session as Parameters<typeof streamToOutputFile>[0],
								rec.outputFile,
								id,
								ctx.cwd,
							)
						}
					}

					try {
						id = manager.spawn(pi, ctx, subagentType, effectivePrompt, {
							description: params.description as string,
							visibility,
							model: model as Parameters<typeof manager.spawn>[4]["model"],
							maxTurns: effectiveMaxTurns,
							tokenBudget: resolvedConfig.tokenBudget,
							isolated,
							inheritContext,
							thinkingLevel: thinking,
							isBackground: true,
							sessionFile: childSessionFile,
							sessionDir: parentSessionDir,
							...bgCallbacks,
						})
					} catch (err) {
						return textResult(err instanceof Error ? err.message : String(err))
					}

					const joinMode = resolveJoinMode(getDefaultJoinMode(), true)
					const record = manager.getRecord(id)
					if (record && joinMode) {
						record.joinMode = joinMode
						record.toolCallId = toolCallId
						record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId(), parentSessionDir)
						writeInitialEntry(record.outputFile, id, params.prompt as string, ctx.cwd)
					}
					if (explicitTokenBudget != null) {
						budgetRetryCandidates.set(id, {
							budget: explicitTokenBudget,
							subagentType,
							description: params.description as string,
							prompt: params.prompt as string,
						})
					}

					if (joinMode != null && joinMode !== "async") {
						currentBatchAgents.push({ id, joinMode })
						if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer)
						batchFinalizeTimer = setTimeout(finalizeBatch, 100)
					}

					agentActivity.set(id, bgState)
					widget.ensureTimer()
					widget.update()

					pi.events.emit("subagents:created", {
						id,
						type: subagentType,
						description: params.description,
						isBackground: true,
						visibility,
					})

					const isQueued = record?.status === "queued"
					return textResult(
						`Agent ${isQueued ? "queued" : "started"} in background.\nAgent ID: ${id}\nType: ${displayName}\nDescription: ${params.description}\n${record?.outputFile ? `Output file: ${record.outputFile}\n` : ""}${isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : ""}\nYou will be notified when this agent completes.\nUse get_subagent_result to retrieve full results, or steer_subagent to send it messages.\nDo not duplicate this agent's work.`,
						{ ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
					)
				}

				// Foreground (synchronous) execution
				let spinnerFrame = 0
				const startedAt = Date.now()
				let fgId: string | undefined

				const streamUpdate = () => {
					const details: AgentDetails = {
						...detailBase,
						toolUses: fgState.toolUses,
						tokens: formatLifetimeTokens(fgState),
						turnCount: fgState.turnCount,
						maxTurns: fgState.maxTurns,
						durationMs: Date.now() - startedAt,
						status: "running",
						activity: describeActivity(fgState.activeTools, fgState.responseText),
						spinnerFrame: spinnerFrame % SPINNER.length,
					}
					onUpdate?.({
						content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
						details: details as unknown,
					})
				}

				const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate)

				const origOnSession = fgCallbacks.onSessionCreated
				fgCallbacks.onSessionCreated = (session: unknown) => {
					origOnSession(session)
					for (const a of manager.listAgents()) {
						if (a.session === session) {
							fgId = a.id
							agentActivity.set(a.id, fgState)
							widget.ensureTimer()
							break
						}
					}
				}

				const spinnerInterval = setInterval(() => {
					spinnerFrame++
					streamUpdate()
				}, 80)

				streamUpdate()

				let record: AgentRecord
				let childSessionFile: string | undefined
				const parentSessionDir = ctx.sessionManager.getSessionDir()
				try {
					childSessionFile = prepareAgentSessionFile(
						parentSessionDir,
						ctx.sessionManager.getSessionFile(),
						ctx.cwd,
					)?.sessionFile
				} catch (err) {
					clearInterval(spinnerInterval)
					const detail = err instanceof Error ? err.message : String(err)
					return textResult(`Failed to pre-write Agent session file under ${parentSessionDir}: ${detail}`)
				}
				try {
					record = await manager.spawnAndWait(pi, ctx, subagentType, effectivePrompt, {
						description: params.description as string,
						visibility,
						model: model as Parameters<typeof manager.spawnAndWait>[4]["model"],
						maxTurns: effectiveMaxTurns,
						tokenBudget: resolvedConfig.tokenBudget,
						isolated,
						inheritContext,
						thinkingLevel: thinking,
						sessionFile: childSessionFile,
						sessionDir: parentSessionDir,
						signal,
						...fgCallbacks,
					})
				} catch (err) {
					clearInterval(spinnerInterval)
					return textResult(err instanceof Error ? err.message : String(err))
				}

				clearInterval(spinnerInterval)

				if (fgId) {
					agentActivity.delete(fgId)
					widget.markFinished(fgId)
				}

				const tokenText = formatLifetimeTokens(fgState)

				const details = buildDetails(detailBase, record, fgState, { tokens: tokenText })

				const fallbackNote = fellBack
					? `Note: Unknown agent type "${rawType}" — using ${AGENT_GENERAL_PURPOSE}.\n\n`
					: ""

				if (record.status === "error") {
					return textResult(`${fallbackNote}Agent failed: ${record.error}`, details)
				}
				blockBudgetRetryIfNeeded(
					record,
					explicitTokenBudget != null
						? {
								budget: explicitTokenBudget,
								subagentType,
								description: params.description as string,
								prompt: params.prompt as string,
							}
						: undefined,
				)

				const durationMs = (record.completedAt ?? Date.now()) - record.startedAt
				const statsParts = [`${record.toolUses} tool uses`]
				if (tokenText) statsParts.push(tokenText)
				const outcome = record.status === "aborted" ? "aborted" : record.status === "stopped" ? "stopped" : "completed"
				return textResult(
					`${fallbackNote}Agent ${outcome} in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status, record.abortReason)}.${getStatusInstruction(record.status, record.abortReason)}\n\n${record.result?.trim() || "No output."}`,
					details,
				)
			},
		}),
	)

	// ---- get_subagent_result tool ----

	pi.registerTool(
		defineTool({
			name: "get_subagent_result",
			label: "Get Agent Result",
			description:
				"Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to check.",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description: "If true, wait for the agent to complete before returning. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),

			renderResult(result, { expanded: piExpanded }, theme, context) {
				if (context?.toolCallId) registerToolCall(context.toolCallId)
				const expanded = piExpanded || (context?.toolCallId ? isToolExpanded(context.toolCallId) : false)

				const details = result.details as GetSubagentResultDetails | undefined
				// Defense-in-depth: hide get_subagent_result output for system agents in the TUI
				// (consistency with the Agent tool's renderCall/renderResult short-circuits).
				if (details?.visibility === "system") return new Text("", 0, 0)
				if (!details) {
					const text = result.content[0]?.type === "text" ? result.content[0].text : ""
					return new Text(text, 0, 0)
				}

				const statsLine = (d: GetSubagentResultDetails) => {
					const parts: string[] = [d.status]
					if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`)
					if (d.tokens) parts.push(d.tokens)
					if (d.contextPercent != null) parts.push(`${Math.round(d.contextPercent)}% ctx`)
					if (d.compactionCount && d.compactionCount > 0) {
						parts.push(`${d.compactionCount} compaction${d.compactionCount === 1 ? "" : "s"}`)
					}
					return parts.map((p) => theme.fg("dim", p)).join(` ${theme.fg("dim", "·")} `)
				}

				const icon = getSubagentResultIcon(details.status, theme)

				const headerName = theme.fg("toolTitle", theme.bold("Get Agent Result"))
				const headerDesc = details.description ? `  ${theme.fg("muted", details.description)}` : ""
				const durationTail =
					details.durationMs != null ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", formatMs(details.durationMs))}` : ""

				let line = `${icon} ${headerName}${headerDesc}${durationTail}`
				const stats = statsLine(details)
				if (stats) line += `\n${theme.fg("dim", "  ⎿  ")}${stats}`

				const bodyText = details.bodyText ?? ""
				if (expanded && bodyText) {
					const lines = bodyText.split("\n")
					const maxLines = 50
					const visible = lines.slice(0, maxLines)
					for (const l of visible) {
						line += `\n${theme.fg("dim", `  ${l}`)}`
					}
					if (lines.length > maxLines) {
						line += `\n${theme.fg("muted", `  … (${lines.length - maxLines} more lines — use verbose: true for full output)`)}`
					}
				} else if (!expanded) {
					const summary = summaryForStatus(details.status, details.error, details.abortReason)
					line += `\n${theme.fg("dim", `  ⎿  ${summary}`)}`
				}

				return new Text(line, 0, 0)
			},

			execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
				const record = manager.getRecord(params.agent_id as string)
				if (!record) {
					return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`)
				}

				if (params.wait && record.status === "running" && record.promise) {
					record.resultConsumed = true
					cancelNudge(params.agent_id as string)
					await record.promise
				}

				const displayName = getDisplayName(record.type)
				const duration = formatDuration(record.startedAt, record.completedAt)
				const tokens = formatLifetimeTokens(record)
				const contextPercent = getSessionContextPercent(record.session)
				const statsParts = [`Tool uses: ${record.toolUses}`]
				if (tokens) statsParts.push(tokens)
				if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`)
				if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`)
				statsParts.push(`Duration: ${duration}`)

				let output =
					`Agent: ${record.id}\n` +
					`Type: ${displayName} | Status: ${record.status} | ${statsParts.join(" | ")}\n` +
					`Description: ${record.description}\n\n`

				let bodyForDisplay: string
				if (record.status === "running") {
					bodyForDisplay = "Agent is still running. Use wait: true or check back later."
					output += bodyForDisplay
				} else if (record.status === "error") {
					bodyForDisplay = `Error: ${record.error}`
					output += bodyForDisplay
				} else {
					bodyForDisplay = record.result?.trim() || "No output."
					output += bodyForDisplay
				}

				if (record.status !== "running" && record.status !== "queued") {
					record.resultConsumed = true
					cancelNudge(params.agent_id as string)
				}

				if (params.verbose && record.session) {
					const conversation = getAgentConversation(record.session)
					if (conversation) {
						const verboseTail = `\n\n--- Agent Conversation ---\n${conversation}`
						output += verboseTail
						bodyForDisplay += verboseTail
					}
				}

				const completedAt = record.completedAt ?? Date.now()
				const durationMs = record.startedAt != null ? completedAt - record.startedAt : undefined
				const details: GetSubagentResultDetails = {
					agentId: record.id,
					displayName,
					description: record.description,
					status: record.status,
					visibility: record.visibility,
					abortReason: record.abortReason,
					toolUses: record.toolUses,
					tokens,
					contextPercent,
					compactionCount: record.compactionCount,
					durationMs,
					error: record.error,
					bodyText: formatAgentBodyForDisplay(bodyForDisplay),
				}

				return textResult(output, details)
			},
		}),
	)

	// ---- steer_subagent tool ----

	pi.registerTool(
		defineTool({
			name: "steer_subagent",
			label: "Steer Agent",
			description:
				"Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
				"and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to steer (must be currently running).",
				}),
				message: Type.String({
					description: "The steering message to send. This will appear as a user message in the agent's conversation.",
				}),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
				const record = manager.getRecord(params.agent_id as string)
				if (!record) {
					return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`)
				}
				if (record.status !== "running") {
					return textResult(
						`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`,
					)
				}
				if (!record.session) {
					if (!record.pendingSteers) record.pendingSteers = []
					record.pendingSteers.push(params.message as string)
					pi.events.emit("subagents:steered", { id: record.id, message: params.message })
					return textResult(
						`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
					)
				}

				try {
					await steerAgent(record.session, params.message as string)
					pi.events.emit("subagents:steered", { id: record.id, message: params.message })
					const tokens = formatLifetimeTokens(record)
					const contextPercent = getSessionContextPercent(record.session)
					const stateParts: string[] = []
					if (tokens) stateParts.push(tokens)
					stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`)
					if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`)
					if (record.compactionCount)
						stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`)
					return textResult(
						`Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
							`Current state: ${stateParts.join(" · ")}`,
					)
				} catch (err) {
					return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`)
				}
			},
		}),
	)

	// ---- /agents interactive menu ----

	const projectAgentsDir = () => join(process.cwd(), ".kimchi", "agents")
	const personalAgentsDir = () => join(getAgentDir(), "agents")

	function findAgentFile(name: string): { path: string; location: "project" | "personal" } | undefined {
		const projectPath = join(projectAgentsDir(), `${name}.md`)
		if (existsSync(projectPath)) return { path: projectPath, location: "project" }
		const personalPath = join(personalAgentsDir(), `${name}.md`)
		if (existsSync(personalPath)) return { path: personalPath, location: "personal" }
		return undefined
	}

	/** Max number of models to display in the /agents menu list. */
	const MAX_MODELS_IN_MENU = 5

	function getModelLabel(type: string, registry?: ModelRegistry): string {
		const cfg = getAgentConfig(type)
		if (!cfg?.models?.length) return "inherit"
		if (registry) {
			// Probe the first entry — if even that doesn't resolve, the agent
			// will inherit the parent's model anyway.
			const resolvedM = resolveModel(cfg.models[0], registry)
			if (typeof resolvedM === "string") return "inherit"
		}
		const visible = cfg.models.slice(0, MAX_MODELS_IN_MENU).map((m) => getModelLabelFromConfig(m))
		const overflow = cfg.models.length - visible.length
		const list = visible.join(" | ")
		return overflow > 0 ? `${list} (+${overflow} more)` : list
	}

	async function showAgentsMenu(ctx: ExtensionCommandContext) {
		reloadCustomAgents()
		const allNames = getAllTypes()

		const options: string[] = []

		const agents = listUserVisibleAgents()
		if (agents.length > 0) {
			const running = agents.filter((a) => a.status === "running" || a.status === "queued").length
			const done = agents.filter((a) => a.status === "completed" || a.status === "steered").length
			options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`)
		}

		if (allNames.length > 0) {
			options.push(`Agent types (${allNames.length})`)
		}

		options.push("Create new agent")
		options.push("Settings")

		const noAgentsMsg =
			allNames.length === 0 && agents.length === 0
				? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
					"Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
					"Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
				: ""

		if (noAgentsMsg) {
			ctx.ui.notify(noAgentsMsg, "info")
		}

		const choice = await ctx.ui.select("Agents", options)
		if (!choice) return

		if (choice.startsWith("Running agents (")) {
			await showRunningAgents(ctx)
			await showAgentsMenu(ctx)
		} else if (choice.startsWith("Agent types (")) {
			await showAllAgentsList(ctx)
			await showAgentsMenu(ctx)
		} else if (choice === "Create new agent") {
			await showCreateWizard(ctx)
		} else if (choice === "Settings") {
			await showSettings(ctx)
			await showAgentsMenu(ctx)
		}
	}

	async function showAllAgentsList(ctx: ExtensionCommandContext) {
		const allNames = getAllTypes()
		if (allNames.length === 0) {
			ctx.ui.notify("No agents.", "info")
			return
		}

		const sourceIndicator = (cfg: AgentConfig | undefined) => {
			const disabled = cfg?.enabled === false
			if (cfg?.source === "project") return disabled ? "✕• " : "•  "
			if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  "
			if (disabled) return "✕  "
			return "   "
		}

		const entries = allNames.map((name) => {
			const cfg = getAgentConfig(name)
			const disabled = cfg?.enabled === false
			const model = getModelLabel(name, ctx.modelRegistry as ModelRegistry)
			const indicator = sourceIndicator(cfg)
			const prefix = `${indicator}${name} · ${model}`
			const desc = disabled ? "(disabled)" : (cfg?.description ?? name)
			return { name, prefix, desc }
		})
		const maxPrefix = Math.max(...entries.map((e) => e.prefix.length))

		const hasCustom = allNames.some((n) => {
			const c = getAgentConfig(n)
			return c && !c.isDefault && c.enabled !== false
		})
		const hasDisabled = allNames.some((n) => getAgentConfig(n)?.enabled === false)
		const legendParts: string[] = []
		if (hasCustom) legendParts.push("• = project  ◦ = global")
		if (hasDisabled) legendParts.push("✕ = disabled")
		const legend = legendParts.length ? `\n${legendParts.join("  ")}` : ""

		const options = entries.map(({ prefix, desc }) => `${prefix.padEnd(maxPrefix)} — ${desc}`)
		if (legend) options.push(legend)

		const choice = await ctx.ui.select("Agent types", options)
		if (!choice) return

		const agentName = choice
			.split(" · ")[0]
			.replace(/^[•◦✕\s]+/, "")
			.trim()
		if (getAgentConfig(agentName)) {
			await showAgentDetail(ctx, agentName)
			await showAllAgentsList(ctx)
		}
	}

	async function showRunningAgents(ctx: ExtensionCommandContext) {
		const agents = listUserVisibleAgents()
		if (agents.length === 0) {
			ctx.ui.notify("No agents.", "info")
			return
		}

		const options = agents.map((a) => {
			const dn = getDisplayName(a.type)
			const dur = formatDuration(a.startedAt, a.completedAt)
			return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`
		})

		const choice = await ctx.ui.select("Running agents", options)
		if (!choice) return

		const idx = options.indexOf(choice)
		if (idx < 0) return
		const record = agents[idx]

		await viewAgentConversation(ctx, record)
		await showRunningAgents(ctx)
	}

	async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
		if (!record.session) {
			ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info")
			return
		}

		const { ConversationViewer } = await import("./ui/conversation-viewer.js")
		const session = record.session
		const activity = agentActivity.get(record.id)

		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) => {
				return new ConversationViewer(tui, session, record, activity, theme, done)
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%" },
			},
		)
	}

	async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
		const cfg = getAgentConfig(name)
		if (!cfg) {
			ctx.ui.notify(`Agent config not found for "${name}".`, "warning")
			return
		}

		const file = findAgentFile(name)
		const isDefault = cfg.isDefault === true
		const disabled = cfg.enabled === false

		let menuOptions: string[]
		if (disabled && file) {
			menuOptions = isDefault
				? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
				: ["Enable", "Edit", "Delete", "Back"]
		} else if (isDefault && !file) {
			menuOptions = ["Eject (export as .md)", "Disable", "Back"]
		} else if (isDefault && file) {
			menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"]
		} else {
			menuOptions = ["Edit", "Disable", "Delete", "Back"]
		}

		const choice = await ctx.ui.select(name, menuOptions)
		if (!choice || choice === "Back") return

		if (choice === "Edit" && file) {
			const content = readFileSync(file.path, "utf-8")
			const edited = await ctx.ui.editor(`Edit ${name}`, content)
			if (edited !== undefined && edited !== content) {
				const { writeFileSync } = await import("node:fs")
				writeFileSync(file.path, edited, "utf-8")
				reloadCustomAgents()
				ctx.ui.notify(`Updated ${file.path}`, "info")
			}
		} else if (choice === "Delete") {
			if (file) {
				const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`)
				if (confirmed) {
					unlinkSync(file.path)
					reloadCustomAgents()
					ctx.ui.notify(`Deleted ${file.path}`, "info")
				}
			}
		} else if (choice === "Reset to default" && file) {
			const confirmed = await ctx.ui.confirm(
				"Reset to default",
				`Delete override ${file.path} and restore embedded default?`,
			)
			if (confirmed) {
				unlinkSync(file.path)
				reloadCustomAgents()
				ctx.ui.notify(`Restored default ${name}`, "info")
			}
		} else if (choice.startsWith("Eject")) {
			await ejectAgent(ctx, name, cfg)
		} else if (choice === "Disable") {
			await disableAgent(ctx, name)
		} else if (choice === "Enable") {
			await enableAgent(ctx, name)
		}
	}

	async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
		const location = await ctx.ui.select("Choose location", [
			"Project (.kimchi/agents/)",
			`Personal (${personalAgentsDir()})`,
		])
		if (!location) return

		const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir()
		mkdirSync(targetDir, { recursive: true })

		const targetPath = join(targetDir, `${name}.md`)
		if (existsSync(targetPath)) {
			const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`)
			if (!overwrite) return
		}

		const fmFields: string[] = []
		fmFields.push(`description: ${cfg.description}`)
		if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`)
		fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`)
		if (cfg.models?.length) fmFields.push(`models: [${cfg.models.map((m) => `"${m}"`).join(", ")}]`)
		if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`)
		if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`)
		fmFields.push(`prompt_mode: ${cfg.promptMode}`)
		if (cfg.extensions === false) fmFields.push("extensions: false")
		else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`)
		if (cfg.skills === false) fmFields.push("skills: false")
		else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`)
		if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`)
		if (cfg.inheritContext) fmFields.push("inherit_context: true")
		if (cfg.runInBackground) fmFields.push("run_in_background: true")
		if (cfg.isolated) fmFields.push("isolated: true")
		if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`)
		if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`)

		const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`

		const { writeFileSync } = await import("node:fs")
		writeFileSync(targetPath, content, "utf-8")
		reloadCustomAgents()
		ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info")
	}

	async function disableAgent(ctx: ExtensionCommandContext, name: string) {
		const file = findAgentFile(name)
		if (file) {
			const content = readFileSync(file.path, "utf-8")
			if (content.includes("\nenabled: false\n")) {
				ctx.ui.notify(`${name} is already disabled.`, "info")
				return
			}
			const updated = content.replace(/^---\n/, "---\nenabled: false\n")
			const { writeFileSync } = await import("node:fs")
			writeFileSync(file.path, updated, "utf-8")
			reloadCustomAgents()
			ctx.ui.notify(`Disabled ${name} (${file.path})`, "info")
			return
		}

		const location = await ctx.ui.select("Choose location", [
			"Project (.kimchi/agents/)",
			`Personal (${personalAgentsDir()})`,
		])
		if (!location) return

		const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir()
		mkdirSync(targetDir, { recursive: true })

		const targetPath = join(targetDir, `${name}.md`)
		const { writeFileSync } = await import("node:fs")
		writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8")
		reloadCustomAgents()
		ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info")
	}

	async function enableAgent(ctx: ExtensionCommandContext, name: string) {
		const file = findAgentFile(name)
		if (!file) return

		const content = readFileSync(file.path, "utf-8")
		const updated = content.replace(/^(---\n)enabled: false\n/, "$1")
		const { writeFileSync } = await import("node:fs")

		if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
			unlinkSync(file.path)
			reloadCustomAgents()
			ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info")
		} else {
			writeFileSync(file.path, updated, "utf-8")
			reloadCustomAgents()
			ctx.ui.notify(`Enabled ${name} (${file.path})`, "info")
		}
	}

	async function showCreateWizard(ctx: ExtensionCommandContext) {
		const location = await ctx.ui.select("Choose location", [
			"Project (.kimchi/agents/)",
			`Personal (${personalAgentsDir()})`,
		])
		if (!location) return

		const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir()

		const method = await ctx.ui.select("Creation method", ["Generate with AI (recommended)", "Manual configuration"])
		if (!method) return

		if (method.startsWith("Generate")) {
			await showGenerateWizard(ctx, targetDir)
		} else {
			await showManualWizard(ctx, targetDir)
		}
	}

	async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
		const description = await ctx.ui.input("Describe what this agent should do")
		if (!description) return

		const name = await ctx.ui.input("Agent name (filename, no spaces)")
		if (!name) return

		mkdirSync(targetDir, { recursive: true })

		const targetPath = join(targetDir, `${name}.md`)
		if (existsSync(targetPath)) {
			const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`)
			if (!overwrite) return
		}

		ctx.ui.notify("Generating agent definition...", "info")

		const generatePrompt = `Create a custom kimchi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
models: <optional ordered list of models, e.g. ["kimchi-dev/minimax-m2.7"]. Omit to inherit parent model>
thinking: <optional thinking level: off, minimal, low, medium, high, xhigh. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
token_budget: <optional maximum total tokens for this agent. Omit for no profile budget>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <true to run in background by default. Default: false>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
---

<system prompt body — instructions for the agent>
\`\`\`

Write the file using the write tool. Only write the file, nothing else.`

		const record = await manager.spawnAndWait(pi, ctx as ExtensionContext, AGENT_GENERAL_PURPOSE, generatePrompt, {
			description: `Generate ${name} agent`,
			maxTurns: 5,
		})

		if (record.status === "error") {
			ctx.ui.notify(`Generation failed: ${record.error}`, "warning")
			return
		}

		reloadCustomAgents()

		if (existsSync(targetPath)) {
			ctx.ui.notify(`Created ${targetPath}`, "info")
		} else {
			ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning")
		}
	}

	async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
		const name = await ctx.ui.input("Agent name (filename, no spaces)")
		if (!name) return

		const description = await ctx.ui.input("Description (one line)")
		if (!description) return

		const toolChoice = await ctx.ui.select("Tools", [
			"all",
			"none",
			"read-only (read, bash, grep, find, ls)",
			"custom...",
		])
		if (!toolChoice) return

		let tools: string
		if (toolChoice === "all") {
			tools = BUILTIN_TOOL_NAMES.join(", ")
		} else if (toolChoice === "none") {
			tools = "none"
		} else if (toolChoice.startsWith("read-only")) {
			tools = "read, bash, grep, find, ls"
		} else {
			const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "))
			if (!customTools) return
			tools = customTools
		}

		const wizardModelChoices = Array.from(MODEL_CAPABILITIES.entries())
			.filter(([, entry]) => entry !== "ignored")
			.map(([id]) => id)
			.sort()

		const modelChoice = await ctx.ui.select("Model", ["inherit (parent model)", ...wizardModelChoices, "custom..."])
		if (!modelChoice) return

		let modelLine = ""
		if (wizardModelChoices.includes(modelChoice)) {
			modelLine = `\nmodels: ["${KIMCHI_DEV_PROVIDER}/${modelChoice}"]`
		} else if (modelChoice === "custom...") {
			const customModel = await ctx.ui.input("Model (provider/modelId)")
			if (customModel) modelLine = `\nmodels: ["${customModel}"]`
		}

		const thinkingChoice = await ctx.ui.select("Thinking level", [
			"inherit",
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		])
		if (!thinkingChoice) return

		let thinkingLine = ""
		if (thinkingChoice !== "inherit") thinkingLine = `\nthinking: ${thinkingChoice}`

		const maxTurnsInput = await ctx.ui.input("Max turns (optional, blank for unlimited)", "")
		let maxTurnsLine = ""
		if (maxTurnsInput?.trim()) {
			const trimmed = maxTurnsInput.trim()
			if (!/^\d+$/.test(trimmed)) {
				ctx.ui.notify("Max turns must be a non-negative integer.", "warning")
				return
			}
			const maxTurns = Number.parseInt(trimmed, 10)
			maxTurnsLine = `\nmax_turns: ${maxTurns}`
		}

		const tokenBudgetInput = await ctx.ui.input("Token budget (optional, blank for none)", "")
		let tokenBudgetLine = ""
		if (tokenBudgetInput?.trim()) {
			const trimmed = tokenBudgetInput.trim()
			if (!/^\d+$/.test(trimmed)) {
				ctx.ui.notify("Token budget must be a positive integer.", "warning")
				return
			}
			const tokenBudget = Number.parseInt(trimmed, 10)
			if (tokenBudget <= 0) {
				ctx.ui.notify("Token budget must be a positive integer.", "warning")
				return
			}
			tokenBudgetLine = `\ntoken_budget: ${tokenBudget}`
		}

		const systemPrompt = await ctx.ui.editor("System prompt", "")
		if (systemPrompt === undefined) return

		const content = `---
description: ${description}
tools: ${tools}${modelLine}${thinkingLine}${maxTurnsLine}${tokenBudgetLine}
prompt_mode: replace
---

${systemPrompt}
`

		mkdirSync(targetDir, { recursive: true })
		const targetPath = join(targetDir, `${name}.md`)

		if (existsSync(targetPath)) {
			const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`)
			if (!overwrite) return
		}

		const { writeFileSync } = await import("node:fs")
		writeFileSync(targetPath, content, "utf-8")
		reloadCustomAgents()
		ctx.ui.notify(`Created ${targetPath}`, "info")
	}

	function snapshotSettings(): SubagentsSettings {
		return {
			maxConcurrent: manager.getMaxConcurrent(),
			defaultMaxTurns: getDefaultMaxTurns() ?? 0,
			graceTurns: getGraceTurns(),
			defaultJoinMode: getDefaultJoinMode(),
		}
	}

	async function showSettings(ctx: ExtensionCommandContext) {
		const choice = await ctx.ui.select("Settings", [
			`Max concurrency (current: ${manager.getMaxConcurrent()})`,
			`Default max turns (current: ${getDefaultMaxTurns() ?? "unlimited"})`,
			`Grace turns (current: ${getGraceTurns()})`,
			`Join mode (current: ${getDefaultJoinMode()})`,
		])
		if (!choice) return

		if (choice.startsWith("Max concurrency")) {
			const val = await ctx.ui.input("Max concurrent background agents", String(manager.getMaxConcurrent()))
			if (val) {
				const n = Number.parseInt(val, 10)
				if (n >= 1) {
					manager.setMaxConcurrent(n)
					notifyApplied(ctx, `Max concurrency set to ${n}`)
				} else {
					ctx.ui.notify("Must be a positive integer.", "warning")
				}
			}
		} else if (choice.startsWith("Default max turns")) {
			const val = await ctx.ui.input(
				"Default max turns before wrap-up (0 = unlimited)",
				String(getDefaultMaxTurns() ?? 0),
			)
			if (val) {
				const n = Number.parseInt(val, 10)
				if (n === 0) {
					setDefaultMaxTurns(undefined)
					notifyApplied(ctx, "Default max turns set to unlimited")
				} else if (n >= 1) {
					setDefaultMaxTurns(n)
					notifyApplied(ctx, `Default max turns set to ${n}`)
				} else {
					ctx.ui.notify("Must be 0 (unlimited) or a positive integer.", "warning")
				}
			}
		} else if (choice.startsWith("Grace turns")) {
			const val = await ctx.ui.input("Grace turns after wrap-up steer", String(getGraceTurns()))
			if (val) {
				const n = Number.parseInt(val, 10)
				if (n >= 1) {
					setGraceTurns(n)
					notifyApplied(ctx, `Grace turns set to ${n}`)
				} else {
					ctx.ui.notify("Must be a positive integer.", "warning")
				}
			}
		} else if (choice.startsWith("Join mode")) {
			const val = await ctx.ui.select("Default join mode for background agents", [
				"smart — auto-group 2+ agents in same turn (default)",
				"async — always notify individually",
				"group — always group background agents",
			])
			if (val) {
				const mode = val.split(" ")[0] as JoinMode
				setDefaultJoinMode(mode)
				notifyApplied(ctx, `Default join mode set to ${mode}`)
			}
		}
	}

	function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
		const { message, level } = saveAndEmitChanged(snapshotSettings(), successMsg, (event, payload) =>
			pi.events.emit(event, payload),
		)
		ctx.ui.notify(message, level)
	}

	pi.registerCommand("agents", {
		description: "Manage agents",
		handler: async (_args, ctx) => {
			await showAgentsMenu(ctx)
		},
	})
}
