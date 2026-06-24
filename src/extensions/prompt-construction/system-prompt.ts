/**
 * Generic system prompt assembler.
 *
 * Mode-aware: drives intro selection, tool filtering, and which mode-specific
 * instruction payload to embed (orchestrator / subagent / single-model).
 * Orchestration content lives in `orchestration/orchestration-instructions.ts`;
 * subagent and single-model content lives in this file.
 */

import { type Skill, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent"
import type { ModelCustomMetadata } from "../orchestration/model-metadata.js"
import { buildPhaseGuidelinesSection } from "../orchestration/model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "../orchestration/model-registry/index.js"
import type { Phase } from "../orchestration/model-registry/types.js"
import type { ModelRoles } from "../orchestration/model-roles.js"
import { resolveOrchestrationInstructions } from "../orchestration/orchestration-instructions.js"
import type { OrchestrationInstructionsResult } from "../orchestration/orchestration-instructions.js"
import type { ContextFile } from "./context-files.js"
import { type SuppressibleSection, renderSystemPromptBlocks } from "./system-prompt-blocks.js"

export interface EnvironmentInfo {
	os: string
	rawPlatform: string
	cpuArchitecture: string
	shell: string
	osRelease: string
	osVersion: string
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
	/** Custom model metadata for non-registry models. */
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>
	/** Session ID for the active pi-mono session. Used to scope extension prompt blocks
	 *  to this session so an in-process subagent's blocks don't leak into the parent's
	 *  prompt and vice versa. Omit only in unit tests or before any session has started. */
	sessionId?: string
}

const DELEGATION_TOOL_NAMES = new Set(["Agent", "resume_subagent", "get_subagent_result", "steer_subagent"])

export function buildSystemPrompt(options: SystemPromptBuildOptions): string {
	const { tools, env, contextFiles, skills, currentModelId, currentPhase, registry, mode, roles, sessionId } = options

	const effectiveTools = mode === "subagent" ? tools.filter((t) => !DELEGATION_TOOL_NAMES.has(t.name)) : tools

	const toolsSection = formatToolsSection(effectiveTools)
	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)
	const skillsSection = formatSkills(skills)

	const { teamSection, instructionsSection: orchestrationSection } = resolveModeInstructions({
		mode,
		currentModelId,
		registry,
		roles,
		customConfigs: options.customConfigs,
	})

	const phaseSection = buildPhaseGuidelinesSection(currentModelId, currentPhase, registry)
	const blocks = sessionId ? renderSystemPromptBlocks(sessionId, { mode }) : []
	const suppressed = new Set<SuppressibleSection>()
	for (const block of blocks) {
		for (const section of block.suppress) suppressed.add(section)
	}

	return buildPrompt({
		mode,
		teamSection,
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
	teamSection: string
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

/**
 * Resolve the mode-specific instruction payload for the system prompt.
 *
 * Only the orchestrator branch touches `roles`/`registry`/`customConfigs` —
 * subagent and single-model payloads are mode-shaped but orchestration-free.
 * Lives here (not in `orchestration-instructions.ts`) because mode selection
 * is the assembler's concern.
 */
function resolveModeInstructions(args: {
	mode: PromptMode
	currentModelId?: string
	registry?: ModelRegistry
	roles?: ModelRoles
	customConfigs?: ReadonlyMap<string, ModelCustomMetadata>
}): OrchestrationInstructionsResult {
	if (args.mode === "orchestrator") {
		return resolveOrchestrationInstructions({
			currentModelId: args.currentModelId,
			registry: args.registry,
			roles: args.roles,
			customConfigs: args.customConfigs,
		})
	}
	if (args.mode === "subagent") {
		return { teamSection: "", instructionsSection: SUBAGENT_INSTRUCTIONS }
	}
	return { teamSection: "", instructionsSection: buildSingleModelInstructions(args.currentModelId) }
}

// ---------------------------------------------------------------------------
// Subagent instructions
// ---------------------------------------------------------------------------

const SUBAGENT_INSTRUCTIONS = `## Subagent response protocol

Your final response must be a single JSON object with no other text before or after it:

\`\`\`
{"summary": "...", "files": ["path1", "path2"]}
\`\`\`

- \`summary\`: one paragraph (at most 5 sentences) covering what was done, any critical decisions, and any blockers.
- \`files\`: array of absolute paths to every file written to the Documents directory. Empty array if none.

Write all substantive output (plans, specs, research notes, findings) to files in the Documents directory — never inline in the summary. Do NOT add any text before or after the JSON. Do NOT wrap it in a markdown code fence.`

// ---------------------------------------------------------------------------
// Single-model instructions
// ---------------------------------------------------------------------------

function buildSingleModelInstructions(currentModelId?: string): string {
	const modelClause = currentModelId ? ` Your model ID is \`${currentModelId}\`.` : ""
	return `## Single-Model Mode

Your first response to a complex task MUST include visible text (not just internal thinking) that orients the user: state what you intend to do and why in one or two sentences. For complex tasks, name the phases you will work through (for example: "I'll start by mapping the handlers, then propose fixes, then implement"). This is the user's window to interrupt if your approach is wrong. After the orientation, proceed quietly and do not narrate meta-process in subsequent turns.

You are running in single-model mode.${modelClause} All work in this session runs on the currently selected model. Handle tasks directly yourself unless delegation is clearly beneficial.

You may spawn subagents with the \`Agent\` tool for parallel work or to isolate long-running tasks. When you do, you MUST always pass your own model ID in the \`model\` parameter — never delegate to a different model.`
}

const DOCUMENTS_SECTION =
	"The Documents directory is shown in the Environment section. Use it for **all** intermediate and output files: plans, specs, research notes, findings, or any file passed between agents. Never write working documents to the project directory or a temporary directory."

const CORE_GUIDELINES = `- Be concise in your responses. Do not repeat what you just did or summarize completed steps — act and move on. Exception: your first response to a complex task MUST include visible text (not just internal thinking) stating your intent and the phases you will work through. After that initial orientation, stay quiet about process.
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

	// 1. Intro
	const intro = parts.mode === "orchestrator" ? ORCHESTRATOR_INTRO : SINGLE_INTRO
	sections.push(intro)

	// 2. Your Team + Your Capabilities
	if (parts.teamSection) {
		sections.push(parts.teamSection)
	}

	// 3. Orchestration instructions (DOs/DONTs, budgets, agent management)
	if (!parts.suppressed.has("orchestration") && parts.orchestrationSection) {
		sections.push(parts.orchestrationSection)
	}

	// 4. Guidelines
	sections.push(`## Guidelines\n\n${CORE_GUIDELINES}`)
	sections.push(`## Factual Accuracy\n\n${FACTUAL_ACCURACY}`)

	// 5. Phase guidelines
	if (!parts.suppressed.has("phase-guidelines") && parts.phaseSection) {
		sections.push(parts.phaseSection)
	}

	// 6. Documents
	sections.push(`## Documents\n\n${DOCUMENTS_SECTION}`)

	// 7. Rest: system prompt blocks, tools, skills, environment, project context
	if (parts.systemPromptBlocks) {
		sections.push(parts.systemPromptBlocks)
	}

	sections.push(parts.toolsSection)

	if (!parts.suppressed.has("skills") && parts.skillsSection) {
		sections.push(parts.skillsSection)
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

export function formatEnvironmentSection(env: EnvironmentInfo): string {
	const shellFamily = inferShellFamily(env)
	const lines = [
		"## Environment",
		"",
		`- OS: ${env.os}`,
		`- OS release: ${env.osRelease}`,
		`- OS version: ${env.osVersion}`,
		`- Raw platform: ${env.rawPlatform}`,
		`- CPU architecture: ${env.cpuArchitecture}`,
		`- Shell: ${env.shell}`,
		`- Shell family: ${shellFamily}`,
		"- Command guidance: Use commands compatible with the shell family. Do not use PowerShell/cmd syntax in POSIX shells, and do not use POSIX-only syntax in PowerShell/cmd unless the shell is Git Bash or WSL. If shell/platform conflict or are unclear, check with a read-only command before running write/destructive commands.",
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

function inferShellFamily(env: EnvironmentInfo): string {
	const shell = env.shell.toLowerCase()
	const platform = env.rawPlatform.toLowerCase()
	if (shell.includes("powershell") || shell.includes("pwsh")) return "powershell"
	if (/(^|[/\\])cmd(\.exe)?$/.test(shell)) return "cmd"
	if (shell.includes("bash") || shell.includes("zsh") || shell.includes("fish") || /(^|[/\\])sh$/.test(shell)) {
		return platform === "win32" ? "posix-on-windows" : "posix"
	}
	return platform === "win32" ? "windows-unknown" : "posix-unknown"
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
