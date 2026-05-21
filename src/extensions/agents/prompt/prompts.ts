/**
 * prompts.ts — System prompt builder for agents.
 */

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
	const extrasSuffix = extraSections.length > 0 ? `\n\n${extraSections.join("\n")}` : ""

	if (config.promptMode === "append") {
		const identity = parentSystemPrompt || genericBase

		const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`

		const customSection = config.systemPrompt?.trim()
			? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
			: ""

		return `${envBlock}\n\n<inherited_system_prompt>\n${identity}\n</inherited_system_prompt>\n\n${bridge}${customSection}${extrasSuffix}`
	}

	// "replace" mode — env header + the config's full system prompt
	const replaceHeader = `You are a kimchi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`

	return `${replaceHeader}\n\n${config.systemPrompt}${extrasSuffix}`
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

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`
