/**
 * Generic system prompt assembler.
 *
 * Mode-agnostic: assembles intro + environment + documents +
 * guidelines + orchestration instructions + phase guidelines +
 * project context + tools + skills.
 *
 * All mode-specific content lives in orchestration-instructions.ts.
 */

import { type Skill, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent"
import { buildPhaseGuidelinesSection } from "../orchestration/model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "../orchestration/model-registry/index.js"
import type { Phase } from "../orchestration/model-registry/types.js"
import { resolveOrchestrationInstructions } from "../orchestration/orchestration-instructions.js"
import type { ContextFile } from "./context-files.js"

export interface EnvironmentInfo {
	os: string
	username: string
	homeDir: string
	cwd: string
	documentsDir: string
	currentTime: string
	localDate: string
	isGitRepo: boolean
	gitBranch?: string
	gitRemote?: string
}

export interface ToolInfo {
	name: string
	description: string
}

export type PromptMode = "orchestrator" | "subagent" | "single"

export interface SystemPromptBuildOptions {
	tools: readonly ToolInfo[]
	env: EnvironmentInfo
	contextFiles?: readonly ContextFile[]
	skills?: readonly Skill[]
	currentModelId?: string
	currentPhase?: Phase
	registry?: ModelRegistry
	mode: PromptMode
}

const SUBAGENT_TOOL_NAME = "subagent"

export function buildSystemPrompt(options: SystemPromptBuildOptions): string {
	const { tools, env, contextFiles, skills, currentModelId, currentPhase, registry, mode } = options

	const effectiveTools = mode === "subagent" ? tools.filter((t) => t.name !== SUBAGENT_TOOL_NAME) : tools

	const toolsSection = formatToolsSection(effectiveTools)
	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)
	const skillsSection = formatSkills(skills)

	// TODO!!!
	// In the future we will need to dynamically resolve orchestration instructions based on the user prompt "to do"
	const orchestrationSection = resolveOrchestrationInstructions({
		currentModelId,
		registry,
		mode,
	})

	const phaseSection = buildPhaseGuidelinesSection(currentModelId, currentPhase, registry)

	return buildPrompt({
		mode,
		toolsSection,
		environmentSection,
		projectContext,
		skillsSection,
		orchestrationSection,
		phaseSection,
	})
}

// ---------------------------------------------------------------------------
// Unified Template Builder
// ---------------------------------------------------------------------------

interface PromptParts {
	mode: PromptMode
	toolsSection: string
	environmentSection: string
	projectContext: string
	skillsSection: string
	orchestrationSection: string
	phaseSection: string
}

const BASE_INSTRUCTIONS =
	"You are an expert coding assistant. Your available tools are listed under **Available Tools** below — use only those, never guess or invent tool names."

const ORCHESTRATOR_INTRO = `${BASE_INSTRUCTIONS} You can also spawn subagents when delegation is more appropriate than doing the work yourself.`

const SINGLE_INTRO = BASE_INSTRUCTIONS

const DOCUMENTS_SECTION =
	"The Documents directory is shown in the Environment section. Use it for **all** intermediate and output files: plans, specs, research notes, findings, or any file passed between agents. Never write working documents to the project directory or a temporary directory."

const CORE_GUIDELINES = `- Be concise in your responses. Do not restate what you are about to do, repeat what you just did, or summarize completed steps — act and move on.
- Show file paths clearly when working with files.
- Do NOT introduce security vulnerabilities.
- After every tool result, ALWAYS produce text — either the next tool call with explicit reasoning, or a final summary. Never re-issue the same tool call after a successful result.
- Never emit tool calls with empty names, blank IDs, or malformed arguments. If a tool call fails to advance the task after 3 attempts, stop calling tools, summarize what is not working, and reassess in plain text before continuing.`

const PHASE_TAGGING = `
You must call \`set_phase\` before every block of work. Never take an action without the correct phase being set first. Use one of \`explore\`, \`research\`, \`plan\`, \`build\`, or \`review\` strictly matching current work type.
The session starts in \`explore\` phase by default. Call \`set_phase\` immediately when your work type changes. Only one phase is active at a time — the most recent call wins.`

