import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { isReadOnlyBashCommand } from "./permissions/taxonomy.js"
import { getCurrentPhase } from "./tags.js"

const WRITE_TOOLS = new Set(["edit", "write", "lsp_edit", "lsp_rename"])
const ALWAYS_ALLOWED = new Set(["subagent", "set_phase"])
const READ_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"lsp_hover",
	"lsp_definition",
	"lsp_references",
	"lsp_diagnostics",
	"web_search",
	"web_fetch",
	"mcp",
	"questionnaire",
])
const BASH_GUIDELINE = "All file-mutating operations in build phase must go through the subagent tool."
const POST_FAILURE_GUIDELINE =
	"The most recent subagent failed. Do NOT attempt to implement or complete this work yourself. Spawn a replacement subagent with a corrected or simplified prompt instead."
const VALID_PHASES_WITH_ENFORCEMENT = new Set<Phase>(["build"])

type Phase = "explore" | "plan" | "build" | "review" | "research"

export default function phaseGuardExtension(pi: ExtensionAPI): void {
	// Per-instance mutable state (not module-level)
	let lastSubagentFailed = false
	let failureLogged = false

	pi.on("input", (event) => {
		// Reset failure state on real user input, not extension follow-ups
		if (event.source !== "extension") {
			lastSubagentFailed = false
			failureLogged = false
		}
	})

	pi.on("tool_result", (event) => {
		if (event.toolName === "subagent") {
			lastSubagentFailed = event.isError
			if (lastSubagentFailed && !failureLogged) {
				// Log the *start* of a post-failure window for audit
				failureLogged = true
				pi.appendEntry("phase-guard-subagent-failure", {
					toolCallId: event.toolCallId,
					isError: event.isError,
					timestamp: Date.now(),
					reason: extractFailureReason(event),
				})
			}
		}
	})

	pi.on("tool_call", (event) => {
		const phase = getCurrentPhase()
		if (!phase || !VALID_PHASES_WITH_ENFORCEMENT.has(phase)) return

		const toolName = event.toolName.toLowerCase()

		// Always pass through built-in safe tools
		if (ALWAYS_ALLOWED.has(toolName)) return

		// Block direct write operations in build phase
		if (WRITE_TOOLS.has(toolName)) {
			return blockWrite(
				pi,
				lastSubagentFailed,
				event,
				phase,
				toolName,
				`Tool '${toolName}' is blocked in '${phase}' phase. ${BASH_GUIDELINE}`,
			)
		}

		// Allow read-only research tools
		if (READ_TOOLS.has(toolName)) return

		// Bash: only read-only commands are allowed
		if (toolName === "bash") {
			const command =
				typeof event.input === "object" && event.input !== null && "command" in event.input
					? String(event.input.command)
					: ""
			if (!isReadOnlyBashCommand(command)) {
				return blockWrite(
					pi,
					lastSubagentFailed,
					event,
					phase,
					toolName,
					`Destructive bash command blocked in '${phase}' phase. ${BASH_GUIDELINE}`,
				)
			}
			return
		}

		// Any other unknown custom tool in build phase — default to blocking
		// This catches tools like MCP tools that might do writes.
		return blockWrite(
			pi,
			lastSubagentFailed,
			event,
			phase,
			toolName,
			`Tool '${toolName}' is blocked in '${phase}' phase; only read-only and subagent tools are permitted. ${BASH_GUIDELINE}`,
		)
	})
}

function blockWrite(
	pi: ExtensionAPI,
	lastSubagentFailed: boolean,
	event: ToolCallEvent,
	phase: Phase,
	toolName: string,
	baseReason: string,
): ToolCallEventResult {
	const enrichedReason = lastSubagentFailed ? `${POST_FAILURE_GUIDELINE} ${baseReason}` : baseReason

	// Emit audit entry for forensic analysis
	pi.appendEntry("phase-guard-violation", {
		toolCallId: event.toolCallId,
		toolName,
		phase,
		reason: enrichedReason,
		timestamp: Date.now(),
		postSubagentFailure: lastSubagentFailed,
		details: event.input,
	})

	return { block: true, reason: enrichedReason }
}

function extractFailureReason(event: ToolResultEvent): string | undefined {
	const textParts: string[] = []
	for (const c of event.content) {
		if (c.type === "text") textParts.push(c.text)
	}
	const full = textParts.join("\n")
	// Subagent error JSON contains { reason: ..., detail: ... }
	try {
		const parsed = JSON.parse(full)
		if (parsed && typeof parsed === "object" && "reason" in parsed) {
			return String(parsed.reason)
		}
	} catch {
		// fall through to heuristic
	}
	// Heuristic: look for error markers in the text
	if (full.includes("token_budget_exceeded")) return "token_budget_exceeded"
	if (full.includes("output_stalled")) return "output_stalled"
	if (full.includes("timeout")) return "timeout"
	if (full.includes("exit_error")) return "exit_error"
	return undefined
}
