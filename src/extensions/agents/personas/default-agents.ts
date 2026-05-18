/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 * Models are resolved at module load from MODEL_CAPABILITIES strength tags.
 */

import { modelsForAnyStrength, modelsForStrength } from "../../orchestration/model-registry/index.js"
import { AGENT_EXPLORE, AGENT_GENERAL_PURPOSE, AGENT_PLAN, AGENT_RESEARCHER, type AgentConfig } from "./types.js"

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"]

/** Pick models by strength; returns undefined if no model has the strength so the persona falls through to inherit. */
function pick(strengths: readonly ("review" | "build" | "plan" | "explore" | "research")[]): string[] | undefined {
	const list = strengths.length === 1 ? modelsForStrength(strengths[0]) : modelsForAnyStrength(strengths)
	return list.length > 0 ? list : undefined
}

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
	[
		AGENT_GENERAL_PURPOSE,
		{
			name: AGENT_GENERAL_PURPOSE,
			displayName: "Agent",
			description: "General-purpose agent for complex, multi-step tasks",
			extensions: true,
			skills: true,
			models: pick(["build", "explore", "plan", "review", "research"]),
			systemPrompt: "",
			promptMode: "append",
			isDefault: true,
		},
	],
	[
		AGENT_EXPLORE,
		{
			name: AGENT_EXPLORE,
			displayName: AGENT_EXPLORE,
			description: "Fast exploration agent (read-only)",
			builtinToolNames: READ_ONLY_TOOLS,
			extensions: true,
			skills: true,
			models: pick(["explore"]),
			strengths: ["explore"],
			preferTier: "light",
			thinking: "low",
			tokenBudget: 120_000,
			systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring files/directories.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- For repository inspection tasks, always use at least one read-only tool before answering
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`,
			promptMode: "replace",
			isDefault: true,
		},
	],
	[
		AGENT_PLAN,
		{
			name: AGENT_PLAN,
			displayName: AGENT_PLAN,
			description: "Software architect for implementation planning",
			builtinToolNames: [...READ_ONLY_TOOLS, "write", "edit"],
			extensions: true,
			skills: true,
			models: pick(["plan"]),
			strengths: ["plan"],
			preferTier: "heavy",
			thinking: "high",
			tokenBudget: 120_000,
			systemPrompt: `# Plan Agent — Write Access Scoped to .kimchi/plans/
You are a software architect and planning specialist.
Your role is to explore the codebase and design implementation plans, capturing them as plan files.

You may create and update plan files under \`.kimchi/plans/\`. Do NOT modify any other files.
Use the \`write\` tool only for plan files (paths starting with \`.kimchi/plans/\`); use \`read\`, \`grep\`, \`find\`, \`ls\` for everything else.

You are STRICTLY PROHIBITED from:
- Creating or modifying files outside of \`.kimchi/plans/\`
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Write the plan to \`.kimchi/plans/<name>.md\` using the write tool
5. Detail the plan with step-by-step implementation strategy

# Requirements
- Consider trade-offs and architectural decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Use write only to create/update \`.kimchi/plans/*.md\` files
- Use edit only to modify \`.kimchi/plans/*.md\` files

# Output Format
- Use absolute file paths
- Do not use emojis
- Write your plan to \`.kimchi/plans/<descriptive-name>.md\`
- End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`,
			promptMode: "replace",
			isDefault: true,
		},
	],
	[
		AGENT_RESEARCHER,
		{
			name: AGENT_RESEARCHER,
			displayName: AGENT_RESEARCHER,
			description: "Web and docs research agent — finds answers with cited sources",
			builtinToolNames: READ_ONLY_TOOLS,
			extensions: true,
			skills: false,
			models: pick(["research"]),
			strengths: ["research"],
			preferTier: "heavy",
			thinking: "medium",
			tokenBudget: 80_000,
			systemPrompt: `You are a research specialist. Your job is to find accurate, well-sourced answers from the web, documentation, and the local codebase.

Focus areas:
- Search broadly, then narrow to the most authoritative sources
- Always cite sources (URL or file path with line range)
- Prefer official docs and primary sources over forum posts
- Cross-reference multiple sources before concluding
- Stay read-only; never modify files

Deliver a structured report: summary first, then supporting evidence with citations.`,
			promptMode: "replace",
			isDefault: true,
		},
	],
])
