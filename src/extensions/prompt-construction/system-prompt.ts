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
import type { ModelRoles } from "../orchestration/model-roles.js"
import { resolveOrchestrationInstructions } from "../orchestration/orchestration-instructions.js"
import type { ContextFile } from "./context-files.js"
import { type SuppressibleSection, renderSystemPromptBlocks } from "./system-prompt-blocks.js"

export interface EnvironmentInfo {
	os: string
	username: string
	homeDir: string
	cwd: string
	documentsDir: string
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
	/** Role-based model assignments for orchestrator mode. */
	roles?: ModelRoles
	/** Session ID for the active pi-mono session. Used to scope extension prompt blocks
	 *  to this session so an in-process subagent's blocks don't leak into the parent's
	 *  prompt and vice versa. Omit only in unit tests or before any session has started. */
	sessionId?: string
}

const DELEGATION_TOOL_NAMES = new Set(["Agent", "get_subagent_result", "steer_subagent"])

export function buildSystemPrompt(options: SystemPromptBuildOptions): string {
	const { tools, env, contextFiles, skills, currentModelId, currentPhase, registry, mode, roles, sessionId } = options

	const effectiveTools = mode === "subagent" ? tools.filter((t) => !DELEGATION_TOOL_NAMES.has(t.name)) : tools

	const toolsSection = formatToolsSection(effectiveTools)
	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)
	const skillsSection = formatSkills(skills)

	const orchestrationSection = resolveOrchestrationInstructions({
		currentModelId,
		registry,
		mode,
		roles,
	})

	const phaseSection = buildPhaseGuidelinesSection(currentModelId, currentPhase, registry)
	const blocks = sessionId ? renderSystemPromptBlocks(sessionId, { mode }) : []
	const suppressed = new Set<SuppressibleSection>()
	for (const block of blocks) {
		for (const section of block.suppress) suppressed.add(section)
	}

	return buildPrompt({
		mode,
		toolsSection,
		environmentSection,
		projectContext,
		skillsSection,
		orchestrationSection,
		phaseSection,
		systemPromptBlocks: blocks.map((block) => block.content).join("\n\n"),
		suppressed,
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
	systemPromptBlocks: string
	suppressed: ReadonlySet<SuppressibleSection>
}

const BASE_INSTRUCTIONS =
	"You are Kimchi, an AI coding agent. Your goal is to help users with software engineering tasks using the tools available to you. Your available tools are listed under **Available Tools** below — use only those, never guess or invent tool names."

const SINGLE_INTRO = BASE_INSTRUCTIONS

const ORCHESTRATOR_INTRO = `${BASE_INSTRUCTIONS} As an orchestrator, you reason through the work, plan the approach, and coordinate a team of specialised subagents to execute it.`

const DOCUMENTS_SECTION =
	"The Documents directory is shown in the Environment section. Use it for **all** intermediate and output files: plans, specs, research notes, findings, or any file passed between agents. Never write working documents to the project directory or a temporary directory."

const CORE_GUIDELINES = `- Be concise in your responses. Do not restate what you are about to do, repeat what you just did, or summarize completed steps — act and move on.
- Before starting any task, gather all necessary context: understand the requirements, naming conventions, frameworks and libraries already in use, and how to run and test the code. Use your tools to read existing code rather than assuming.
- Adhere to existing code conventions and patterns. Use only libraries and frameworks confirmed to be present in the codebase. Never introduce new dependencies without explicit instruction.
- Provide complete, functional code — no placeholders, omissions, or TODOs left in delivered work.
- At the end of a task, verify your work: check that edited or created files are complete and correct, and run tests or the code if possible to confirm it works.
- Show file paths clearly when working with files. Always use absolute paths.
- Do NOT introduce security vulnerabilities.
- After every tool result, ALWAYS produce text — either the next tool call with explicit reasoning, or a final summary. Never re-issue the same tool call after a successful result.
- Never emit tool calls with empty names, blank IDs, or malformed arguments. If a tool call fails to advance the task after 3 attempts, stop calling tools, summarize what is not working, and reassess in plain text before continuing.`

const FACTUAL_ACCURACY = `
- Never guess, assume, or fabricate information. Every claim you make must be backed by data you concretely obtained during this session. Do NOT escalate to escalation for minor issues or blame the user for poor request phrasing.
- Never invent people's names, roles, or contact details. If human input is needed, ask the user — do not fabricate who that person should be.
- "I don't know" is a valid answer. When requirements, specifications, or factual details are not available through your tools or the user's messages, state that clearly and ask the user to provide them. Do not fill the gap with plausible-sounding content.
- Distinguish what you found from what you assume. If you must reason about something uncertain, label it explicitly as an assumption and ask the user to confirm before acting on it.`

function buildPrompt(parts: PromptParts): string {
	const sections: string[] = []

	const intro = parts.mode === "orchestrator" ? ORCHESTRATOR_INTRO : SINGLE_INTRO
	sections.push(intro)

	sections.push(`## Documents\n\n${DOCUMENTS_SECTION}`)
	sections.push(`## Guidelines\n\n${CORE_GUIDELINES}`)
	sections.push(`## Factual Accuracy\n\n${FACTUAL_ACCURACY}`)

	if (parts.systemPromptBlocks) {
		sections.push(parts.systemPromptBlocks)
	}

	sections.push(parts.toolsSection)

	if (!parts.suppressed.has("skills") && parts.skillsSection) {
		sections.push(parts.skillsSection)
	}

	if (!parts.suppressed.has("orchestration") && parts.orchestrationSection) {
		sections.push(parts.orchestrationSection)
	}

	if (!parts.suppressed.has("phase-guidelines") && parts.phaseSection) {
		sections.push(parts.phaseSection)
	}

	sections.push(parts.environmentSection)

	if (!parts.suppressed.has("project-context") && parts.projectContext) {
		sections.push(parts.projectContext)
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
		`- Current date: ${env.localDate}`,
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
