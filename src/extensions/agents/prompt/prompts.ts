/**
 * prompts.ts — System prompt builder for agents.
 */

import type { ContextFile } from "../../prompt-construction/context-files.js"
import type { AgentConfig, EnvInfo } from "../personas/types.js"

/** Budget limits communicated to the agent so it can plan its work. */
export interface BudgetInfo {
	maxTurns?: number
	tokenBudget?: number
}

/** Extra sections to inject into the system prompt (memory, skills, etc.). */
export interface PromptExtras {
	/** Persistent memory content to inject (first 200 lines of MEMORY.md + instructions). */
	memoryBlock?: string
	/** Preloaded skill contents to inject. */
	skillBlocks?: { name: string; content: string }[]
	/** Model-specific phase guidelines resolved from the model registry. */
	guidelinesBlock?: string
	/** Turn and token budget limits for agent self-regulation. */
	budget?: BudgetInfo
	/** Project context files (AGENTS.md, CLAUDE.md) to inject. */
	contextFiles?: ContextFile[]
	/** Tool names this subagent is expected to have available. */
	activeToolNames?: string[]
}

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: env header + config.systemPrompt (full control, no parent identity)
 * - "append" mode: env header + parent system prompt + sub-agent context + config.systemPrompt
 * - "append" with empty systemPrompt: pure parent clone
 */
export function buildAgentPrompt(
	config: AgentConfig,
	cwd: string,
	env: EnvInfo,
	parentSystemPrompt?: string,
	extras?: PromptExtras,
): string {
	const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`

	// Build optional extras suffix
	const extraSections: string[] = []
	const budgetBlock = buildBudgetBlock(extras?.budget)
	if (budgetBlock) extraSections.push(budgetBlock)
	if (extras?.guidelinesBlock) {
		extraSections.push(extras.guidelinesBlock)
	}
	if (extras?.memoryBlock) {
		extraSections.push(extras.memoryBlock)
	}
	if (extras?.skillBlocks?.length) {
		for (const skill of extras.skillBlocks) {
			extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`)
		}
	}
	const contextBlock = buildContextBlock(extras?.contextFiles)
	if (contextBlock) extraSections.push(contextBlock)
	const extrasSuffix = extraSections.length > 0 ? `\n\n${extraSections.join("\n\n")}` : ""
	const availableToolsBlock = buildAvailableToolsBlock(extras?.activeToolNames)
	const toolGuidance = buildToolGuidance(extras?.activeToolNames)

	if (config.promptMode === "append") {
		const identity = stripAvailableToolsSection(parentSystemPrompt || genericBase)

		const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
${toolGuidance}
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
- Messages prefixed with "[Orchestrator]" are system instructions from the agent loop, not user input. Do not attribute them to the user.
</sub_agent_context>`

		const customSection = config.systemPrompt?.trim()
			? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
			: ""

		const toolSection = availableToolsBlock ? `\n\n${availableToolsBlock}` : ""
		return `${envBlock}\n\n<inherited_system_prompt>\n${identity}\n</inherited_system_prompt>${toolSection}\n\n${bridge}${customSection}${extrasSuffix}`
	}

	// "replace" mode — env header + the config's full system prompt
	const replaceHeader = `You are a kimchi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`

	const toolSection = availableToolsBlock ? `\n\n${availableToolsBlock}` : ""
	return `${replaceHeader}${toolSection}\n\n${config.systemPrompt}${extrasSuffix}`
}

export function formatTokenBudget(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
	return String(tokens)
}

function buildBudgetBlock(budget?: BudgetInfo): string | undefined {
	if (!budget) return undefined
	const lines: string[] = []
	if (budget.maxTurns != null) lines.push(`- Turn limit: ${budget.maxTurns} turns`)
	if (budget.tokenBudget != null) lines.push(`- Output token budget: ~${formatTokenBudget(budget.tokenBudget)}`)
	if (lines.length === 0) return undefined
	return `<budget>
You are operating under the following resource budget. Plan your work accordingly — prioritize the most important changes first and avoid unnecessary exploration.
${lines.join("\n")}
If you cannot complete the task within your budget, finish whatever is in progress cleanly and summarize remaining work for the orchestrator.
</budget>`
}

/** Shift headings down one level (e.g. # becomes ##, ##### becomes ######) to avoid conflict with prompt headings. */
function shiftHeadings(text: string): string {
	return text.replace(/^(#{1,6}) /gm, (_, hashes: string) => `${"#".repeat(Math.min(hashes.length + 1, 6))} `)
}

function buildAvailableToolsBlock(toolNames?: string[]): string | undefined {
	const names = uniqueToolNames(toolNames)
	if (names.length === 0) return undefined
	return `## Available Tools\n${names.map((name) => `- ${name}`).join("\n")}`
}

function buildToolGuidance(toolNames?: string[]): string {
	const names = new Set(uniqueToolNames(toolNames))
	const lines: string[] = []
	if (names.has("read")) lines.push("- Use the read tool instead of cat/head/tail")
	if (names.has("edit")) lines.push("- Use the edit tool instead of sed/awk")
	if (names.has("write")) lines.push("- Use the write tool instead of echo/heredoc")
	if (names.has("find")) lines.push("- Use the find tool instead of bash find/ls for file search")
	if (names.has("grep")) lines.push("- Use the grep tool instead of bash grep/rg for content search")
	return lines.join("\n")
}

function uniqueToolNames(toolNames?: string[]): string[] {
	if (!toolNames) return []
	return [...new Set(toolNames)].filter(Boolean)
}

function stripAvailableToolsSection(prompt: string): string {
	return prompt
		.replace(/(^|\n)## Available Tools\b[^\n]*\n[\s\S]*?(?=\n#+ |\n*$)/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

function buildContextBlock(contextFiles?: ContextFile[]): string | undefined {
	if (!contextFiles || contextFiles.length === 0) return undefined
	const combined = contextFiles.map((f) => shiftHeadings(f.content)).join("\n\n")
	return `## Project Guidelines\n\n${combined}`
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`
