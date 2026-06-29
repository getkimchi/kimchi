import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import {
	appendTodoPromptBlockIfMissing,
	registerTodoPromptBlock,
	registerTodoStateBlock,
	setCurrentSessionHasUI,
} from "./prompt-block.js"
import { getTodosForScope, resolveTodoScope, restoreTodoStoreFromDetails, subscribeTodoStore } from "./store.js"
import { TODO_TOOL_NAMES, registerTodosTool } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type TodoItem, type WriteTodosDetails } from "./types.js"
import {
	disposeTodoWidget,
	ensureTodoWidget,
	registerTodoShortcut,
	resetTodoWidgetState,
	syncTodoWidget,
} from "./widget.js"

export * from "./types.js"
export * from "./reducer.js"
export * from "./constants.js"
export * from "./store.js"
export * from "./tool.js"
export * from "./widget.js"
export * from "./command.js"
export * from "./prompt-block.js"

export const TODO_RECONCILE_MESSAGE =
	"Internal hidden todo checkpoint. You are about to stop while the session todo list still needs reconciliation. You must use the todo tools before any user-facing wrap-up. Make the list match reality: mark completed work completed; keep real remaining work pending/in_progress; mark blocked work blocked; clear obsolete or fully done lists. If work is impossible, unavailable, or cannot proceed now, mark it blocked instead of continuing indefinitely. Do not tell the user about this checkpoint or mention that you are clearing or updating todos."
export const TODO_CHECKPOINT_MESSAGE =
	"Internal hidden todo checkpoint. You changed state since the session todo list was last updated. You must use the todo tools before switching tasks or answering finally. Make the list match reality: mark completed work completed; keep real remaining work pending/in_progress; mark blocked work blocked; clear obsolete or fully done lists. If work is impossible, unavailable, or cannot proceed now, mark it blocked instead of continuing indefinitely. Do not tell the user about this checkpoint or mention that you are clearing or updating todos."
export const TODO_BLOCKED_QUESTIONS_MESSAGE =
	"Internal hidden todo blocker checkpoint. The assistant is about to stop while blocked todos need user input. Call the real questionnaire tool with the JSON below before any user-facing wrap-up. After the user answers, update the matching blocked todos and continue. If the user cancels or gives no answer, keep the todos blocked and explain the blocker briefly."

type TodoQuestionType = "text" | "confirm" | "single" | "multi"
type TodoQuestionAskPolicy = "now" | "before_final" | "later"

interface TodoQuestionOption {
	id: string
	label: string
	description?: string
}

interface TodoQuestion {
	id: string
	label: string
	prompt: string
	type: TodoQuestionType
	options?: TodoQuestionOption[]
	allowOther?: boolean
	required?: boolean
}

interface TodoQuestionRequest {
	question: TodoQuestion
	ask: TodoQuestionAskPolicy
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function normalizedText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const text = value.trim().replace(/\s+/g, " ")
	return text.length > 0 ? text : undefined
}

function normalizedQuestionType(value: unknown): TodoQuestionType {
	if (value === "confirm" || value === "single" || value === "multi") return value
	return "text"
}

function normalizedAskPolicy(value: unknown): TodoQuestionAskPolicy {
	if (value === "now" || value === "later") return value
	return "before_final"
}

function normalizedQuestionOptions(value: unknown): TodoQuestionOption[] | undefined {
	if (!Array.isArray(value)) return undefined
	const options = value
		.map((option, index): TodoQuestionOption | undefined => {
			if (typeof option === "string") {
				const label = normalizedText(option)
				return label ? { id: `option_${index + 1}`, label } : undefined
			}
			if (!isRecord(option)) return undefined
			const label = normalizedText(option.label)
			if (!label) return undefined
			return {
				id: normalizedText(option.id) ?? `option_${index + 1}`,
				label,
				...(normalizedText(option.description) ? { description: normalizedText(option.description) } : {}),
			}
		})
		.filter((option) => option !== undefined)
	return options.length > 0 ? options : undefined
}

function parseTodoQuestion(todo: TodoItem): TodoQuestionRequest | undefined {
	if (todo.status !== "blocked" || !todo.note) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(todo.note)
	} catch {
		return undefined
	}
	const question = isRecord(parsed) ? parsed.question : undefined
	if (!isRecord(question)) return undefined
	const type = normalizedQuestionType(question.type)
	const options = normalizedQuestionOptions(question.options)
	if ((type === "single" || type === "multi") && !options) return undefined
	return {
		ask: normalizedAskPolicy(isRecord(parsed) ? parsed.ask : undefined),
		question: {
			id: `todo_${todo.id}`,
			label: normalizedText(question.label) ?? todo.content,
			prompt: normalizedText(question.prompt) ?? `Please provide: ${todo.content}`,
			type,
			...(options ? { options } : {}),
			...(type !== "confirm" && typeof question.allowOther === "boolean" ? { allowOther: question.allowOther } : {}),
			...(typeof question.required === "boolean" ? { required: question.required } : {}),
		},
	}
}

