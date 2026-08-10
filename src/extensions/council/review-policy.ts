import { createHash } from "node:crypto"
import type { Context, ToolCall } from "@earendil-works/pi-ai"
import type { ChangeOperation, ChangeSet } from "../../agent-patch/index.js"
import { classifyBashCommand } from "../bash-tool-guard.js"

const MUTATING_TOOLS = new Set(["edit", "write", "council_delete_file", "council_rename_file"])
const TINY_CANDIDATE_LINE_LIMIT = 10
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc"])
const DOC_FILENAMES = new Set(["README", "CHANGELOG", "CONTRIBUTING", "LICENSE", "NOTICE"])

export function isMutatingCouncilToolCall(toolName: string, args: unknown): boolean {
	if (MUTATING_TOOLS.has(toolName)) return true
	if (toolName !== "bash" || !args || typeof args !== "object" || !("command" in args)) return false
	const command = (args as { command?: unknown }).command
	if (typeof command !== "string") return false
	const category = classifyBashCommand(command)?.category
	return category === "edit" || category === "write"
}

function isMutatingToolCall(call: ToolCall): boolean {
	return isMutatingCouncilToolCall(call.name, call.arguments)
}

export function shouldReviewCouncilTurn(context: Context): boolean {
	let turnStart = 0
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index]
		if (message?.role === "assistant" && message.stopReason !== "toolUse") {
			turnStart = index + 1
			break
		}
	}
	return context.messages.slice(turnStart).some((message) => {
		if (message.role === "toolResult") return !message.isError && MUTATING_TOOLS.has(message.toolName)
		return (
			message.role === "assistant" &&
			message.content.some((block) => block.type === "toolCall" && isMutatingToolCall(block))
		)
	})
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

function extension(path: string): string {
	const name = path.split("/").pop() ?? path
	const index = name.lastIndexOf(".")
	return index === -1 ? "" : name.slice(index).toLowerCase()
}

function isDocumentationPath(path: string): boolean {
	const name = (path.split("/").pop() ?? path).toUpperCase()
	return DOC_FILENAMES.has(name) || DOC_EXTENSIONS.has(extension(path))
}

function baseMode(changeSet: ChangeSet, path: string): number | undefined {
	return changeSet.base.find((entry) => entry.path === path)?.mode
}

function executable(mode: number | undefined): boolean {
	return mode !== undefined && (mode & 0o111) !== 0
}

function changesMode(changeSet: ChangeSet, operation: ChangeOperation): boolean {
	const from = operation.kind === "rename" ? operation.fromPath : operation.path
	const before = baseMode(changeSet, from)
	return operation.mode !== undefined && before !== undefined && operation.mode !== before
}

function touchesExecutable(changeSet: ChangeSet, operation: ChangeOperation): boolean {
	if (operation.kind === "create") return executable(operation.mode)
	const from = operation.kind === "rename" ? operation.fromPath : operation.path
	return executable(baseMode(changeSet, from)) || executable(operation.mode)
}

function isPureRename(changeSet: ChangeSet, operation: ChangeOperation): boolean {
	if (operation.kind !== "rename") return false
	return sha256(operation.content) === operation.baseSha256 && !changesMode(changeSet, operation)
}

function isDocumentationOperation(operation: ChangeOperation): boolean {
	return isDocumentationPath(operation.path) && (operation.kind !== "rename" || isDocumentationPath(operation.fromPath))
}

// Deliberation on a text answer is worth its N+2 model calls only when both the request and the
// lead's answer look substantial; a short question or a short answer never clears the bar. The
// request length is a necessary condition on its own (checked in isolation as
// `mayDeliberateCouncilAnswer`, before the lead has answered) so the coordinator can decide,
// before spending the lead call, whether it is safe to stream the lead's draft live: a request
// below the bar can never end in deliberation, so streaming it is always correct.
const TEXT_DELIBERATION_MIN_REQUEST_CHARS = 40
const TEXT_DELIBERATION_MIN_ANSWER_CHARS = 320
const TEXT_DELIBERATION_MIN_ANSWER_LINES = 4

function lastUserRequestText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index]
		if (message?.role !== "user") continue
		if (typeof message.content === "string") return message.content
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
	}
	return ""
}

function requestLooksSubstantial(requestText: string): boolean {
	return requestText.trim().length >= TEXT_DELIBERATION_MIN_REQUEST_CHARS
}

function answerLooksSubstantial(answerText: string): boolean {
	const answer = answerText.trim()
	if (answer.length < TEXT_DELIBERATION_MIN_ANSWER_CHARS) return false
	const structuredLines = answer.split("\n").filter((line) => line.trim().length > 0).length
	return (
		structuredLines >= TEXT_DELIBERATION_MIN_ANSWER_LINES || answer.length >= TEXT_DELIBERATION_MIN_ANSWER_CHARS * 2
	)
}

/**
 * Cheap pre-check, evaluable before the lead answers: whether the turn's request is substantial
 * enough that deliberation remains *possible*. A request below the bar makes
 * `shouldDeliberateCouncilAnswer` false no matter what the lead answers, so the coordinator can
 * safely stream the lead's draft live whenever this returns false.
 */
export function mayDeliberateCouncilAnswer(context: Context): boolean {
	return requestLooksSubstantial(lastUserRequestText(context))
}

/**
 * The one threshold for whether a text turn warrants the panel/analyst/synthesis pipeline.
 * Trivial or short answers to trivial or short requests return immediately, exactly as an
 * ordinary direct answer does today.
 */
export function shouldDeliberateCouncilAnswer(context: Context, leadAnswerText: string): boolean {
	return requestLooksSubstantial(lastUserRequestText(context)) && answerLooksSubstantial(leadAnswerText)
}

export function shouldReviewCouncilCandidate(changeSet: ChangeSet): boolean {
	if (changeSet.operations.length === 0) return false
	if (changeSet.operations.some((operation) => changesMode(changeSet, operation))) return true
	if (changeSet.operations.every((operation) => isPureRename(changeSet, operation))) return false
	if (changeSet.operations.some((operation) => touchesExecutable(changeSet, operation))) return true
	if (changeSet.operations.some((operation) => operation.kind === "rename" && !isPureRename(changeSet, operation)))
		return true
	if (changeSet.operations.every(isDocumentationOperation)) return false
	if (
		changeSet.stats.files === 1 &&
		changeSet.stats.addedLines + changeSet.stats.removedLines <= TINY_CANDIDATE_LINE_LIMIT
	) {
		return false
	}
	return true
}
