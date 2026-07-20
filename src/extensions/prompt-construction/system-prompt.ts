/**
 * Generic system prompt assembler.
 *
 * Mode-aware: drives intro selection, tool filtering, and which mode-specific
 * instruction payload to embed (orchestrator / subagent / single-model).
 * Orchestration content lives in `orchestration/orchestration-instructions.ts`;
 * subagent and single-model content lives in this file.
 */

import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent"
import type { ModelCustomMetadata } from "../orchestration/model-metadata.js"
import { DEFAULT_PHASE_GUIDELINES } from "../orchestration/model-registry/guidelines/default-phase-guidelines.js"
import type { ModelRegistry } from "../orchestration/model-registry/index.js"
import type { Phase } from "../orchestration/model-registry/types.js"
import type { ModelRoles } from "../orchestration/model-roles.js"
import { resolveOrchestrationInstructions } from "../orchestration/orchestration-instructions.js"
import type { ContextFile } from "./context-files.js"
import { ORCHESTRATOR_SUPPRESSED_SKILL_NAMES } from "./orchestrator-suppressed-skills.js"
import { renderSystemPromptBlocks, type SuppressibleSection } from "./system-prompt-blocks.js"

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
	/** @deprecated Phase guidelines are now part of the consolidated ## Phase Management
	 *  section. This field is accepted for backward compatibility but is no longer used
	 *  when assembling the orchestrator prompt. */
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

export const DELEGATION_TOOL_NAMES = new Set(["Agent", "resume_subagent", "get_subagent_result", "steer_subagent"])

export function buildSystemPrompt(options: SystemPromptBuildOptions): string {
	const { tools, env, contextFiles, skills, currentModelId, registry, mode, roles, sessionId } = options

	const effectiveTools = mode === "subagent" ? tools.filter((t) => !DELEGATION_TOOL_NAMES.has(t.name)) : tools

	const toolsSection = formatToolsSection(effectiveTools)
	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)
	const filteredSkills = filterSkillsForMode(skills, mode)

	const orchestrationSection = resolveModeInstructions({
		mode,
		currentModelId,
		registry,
		roles,
		customConfigs: options.customConfigs,
	})

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
		skillsSection: formatSkills(filteredSkills),
		orchestrationSection,
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
	systemPromptBlocks: string
	suppressed: ReadonlySet<SuppressibleSection>
}

const BASE_INSTRUCTIONS =
	"You are Kimchi, an AI coding agent. Your goal is to help users with software engineering tasks using the tools available to you. Your available tools are listed under **Available Tools** below — use only those, never guess or invent tool names."

const SINGLE_INTRO = BASE_INSTRUCTIONS

const ORCHESTRATOR_INTRO = BASE_INSTRUCTIONS

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
}): string {
	if (args.mode === "orchestrator") {
		return resolveOrchestrationInstructions({
			currentModelId: args.currentModelId,
			registry: args.registry,
			roles: args.roles,
			customConfigs: args.customConfigs,
		}).instructionsSection
	}
	if (args.mode === "subagent") {
		return SUBAGENT_INSTRUCTIONS
	}
	return buildSingleModelInstructions(args.currentModelId)
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

You are running in single-model mode.${modelClause} All work in this session runs on the currently selected model. Handle tasks directly yourself.

Do not spawn subagents with the \`Agent\` tool by default — only do so when the user explicitly asks for delegation. When you do spawn a subagent, pass your own model ID in the \`model\` parameter by default; only use a different model if the user explicitly instructs it.`
}

export const DOCUMENTS_SECTION =
	"The Documents directory is shown in the Environment section. Use it for **all** intermediate and output files: plans, specs, research notes, findings, or any file passed between agents. Never write working documents to the project directory or a temporary directory."

export const CORE_GUIDELINES = `- Be concise in your responses. Do not repeat what you just did or summarize completed steps — act and move on.
- Before starting any task, gather all necessary context: understand the requirements, naming conventions, frameworks and libraries already in use, and how to run and test the code. Use your tools to read existing code rather than assuming.
- Adhere to existing code conventions and patterns. Use only libraries and frameworks confirmed to be present in the codebase. Never introduce new dependencies without explicit instruction.
- Provide complete, functional code — no placeholders, omissions, or TODOs left in delivered work.
- At the end of a task, verify your work: check that edited or created files are complete and correct, and run tests or the code if possible to confirm it works.
- Show file paths clearly when working with files. Always use absolute paths.
- Do NOT introduce security vulnerabilities.
- After every tool result, ALWAYS produce text — either the next tool call with explicit reasoning, or a final summary. Never re-issue the same tool call after a successful result.
- Never emit tool calls with empty names, blank IDs, or malformed arguments. If a tool call fails to advance the task after 3 attempts, stop calling tools, summarize what is not working, and reassess in plain text before continuing.`