function isWriteTodosDetails(value: unknown): value is WriteTodosDetails {
	return (
		isRecord(value) &&
		value.schemaVersion === TODO_TOOL_RESULT_SCHEMA_VERSION &&
		value.scope !== undefined &&
		Array.isArray(value.todos)
	)
}

const TODO_REPLAY_TOOL_NAME_SET = new Set<string>([...TODO_TOOL_NAMES, "write_todos"])

function getWriteTodosDetails(entry: SessionEntry): WriteTodosDetails | undefined {
	if (entry.type === "custom" && entry.customType === TODO_CUSTOM_ENTRY_TYPE) {
		return isWriteTodosDetails(entry.data) ? entry.data : undefined
	}

	if (entry.type === "message") {
		const message = entry.message as unknown
		if (!isRecord(message)) return undefined
		if (message.role !== "toolResult" || !TODO_REPLAY_TOOL_NAME_SET.has(String(message.toolName))) return undefined
		return isWriteTodosDetails(message.details) ? message.details : undefined
	}

	return undefined
}

export function restoreTodoStoreFromSessionEntries(entries: readonly SessionEntry[]): void {
	restoreTodoStoreFromDetails(entries.map(getWriteTodosDetails).filter((details) => details !== undefined))
}

function currentTodoStateKey(): string | undefined {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope)
	if (todos.length === 0) return undefined
	return JSON.stringify({ scope, todos: todos.map((todo) => [todo.id, todo.status, todo.content]) })
}

function currentTodoStateText(): string | undefined {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope)
	if (todos.length === 0) return undefined
	const scopeText = scope.kind === "global" ? "global" : JSON.stringify(scope)
	return [
		`Current todos (${scopeText}):`,
		...todos.map((todo) => `- #${todo.id} [${todo.status}] ${todo.content}`),
	].join("\n")
}

function currentBlockedTodoQuestionFollowUp(
	askPolicies: readonly TodoQuestionAskPolicy[],
): { key: string; text: string } | undefined {
	const scope = resolveTodoScope()
	if (scope.kind !== "global") return undefined
	const allowedPolicies = new Set(askPolicies)
	const questions = getTodosForScope(scope)
		.map(parseTodoQuestion)
		.flatMap((request) => (request && allowedPolicies.has(request.ask) ? [request.question] : []))
	if (questions.length === 0) return undefined
	const payload = {
		header: "Blocked todos need your input",
		questions,
	}
	return {
		key: JSON.stringify({ scope, questions }),
		text: `${TODO_BLOCKED_QUESTIONS_MESSAGE}\n\n${JSON.stringify(payload)}`,
	}
}

function hiddenTodoMessage(reason: string, text: string) {
	return {
		customType: TODO_CUSTOM_ENTRY_TYPE,
		content: [{ type: "text" as const, text }],
		display: false,
		details: { reason },
	}
}

function hasVisibleText(message: unknown): boolean {
	if (!isRecord(message)) return false
	const content = message.content
	if (!Array.isArray(content)) return false
	return content.some(
		(part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim(),
	)
}

function isTerminalAssistantTurn(
	event: { message: unknown; toolResults: readonly unknown[] },
	ctx: ExtensionContext,
): boolean {
	if (event.toolResults.length > 0 || ctx.hasPendingMessages?.()) return false
	const message = event.message
	if (!isRecord(message) || message.role !== "assistant") return false
	return message.stopReason !== "aborted" && message.stopReason !== "error"
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return isRecord(message) && message.role === "assistant" && Array.isArray(message.content)
}

function hasAssistantToolCall(message: AssistantMessage): boolean {
	return message.content.some((block) => block.type === "toolCall")
}

function isFinalAnswerCandidate(message: AssistantMessage): boolean {
	return message.stopReason !== "toolUse" && message.stopReason !== "aborted" && message.stopReason !== "error"
}

function clearAssistantText(message: AssistantMessage): void {
	for (const block of message.content) {
		if (block.type === "text") block.text = ""
	}
}

function assistantWithoutText(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.filter((block) => block.type !== "text"),
	}
}

