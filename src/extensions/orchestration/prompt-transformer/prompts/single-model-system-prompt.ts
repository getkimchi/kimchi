import {
	CORE_GUIDELINES,
	DOCUMENTS_SECTION,
	FACTUAL_ACCURACY,
	FOOTER,
	PHASE_TAGGING,
	RESEARCH_RULES,
	TOOLS_SECTION,
	TOOL_DISCOVERY,
} from "./shared.js"

export default [
	`You are an expert coding assistant. Your available tools are listed under **Available Tools** below — use only those, never guess or invent tool names.

{{ENVIRONMENT}}`,
	TOOLS_SECTION,
	DOCUMENTS_SECTION,
	RESEARCH_RULES,
	FACTUAL_ACCURACY,
	TOOL_DISCOVERY,
	`## Guidelines

${CORE_GUIDELINES}`,
	PHASE_TAGGING,
	FOOTER,
].join("\n\n")
