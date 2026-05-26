import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isSubagent } from "./prompt-construction/prompt-enrichment.js"

const PRUNE_THRESHOLD = 35_000
const PROTECT_WINDOW = 30
const MAX_PROTECTED_CHARS = 100_000
const MIN_PRUNE_CHARS = 500

/**
 * Walk backwards through messages to find the cutoff index.
 * Messages at index >= cutoff are kept; messages before cutoff are candidates for pruning.
 *
 * Stops protecting at whichever bound is hit first:
 * - PROTECT_WINDOW messages from the end, OR
 * - Accumulated tool-result chars exceed MAX_PROTECTED_CHARS
 *
 * Returns 0 if everything fits within the protected budget (nothing to prune).
 */
export function computeCutoff(
	messages: ContextEvent["messages"],
	protectWindow: number,
	maxProtectedChars: number,
): number {
	let cutoff = 0
	let protectedChars = 0

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages.length - i > protectWindow) {
			cutoff = i + 1
			break
		}
		const m = messages[i] as ToolResultMessage
		if (m.role === "toolResult") {
			for (const block of m.content) {
				if (block.type === "text") protectedChars += block.text.length
			}
		}
		if (protectedChars > maxProtectedChars) {
			cutoff = i + 1
			break
		}
	}

	// Clamp to last message: if recent outputs blew the char budget, still prune everything
	// older than the final message rather than silently skipping compaction entirely.
	return Math.min(cutoff, Math.max(0, messages.length - 1))
}

/**
 * Find the index of the most recent message with role "user".
 * This ensures the LLM always retains the user's language, tone,
 * and task framing even during long tool-call chains.
 */
function findLastUserMessageIndex(messages: ContextEvent["messages"]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string }
		if (m.role === "user") {
			return i
		}
	}
	return -1
}

/**
 * Return a pruned copy of a ToolResultMessage.
 * - Large text blocks are replaced with a placeholder (preserves all other fields).
 * - Error outputs keep the last 2000 chars so the agent can still read the crash reason.
 * - Non-text content blocks (images, etc.) are left untouched.
 */
export function pruneToolResult(msg: ToolResultMessage, minPruneChars: number): ToolResultMessage {
	return {
		...msg,
		content: msg.content.map((block) => {
			if (block.type !== "text") return block
			if (block.text.length < minPruneChars) return block
			if (msg.isError) {
				const tail = block.text.slice(-2000)
				return {
					...block,
					text: `[compacted: ${msg.toolName} error, ${block.text.length} chars]\n...\n${tail}`,
				}
			}
			return {
				...block,
				text: `[compacted: ${msg.toolName} output, ${block.text.length} chars]`,
			}
		}),
	}
}

export const ACTION_LOG_MARKER = "[Context: earlier steps compacted]"

export interface DroppedTurn {
	assistant: AssistantMessage | null
	results: ToolResultMessage[]
}

export interface DropZonePartition {
	turns: DroppedTurn[]
	passthrough: ContextEvent["messages"]
}

/**
 * Partition messages below `cutoff` into:
 * - `turns`: tool-call assistant messages + their matched toolResult messages (to be dropped)
 * - `passthrough`: everything else (user messages, reasoning-only assistants — never dropped)
 *
 * Key invariant: user messages are NEVER included in `turns`.
 */
export function partitionDropZone(messages: ContextEvent["messages"], cutoff: number): DropZonePartition {
	const zone = messages.slice(0, cutoff)

	const resultsByCallId = new Map<string, ToolResultMessage>()
	for (const msg of zone) {
		const m = msg as ToolResultMessage
		if (m.role === "toolResult") {
			resultsByCallId.set(m.toolCallId, m)
		}
	}

	const turns: DroppedTurn[] = []
	const claimedIds = new Set<string>()
	const droppedAssistants = new Set<ContextEvent["messages"][number]>()

	for (const msg of zone) {
		const m = msg as AssistantMessage
		if (m.role !== "assistant") continue
		const toolCalls = m.content.filter((c): c is ToolCall => c.type === "toolCall")
		if (toolCalls.length === 0) continue // reasoning-only — goes to passthrough
		const results: ToolResultMessage[] = []
		for (const tc of toolCalls) {
			const r = resultsByCallId.get(tc.id)
			if (r) {
				results.push(r)
				claimedIds.add(tc.id)
			}
		}
		turns.push({ assistant: m, results })
		droppedAssistants.add(msg)
	}

	const orphanResults: ToolResultMessage[] = []
	for (const msg of zone) {
		const m = msg as ToolResultMessage
		if (m.role === "toolResult" && !claimedIds.has(m.toolCallId)) {
			orphanResults.push(m)
			claimedIds.add(m.toolCallId)
		}
	}
	if (orphanResults.length > 0) {
		turns.push({ assistant: null, results: orphanResults })
	}

	const droppedResults = new Set(turns.flatMap((t) => t.results))
	const passthrough = zone.filter((msg) => {
		if (droppedAssistants.has(msg)) return false
		if (droppedResults.has(msg as ToolResultMessage)) return false
		return true
	})

	return { turns, passthrough }
}

/**
 * Convenience wrapper — returns only the turns.
 */
export function groupTurnsBeforeCutoff(messages: ContextEvent["messages"], cutoff: number): DroppedTurn[] {
	return partitionDropZone(messages, cutoff).turns
}