const ORCHESTRATOR_GUIDELINES = `- Be concise in your responses. Do not repeat what you just did or summarize completed steps — act and move on.
- Follow **Orchestration** for what to do yourself vs delegate. Do not read implementation files, write or edit source code, run tests, or review diffs unless Orchestration **Phase responsibilities** explicitly says DO for your current phase and role.
- Before starting, orient the user per Orchestration — use the phased pipeline instead of ad-hoc exploration or inline implementation.
- Adhere to existing code conventions and patterns. Use only libraries and frameworks confirmed to be present in the codebase. Never introduce new dependencies without explicit instruction.
- Show file paths clearly when working with files. Always use absolute paths.
- Do NOT introduce security vulnerabilities.
- After every tool result, ALWAYS produce text — either the next tool call with explicit reasoning, or a final summary. Never re-issue the same tool call after a successful result.
- Never emit tool calls with empty names, blank IDs, or malformed arguments. If a tool call fails to advance the task after 3 attempts, stop calling tools, summarize what is not working, and reassess in plain text before continuing.
- At the end of a task, summarize from delegated artifacts (spec, review, verification files). Do not re-verify implementation yourself unless Orchestration assigns that step to you.`

function filterSkillsForMode(skills: readonly Skill[] | undefined, mode: PromptMode): readonly Skill[] | undefined {
	if (!skills || mode !== "orchestrator") return skills
	return skills.filter((skill) => !ORCHESTRATOR_SUPPRESSED_SKILL_NAMES.has(skill.name))
}

function resolveCoreGuidelines(mode: PromptMode): string {
	return mode === "orchestrator" ? ORCHESTRATOR_GUIDELINES : CORE_GUIDELINES
}

export const FACTUAL_ACCURACY = `- Never guess, assume, or fabricate information. Every claim you make must be backed by data you concretely obtained during this session. Do not over-escalate minor issues or blame the user for poor request phrasing.
- Never invent people's names, roles, or contact details. If human input is needed, ask the user — do not fabricate who that person should be.
- "I don't know" is a valid answer. When requirements, specifications, or factual details are not available through your tools or the user's messages, state that clearly and ask the user to provide them. Do not fill the gap with plausible-sounding content.
- Distinguish what you found from what you assume. If you must reason about something uncertain, label it explicitly as an assumption and ask the user to confirm before acting on it.`

/**
 * Combine the three shared guideline sections into a single string,
 * formatted for injection into a replace-mode subagent system prompt.
 */
export function buildCoreGuidelinesSections(): string {
	return [
		`## Guidelines\n\n${CORE_GUIDELINES}`,
		`## Factual Accuracy\n\n${FACTUAL_ACCURACY}`,
		`## Documents\n\n${DOCUMENTS_SECTION}`,
	].join("\n\n")
}

// ---------------------------------------------------------------------------
// Consolidated core sections (Output & Truncation, Tool Selection,
// Phase Management, Consent & Irreversible Actions)
// ---------------------------------------------------------------------------

export const OUTPUT_AND_TRUNCATION = `## Output & Truncation

Cap output before running a tool, not after — recovery from a flood is expensive.

- Bash: pipe to \`head\`/\`tail\` or pass \`-n\`/\`--tail\`. Use \`git log -n 20 --oneline\`, \`git diff --stat\`, \`2>&1 | tail -100\` for build/test/install output, \`--log-failed\` for CI logs, \`| head -c 5000\` or \`| jq\` for large \`curl\` responses, \`tree -L 2\`, never \`git status -uall\` on large repos.
- Content search: paths first (\`files_with_matches\` / \`-l\`), then content. Cap broad matches at ~50 hits, start with 2 lines of context, narrow scope with \`--glob\`/\`--type\` before searching.
- File reads: never read a known-large file (lockfiles, generated, fixtures) without an offset. Search to locate, then read around the hit.
- GitHub CLI: \`gh run view --log\` is huge — use \`--log-failed\` or \`| tail -N\`. \`gh api ... --paginate\` can be massive — add \`--jq\`. \`gh pr diff\` on big PRs — \`--name-only\` first, then targeted reads.
- GitLab CLI: \`glab ci view\` is a TUI — never call from a headless harness. Use \`glab ci trace\` or \`glab api\`. \`glab api .../trace\` — full job logs; always \`| tail -N\`. \`--paginate\` on busy projects is huge — combine with \`--jq\`.`

