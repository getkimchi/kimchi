import {
	CORE_GUIDELINES,
	DOCUMENTS_SECTION,
	FACTUAL_ACCURACY,
	FOOTER,
	SUBAGENT_RESPONSE_PROTOCOL,
	TOOLS_SECTION,
	TOOL_DISCOVERY,
} from "./shared.js"

export default [
	`You are an expert coding assistant. You operate inside a coding agent harness. Use only the tools listed under **Available Tools** below — never guess or invent tool names.

{{ENVIRONMENT}}`,
	TOOLS_SECTION,
	DOCUMENTS_SECTION,
	SUBAGENT_RESPONSE_PROTOCOL,
	FACTUAL_ACCURACY,
	TOOL_DISCOVERY,
	`## Guidelines

${CORE_GUIDELINES}
- Use the appropriate tool for each operation: read for files, bash for shell commands, edit for modifications, write for new files.`,
	FOOTER,
].join("\n\n")
