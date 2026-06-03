/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 * Models are resolved from the role-based configuration (model-roles.ts).
 * The strength-based lookup (modelsForStrength) is preserved as a fallback for
 * custom personas that use strengths in their frontmatter.
 */

import { modelsForAnyStrength, modelsForStrength } from "../../orchestration/model-registry/index.js"
import { getModelRoles } from "../../orchestration/model-roles.js"
import { AGENT_EXPLORE, AGENT_GENERAL_PURPOSE, AGENT_PLAN, AGENT_RESEARCHER, type AgentConfig } from "./types.js"

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"]

/** Pick models by strength; returns undefined if no model has the strength so the persona falls through to inherit.
 *  @deprecated Preserved for custom persona backward compatibility. Default agents now use role-based config. */
function pick(strengths: readonly ("review" | "build" | "plan" | "explore" | "research")[]): string[] | undefined {
	const list = strengths.length === 1 ? modelsForStrength(strengths[0]) : modelsForAnyStrength(strengths)
	return list.length > 0 ? list : undefined
}

/** Resolve model list for a role. Returns the role's model wrapped in an array,
 *  or falls back to strength-based lookup if the role model is empty. */
function roleModels(
	roleModel: string,
	fallbackStrengths: readonly ("review" | "build" | "plan" | "explore" | "research")[],
): string[] | undefined {
	if (roleModel) return [roleModel]
	return pick(fallbackStrengths)
}

function buildDefaultAgents(): Map<string, AgentConfig> {
	const roles = getModelRoles()
	return new Map([
		[
			AGENT_GENERAL_PURPOSE,
			{
				name: AGENT_GENERAL_PURPOSE,
				displayName: "General Purpose",
				description: "General-purpose agent for complex, multi-step tasks",
				extensions: true,
				skills: true,
				models: roleModels(roles.builder, ["build", "explore", "plan", "review", "research"]),
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
				models: roleModels(roles.explorer, ["explore"]),
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
				includeContextFiles: true,
				skills: true,
				models: roleModels(roles.planner, ["plan"]),
				strengths: ["plan"],
				preferTier: "heavy",
				thinking: "high",
				tokenBudget: 120_000,
				systemPrompt:
					`# Plan Agent — Write Access Scoped to .kimchi/plans/
You are a planning specialist. Your role is to understand requirements, ask clarifying questions, and design clear plans.

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

1. **Decide whether to explore first.** Only read files if the task is about code or software. If the task is NOT about code (writing, strategy, general planning), skip exploration entirely and go straight to clarifying questions.
2. **Draft the plan directly.** Do NOT use \`request_ferment_workflow\`, ferment tools, or any workflow-starting mechanism.
3. Understand requirements — ask clarifying questions via \`questionnaire\` before committing to an approach.
4. If code-related: explore relevant files, understand architecture, identify patterns.
5. Identify ambiguities and resolve them with the user before proceeding.
6. Design a solution and write the plan.
7. Verify there are no unresolved assumptions before finalising.

# Requirements
- Consider trade-offs and decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Use \`questionnaire\` when you encounter ambiguity — do not leave it implicit
- Use write only to create/update \`.kimchi/plans/*.md\` files
- Use edit only to modify \`.kimchi/plans/*.md\` files

# Plan Format
Use this structure in every plan file:

## Goal
One-sentence statement of what the plan achieves.

## Constraints
Non-negotiable requirements (e.g., no new dependencies, preserve existing API).

## Chunks
Ordered, independently-verifiable units of work. Each chunk has:
- **Scope**: what it covers (file paths, components)
- **Depends On**: prior chunk(s) required
- **Accept When**: 2-3 concrete, verifiable criteria
- **Open Questions**: explicitly list unknowns or assumptions — never leave implicit

## Verification Strategy
How to confirm each chunk is correct (test command, manual check, etc.).

## Decision Log
Tracked choices with rationale; rejected alternatives noted.

## Risks
Named risks with likelihood and mitigation.

# Question Rule

**Ask clarifying questions before committing to a plan.** If the request omits information you need to choose a technology, bound the scope, or set performance targets, use the \`questionnaire\` tool. Ask 1–3 focused questions. Prefer multi questions when multiple options apply; single for one choice. Do not ask preference-survey questions when a safe default is obvious.

# Finalization Rule

**Do not present the plan as complete and ready for approval while any Open Question remains unresolved.** You may present *draft* plans with explicit assumptions listed, but before finalizing you must use the \`questionnaire\` tool to resolve each assumption with the user.

When your plan is complete, finished, and ready for user approval, end your response with one of these markers on its own line:

` +
					"<!-- PLAN_COMPLETE -->" +
					`

or simply:

` +
					"<done>" +
					`

Either marker signals the system to show the approval menu. Do NOT include them on incomplete drafts, while assumptions remain unresolved, or when asking clarifying questions.

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
				models: roleModels(roles.orchestrator, ["research"]),
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
}

export const DEFAULT_AGENTS: Map<string, AgentConfig> = buildDefaultAgents()