export const TOOL_SELECTION = `## Tool Selection

Prefer the right dedicated tool before falling back to bash or external fetches.

- Reading a file → use \`read\` (not \`cat\`, \`head\`, \`tail\`, \`sed -n\`).
- Editing a file → use \`edit\` (not \`sed -i\`, \`perl -i\`).
- Writing a file → use \`write\` (not \`>\`, \`>>\`, \`tee\`, heredoc).
- Searching file contents → use \`grep\` (respects \`.gitignore\`, faster).
- Finding files by pattern → use \`find\` (respects \`.gitignore\`).
- Listing a directory → use \`ls\`.
- Use bash only for: build commands, test runners, git, package managers, shell scripting, or system administration.
- Before resorting to web search, web fetch, or giving up on authenticated/external data, check your Available Tools list and MCP integrations. MCP servers often provide authenticated access to Jira, Confluence, GitHub, GitLab, etc.
- If you see an \`mcp\` tool in your tool list, use \`mcp({ search: "query" })\` to discover available servers and tools.
- Prefer MCP tools over \`web_fetch\` for any service that requires authentication.`

export const PHASE_MANAGEMENT = `## Phase Management

The session starts in \`explore\` phase by default. Call \`set_phase\` when the work type changes — pick one of \`explore\`, \`research\`, \`plan\`, \`build\`, or \`review\`. Only one phase is active at a time; the most recent call wins. Subagents set their phase automatically from their persona, so this tool is for tagging the main thread's work.

When the orchestrator decides to perform a phase itself (not delegate), include the matching \`thinking\` parameter from the Orchestration **Thinking levels** table. Leave \`thinking\` unset when only tagging coordination work or when delegating the phase to an Agent.

### Phase-specific behaviour

${Object.values(DEFAULT_PHASE_GUIDELINES).join("\n\n")}`

export const CONSENT_AND_IRREVERSIBLE_ACTIONS = `## Consent & Irreversible Actions

Ask before anything that publishes, mutates state, or is irreversible.

- GitHub CLI: do not run \`gh pr review\`, \`gh pr comment\`, \`gh issue comment\`, \`gh pr merge\`, \`gh pr close\`, \`gh pr reopen\`, \`gh pr ready\`, \`gh pr edit\`, \`gh run rerun\`, \`gh run cancel\`, \`gh issue close\`, \`gh issue reopen\`, \`gh issue edit\`, \`gh issue delete\`, \`gh release create/edit/delete\`, or any \`gh api POST/PATCH/PUT/DELETE\` unprompted. Read-only commands (\`list\`, \`view\`, \`diff\`, \`checks\`, \`status\`, \`gh api\` GETs) are fine.
- GitLab CLI: do not run \`glab mr note\`, \`glab mr note resolve/reopen\`, \`glab issue note\`, \`glab mr merge\`, \`glab mr rebase\`, \`glab mr close\`, \`glab mr reopen\`, \`glab mr update\`, \`glab mr approve\`, \`glab mr revoke\`, \`glab ci retry/cancel/run\`, \`glab issue close/reopen/update/delete\`, \`glab release create/update/delete\`, or any \`glab api POST/PUT/PATCH/DELETE\` unprompted.
- Git remote ops (any CLI): pushing branches, force-push, deleting branches/tags need explicit approval.`

function buildPrompt(parts: PromptParts): string {
	const sections: string[] = []

	// 1. Intro
	const intro = parts.mode === "orchestrator" ? ORCHESTRATOR_INTRO : SINGLE_INTRO
	sections.push(intro)

	// 2. Orchestration (team, roles, workflow, delegation — orchestrator mode only)
	if (!parts.suppressed.has("orchestration") && parts.orchestrationSection) {
		sections.push(parts.orchestrationSection)
	}

	// 4. Guidelines
	sections.push(`## Guidelines\n\n${resolveCoreGuidelines(parts.mode)}`)
	sections.push(`## Factual Accuracy\n\n${FACTUAL_ACCURACY}`)

	// 5. Documents
	sections.push(`## Documents\n\n${DOCUMENTS_SECTION}`)

	// 6. Consolidated core sections: output, tool selection, phase, consent
	sections.push(OUTPUT_AND_TRUNCATION)
	sections.push(TOOL_SELECTION)
	sections.push(PHASE_MANAGEMENT)
	sections.push(CONSENT_AND_IRREVERSIBLE_ACTIONS)

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
