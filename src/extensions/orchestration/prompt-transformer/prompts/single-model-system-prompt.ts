import { CORE_GUIDELINES, DOCUMENTS_SECTION, FOOTER, PHASE_TAGGING, TOOLS_SECTION, USER_INTERACTION } from "./shared.js"

export default [
	`You are an expert coding assistant. Your available tools are listed under **Available Tools** below — use only those, never guess or invent tool names.

{{ENVIRONMENT}}`,
	TOOLS_SECTION,
	DOCUMENTS_SECTION,
	`## Guidelines

${CORE_GUIDELINES}`,
	PHASE_TAGGING,
	USER_INTERACTION,
	FOOTER,
].join("\n\n")