function summariseResult(toolName: string, text: string, isError: boolean): string {
	if (isError) return "error"
	const trimmed = text.trim()
	if (!trimmed) {
		if (toolName === "grep") return "No matches found"
		if (toolName === "find") return "No files found"
		return "ok"
	}
	if (trimmed === "No matches found") return "No matches found"
	if (trimmed.startsWith("No files found")) return "No files found"
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		return `${trimmed.length} chars`
	}
	if (toolName === "grep") {
		const lines = trimmed.split("\n").filter(Boolean)
		return `${lines.length} match${lines.length === 1 ? "" : "es"}`
	}
	if (toolName === "find") {
		if (trimmed.startsWith("No files")) return "No files found"
		const lines = trimmed.split("\n").filter(Boolean)
		return `${lines.length} file${lines.length === 1 ? "" : "s"}`
	}
	const lines = trimmed.split("\n")
	return `${lines.length} line${lines.length === 1 ? "" : "s"}`
}

function summariseArgs(args: Record<string, unknown>): string {
	const vals = Object.values(args)
	if (vals.length === 0) return ""
	const first = String(vals[0])
	return first.length > 40 ? `${first.slice(0, 37)}…` : first
}

/**
 * Build a single synthetic user message summarising all dropped turns.
 * If `existingLog` is a previous action log message (detected by ACTION_LOG_MARKER),
 * its lines are prepended so history accumulates across multiple prune cycles.
 */
export function buildActionLog(turns: DroppedTurn[], existingLog?: ContextEvent["messages"][number]): UserMessage {
	const previousLines: string[] = []

	if (existingLog) {
		const m = existingLog as UserMessage
		if (m.role === "user" && Array.isArray(m.content)) {
			const textBlock = m.content.find((c): c is { type: "text"; text: string } => c.type === "text")
			if (textBlock?.text.includes(ACTION_LOG_MARKER)) {
				const lines = textBlock.text.split("\n").filter((l) => l.startsWith("- "))
				previousLines.push(...lines)
			}
		}
	}

	const newLines: string[] = []
	for (const turn of turns) {
		if (!turn.assistant && turn.results.length === 0) continue
		if (!turn.assistant) {
			for (const r of turn.results) {
				const text = (r.content.find((c) => c.type === "text") as { text: string } | undefined)?.text ?? ""
				newLines.push(`- ${r.toolName}(orphaned) → ${summariseResult(r.toolName, text, r.isError)}`)
			}
			continue
		}
		const toolCalls = turn.assistant.content.filter((c): c is ToolCall => c.type === "toolCall")
		if (toolCalls.length === 0) continue
		for (const tc of toolCalls) {
			const result = turn.results.find((r) => r.toolCallId === tc.id)
			const argStr = summariseArgs(tc.arguments)
			const outcomeStr = result
				? summariseResult(
						tc.name,
						(result.content.find((c) => c.type === "text") as { text: string } | undefined)?.text ?? "",
						result.isError,
					)
				: "[no result]"
			newLines.push(`- ${tc.name}(${argStr ? `"${argStr}"` : ""}) → ${outcomeStr}`)
		}
	}

	const allLines = [...previousLines, ...newLines]
	const text = `${ACTION_LOG_MARKER}\n${allLines.join("\n")}`

	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	}
}

export default function contextCompactorExtension(pi: ExtensionAPI) {
	if (isSubagent()) return

	// Closure-scoped: independent per agent instance, safe if multiple are constructed.
	let lastInputTokens = 0

	pi.on("message_end", async (event) => {
		const msg = event.message as AssistantMessage
		if (msg.role !== "assistant") return
		lastInputTokens = msg.usage?.input ?? 0
	})

	pi.on("context", async (event) => {
		if (lastInputTokens < PRUNE_THRESHOLD) return

		const { messages } = event
		const baseCutoff = computeCutoff(messages, PROTECT_WINDOW, MAX_PROTECTED_CHARS)
		if (baseCutoff === 0) return

		// If the most recent user message falls outside the protected window
		// (i.e. it's before `baseCutoff`), extend the window backward so that
		// the user message is still visible. This prevents the model from losing
		// the user's language, tone, or task framing during long tool-call chains.
		const lastUserIndex = findLastUserMessageIndex(messages)
		const cutoff = lastUserIndex >= 0 ? Math.min(baseCutoff, lastUserIndex) : baseCutoff

		let prunedCount = 0
		let totalCharsRemoved = 0

		const pruned = messages.map((msg, i) => {
			if (i >= cutoff) return msg
			// Explicit cast required: AgentMessage = Message | CustomAgentMessages union;
			// role check alone does not narrow to ToolResultMessage in TypeScript.
			const m = msg as ToolResultMessage
			if (m.role !== "toolResult") return msg
			const originalLen = m.content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0)
			const result = pruneToolResult(m, MIN_PRUNE_CHARS)
			const newLen = result.content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0)
			if (newLen < originalLen) {
				prunedCount++
				totalCharsRemoved += originalLen - newLen
			}
			return result
		})

		if (prunedCount > 0) {
			pi.appendEntry("tool_result_pruning", { prunedCount, totalCharsRemoved, cutoff })
		}

		return { messages: pruned }
	})
}
