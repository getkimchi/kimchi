import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DOC_CLI_COMMANDS, DOC_CLI_SKILLS, type DocCliSkill } from "../../documents/doc-cli-skills.js"
import { DOCUMENT_ERROR_CODES, type DocumentErrorCode } from "../../documents/model.js"
import { isDocCliCommand } from "../../permissions/bundled-skill-cli.js"
import { parseCommandSegments, splitLeadingEnv, stripTrailingOutputFilters } from "../../permissions/taxonomy.js"
import type { TelemetryContext } from "../session-context.js"
import type { ToolErrorClassification } from "./tool-error-classification.js"

export interface DocumentCliAttribution {
	documentType: DocCliSkill
	operation: string
}

type DocumentCliOutcome = "success" | "nonzero_exit" | "timeout" | "terminated" | "aborted" | "execution_error"

const DOCUMENT_ERROR_CODE_SET = new Set<string>(DOCUMENT_ERROR_CODES)

function attributionFor(
	skillName: string | undefined,
	operation: string | undefined,
): DocumentCliAttribution | undefined {
	const documentType = DOC_CLI_SKILLS.find((skill) => skill === skillName)
	if (!documentType) return undefined
	return {
		documentType,
		operation: operation && DOC_CLI_COMMANDS[documentType].includes(operation) ? operation : "unknown",
	}
}

/** Attribute only commands whose outcome can be tied to one document CLI
 *  invocation. This is analytics parsing, never a permission decision. */
export function attributeDocumentCliCommand(command: string): DocumentCliAttribution | undefined {
	if (isDocCliCommand(command)) {
		const tokens = parseCommandSegments(command)[0]?.tokens ?? []
		return attributionFor(tokens[2], tokens[3])
	}

	// Documented fallback: node <skill-dir>/scripts/<skill>.mjs <command> ….
	// Keep the same single-command constraints as the primary gate. Leading env
	// assignments are safe to recognize here because permission checks are separate.
	if (!command.trim() || command.includes("$(") || command.includes("`") || /[\r\n]/.test(command)) return undefined
	const rawTokens = parseCommandSegments(command)[0]?.tokens ?? []
	const quotedWhitespace = rawTokens.some((token) => /\s/.test(token))
	const head = quotedWhitespace ? command : (stripTrailingOutputFilters(command) ?? command)
	const { rest } = splitLeadingEnv(head)
	const segments = parseCommandSegments(rest)
	if (segments.length !== 1) return undefined
	for (const op of segments[0].ops) {
		if (!(op.op === ">&" && op.target && /^[0-9]+$/.test(op.target))) return undefined
	}

	const tokens = segments[0].tokens
	if (tokens[0] !== "node") return undefined
	const script = tokens[1]?.match(/[\\/]scripts[\\/](pdf|docx|xlsx|pptx)\.mjs$/)
	if (!script) return undefined
	return attributionFor(script[1], tokens[2])
}

/** Extract only the typed, closed document error vocabulary from CLI output. */
export function extractDocumentErrorCode(resultText: string): DocumentErrorCode | undefined {
	for (const match of resultText.matchAll(/(?:^|\n)error \[([a-z-]+)\]:/g)) {
		const code = match[1]
		if (code && DOCUMENT_ERROR_CODE_SET.has(code)) return code as DocumentErrorCode
	}
	return undefined
}

function resolveOutcome(
	isError: boolean | undefined,
	classification: ToolErrorClassification | undefined,
): DocumentCliOutcome | undefined {
	if (!isError || !classification) return "success"
	switch (classification.kind) {
		case "command_outcome":
			return classification.commandOutcome
		case "aborted":
			return "aborted"
		case "failure":
			return "execution_error"
		default:
			return undefined
	}
}

export function emitDocumentCliCompleted(
	tm: TelemetryContext,
	ctx: ExtensionContext,
	input: {
		command: string
		resultText: string
		isError?: boolean
		classification?: ToolErrorClassification
		durationMs: number
		toolCallId: string
	},
): void {
	const attribution = attributeDocumentCliCommand(input.command)
	if (!attribution) return
	const outcome = resolveOutcome(input.isError, input.classification)
	if (!outcome) return
	const errorCode =
		outcome === "nonzero_exit" ? (extractDocumentErrorCode(input.resultText) ?? "unclassified") : undefined

	tm.emit(
		"document_cli.completed",
		{
			document_type: attribution.documentType,
			operation: attribution.operation,
			outcome,
			duration_ms: input.durationMs,
			...(errorCode ? { error_code: errorCode } : {}),
			turn_index: tm.turnIndex,
			tool_use_id: input.toolCallId,
		},
		ctx,
		tm.lastRoutedModel ? { routed_model: tm.lastRoutedModel } : undefined,
	)
}