const FACTUAL_ACCURACY = `
- Never guess, assume, or fabricate information. Every claim you make must be backed by data you concretely obtained during this session. Do NOT escalate to escalation for minor issues or blame the user for poor request phrasing.
- "I don't know" is a valid answer. When requirements, specifications, or factual details are not available through your tools or the user's messages, state that clearly and ask the user to provide them. Do not fill the gap with plausible-sounding content.
- Distinguish what you found from what you assume. If you must reason about something uncertain, label it explicitly as an assumption and ask the user to confirm before acting on it.`

const TOOL_DISCOVERY = `
- Before resorting to web search, web fetch, or giving up on accessing external data, check your Available Tools list for a more direct way to get the information. MCP (Model Context Protocol) integrations often provide authenticated access to services like Jira, Confluence, GitHub, GitLab, and others that are inaccessible via unauthenticated web requests.
- If you see an mcp tool in your tool list, use mcp({ search: "query" }) to discover what MCP servers and tools are available before assuming you have no way to access a service.
- Prefer MCP tools over web_fetch for any service that requires authentication (Jira, Confluence, internal wikis, etc.). MCP tools already have credentials configured.`

function buildPrompt(parts: PromptParts): string {
	const sections: string[] = []

	const intro = parts.mode === "orchestrator" ? ORCHESTRATOR_INTRO : SINGLE_INTRO
	sections.push(`${intro}\n\n${parts.environmentSection}`)

	sections.push(`## Documents\n\n${DOCUMENTS_SECTION}`)
	sections.push(`## Guidelines\n\n${CORE_GUIDELINES}`)
	sections.push(`## Factual Accuracy\n\n${FACTUAL_ACCURACY}`)
	sections.push(`## Phase Tagging for Analytics\n\n${PHASE_TAGGING}`)
	sections.push(`## Tool and MCP Discovery\n\n${TOOL_DISCOVERY}`)

	if (parts.orchestrationSection) {
		sections.push(parts.orchestrationSection)
	}

	if (parts.phaseSection) {
		sections.push(parts.phaseSection)
	}

	if (parts.projectContext) {
		sections.push(parts.projectContext)
	}

	sections.push(parts.toolsSection)

	if (parts.skillsSection) {
		sections.push(parts.skillsSection)
	}

	return sections.filter((s) => s.length > 0).join("\n\n")
}

// ---------------------------------------------------------------------------
// Section formatters
// ---------------------------------------------------------------------------

function formatToolsSection(tools: readonly ToolInfo[]): string {
	if (tools.length === 0) return "## Available Tools\n\n(No tools available)"
	const entries = tools.map((t) => `<tool name="${t.name}">\n${t.description}\n</tool>`).join("\n")
	return `## Available Tools\n\n<available_tools>\n${entries}\n</available_tools>`
}

function formatEnvironmentSection(env: EnvironmentInfo): string {
	const lines = [
		"## Environment",
		"",
		`- OS: ${env.os}`,
		`- Username: ${env.username}`,
		`- Home directory: "${env.homeDir}"`,
		`- Working directory: "${env.cwd}"`,
		`- Documents directory: "${env.documentsDir}"`,
		`- Current time: ${env.currentTime} (local date: ${env.localDate})`,
		`- Git repository: ${env.isGitRepo ? "yes" : "no"}`,
	]
	if (env.gitBranch !== undefined) lines.push(`- Git branch: ${env.gitBranch}`)
	if (env.gitRemote !== undefined) lines.push(`- Git remote: ${env.gitRemote}`)
	return lines.join("\n")
}

function shiftHeadings(text: string): string {
	return text.replace(/^(#{1,5}) /gm, "##$1 ")
}

function formatProjectContext(contextFiles?: readonly ContextFile[]): string {
	if (!contextFiles || contextFiles.length === 0) return ""
	const combined = contextFiles.map((f) => shiftHeadings(f.content)).join("\n\n")
	return `## Project Guidelines\n\n${combined}`
}

function formatSkills(skills?: readonly Skill[]): string {
	if (!skills || skills.length === 0) return ""
	return formatSkillsForPrompt(skills as Skill[])
}