export default function todosExtension(pi: ExtensionAPI): void {
	registerTodosTool(pi)
	registerTodoPromptBlock(pi)
	pi.on("before_agent_start", (event) => {
		const systemPrompt = appendTodoPromptBlockIfMissing(event.systemPrompt)
		return systemPrompt ? { systemPrompt } : undefined
	})

	if (isAgentWorker()) return

	let latestCtx: ExtensionContext | undefined
	let unsubscribeTodoStore: (() => void) | undefined
	let workSinceTodoWrite = false
	let suppressedFinalAssistantText = false
	let lastBlockedTodoQuestionKey: string | undefined

	const resetTodoProcessState = () => {
		workSinceTodoWrite = false
		suppressedFinalAssistantText = false
		lastBlockedTodoQuestionKey = undefined
	}

	const hasPendingTodoReconciliation = () => workSinceTodoWrite && currentTodoStateKey() !== undefined

	const maybeSteerTodoReconciliation = (message: unknown) => {
		if (!workSinceTodoWrite) return
		if (!hasVisibleText(message) && !suppressedFinalAssistantText) return
		if (!currentTodoStateKey()) {
			resetTodoProcessState()
			return
		}
		const stateText = currentTodoStateText()
		const promptText = stateText ? `${TODO_RECONCILE_MESSAGE}\n\n${stateText}` : TODO_RECONCILE_MESSAGE
		pi.sendMessage(hiddenTodoMessage("reconcile_todos", promptText), { deliverAs: "followUp" })
		suppressedFinalAssistantText = false
	}

	const queueBlockedTodoQuestions = (askPolicies: readonly TodoQuestionAskPolicy[]) => {
		if (!latestCtx?.hasUI) {
			lastBlockedTodoQuestionKey = undefined
			return false
		}
		const followUp = currentBlockedTodoQuestionFollowUp(askPolicies)
		if (!followUp) {
			lastBlockedTodoQuestionKey = undefined
			return false
		}
		if (followUp.key === lastBlockedTodoQuestionKey) return false
		lastBlockedTodoQuestionKey = followUp.key
		pi.sendMessage(hiddenTodoMessage("blocked_todo_questions", followUp.text), { deliverAs: "followUp" })
		suppressedFinalAssistantText = false
		return true
	}

	const maybeAskBlockedTodoQuestions = (message: unknown) => {
		if (!hasVisibleText(message) && !suppressedFinalAssistantText) return false
		return queueBlockedTodoQuestions(["before_final"])
	}

	registerTodosCommand(pi)
	registerTodoShortcut(pi)
	// Headless (one-shot) runs have no widget; the todo-state prompt block
	// renders the same content as markdown so the orchestrator agent can see
	// it. Self-gates on currentSessionHasUI inside the block's render fn.
	registerTodoStateBlock(pi)

	const replayAndSync = (ctx: ExtensionContext) => {
		latestCtx = ctx
		restoreTodoStoreFromSessionEntries(ctx.sessionManager.getBranch())
		resetTodoProcessState()
		syncTodoWidget(ctx)
	}

	pi.on("session_start", (_event, ctx) => {
		resetTodoProcessState()
		resetTodoWidgetState()
		ensureTodoWidget(ctx)
		setCurrentSessionHasUI(ctx.hasUI)
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = subscribeTodoStore(() => {
			workSinceTodoWrite = false
			queueBlockedTodoQuestions(["now"])
			if (!latestCtx?.hasUI) return
			syncTodoWidget(latestCtx)
		})
		replayAndSync(ctx)
	})

	pi.on("session_tree", (_event, ctx) => {
		replayAndSync(ctx)
	})

	pi.on("tool_execution_end", (event) => {
		if (event.isError || TODO_REPLAY_TOOL_NAME_SET.has(event.toolName)) return
		if (currentTodoStateKey()) workSinceTodoWrite = true
	})

	pi.on("message_update", (event) => {
		if (!hasPendingTodoReconciliation() || !isAssistantMessage(event.message)) return
		if (hasAssistantToolCall(event.message) || !isFinalAnswerCandidate(event.message)) return
		suppressedFinalAssistantText = true
		clearAssistantText(event.message)
	})

	pi.on("message_end", (event) => {
		if (!hasPendingTodoReconciliation() || !isAssistantMessage(event.message)) return
		if (hasAssistantToolCall(event.message) || !isFinalAnswerCandidate(event.message)) return
		suppressedFinalAssistantText = true
		clearAssistantText(event.message)
		return { message: assistantWithoutText(event.message) }
	})

	pi.on("context", (event) => {
		if (!workSinceTodoWrite) return undefined
		const stateText = currentTodoStateText()
		if (!stateText) return resetTodoProcessState()
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					...hiddenTodoMessage("todo_checkpoint", `${TODO_CHECKPOINT_MESSAGE}\n\n${stateText}`),
					timestamp: Date.now(),
				},
			],
		}
	})

	pi.on("turn_end", (event, ctx) => {
		if (!isTerminalAssistantTurn(event, ctx)) return
		syncTodoWidget(ctx)
		if (maybeAskBlockedTodoQuestions(event.message)) return
		maybeSteerTodoReconciliation(event.message)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = undefined
		latestCtx = undefined
		setCurrentSessionHasUI(true)
		disposeTodoWidget(ctx)
	})
}
