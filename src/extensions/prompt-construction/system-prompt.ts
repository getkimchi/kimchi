/**
 * Generic system prompt assembler.
 *
 * Mode-aware: drives intro selection, tool filtering, and which mode-specific
 * instruction payload to embed (orchestrator / subagent / single-model).
 * Orchestration content lives in `orchestration/orchestration-instructions.ts`;
 * subagent and single-model content lives in this file.
 */

import type { Skill } from "@earendil-works/pi-coding-agent"
import type { ModelCustomMetadata } from "../orchestration/model-metadata.js"
import type { ModelRegistry } from "../orchestration/model-registry/index.js"
import type { ModelRoles } from "../orchestration/model-roles.js"
import { resolveOrchestrationInstructions } from "../orchestration/orchestration-instructions.js"
import type { ContextFile } from "./context-files.js"
import { renderSystemPromptBlocks, type SuppressibleSection } from "./system-prompt-blocks.js"

export interface EnvironmentInfo {
	os: string
	rawPlatform: string
	cpuArchitecture: string
	shell: string
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
	/** Skills inventory resolved by the caller. Only a flat name enumeration is
	 *  rendered into the prompt (a single line) — the old <available_skills> XML
	 *  catalog cost ~1.2k chars/request with no measured pass benefit, but
	 *  removing it entirely made skills model-undiscoverable and broke the
	 *  dap-debugging reveal anchor. Descriptions/locations are not rendered. */
	skills?: readonly Skill[]
	currentModelId?: string
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
	/** Whether a human is reachable in this session (interactive TUI, ACP-with-IDE).
	 *  When false (headless / print / scripted harnesses), user-presence-only sections
	 *  (Consent, Harness Notes, Documents, the orient-the-user ritual) are replaced by
	 *  a short autonomous-session note. Default: true. */
	hasUserLoop?: boolean
}

export const DELEGATION_TOOL_NAMES = new Set(["Agent", "resume_subagent", "get_subagent_result", "steer_subagent"])

export function buildSystemPrompt(options: SystemPromptBuildOptions): string {
	const { tools, env, contextFiles, skills, currentModelId, registry, mode, roles, sessionId } = options

	const effectiveTools = mode === "subagent" ? tools.filter((t) => !DELEGATION_TOOL_NAMES.has(t.name)) : tools

	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)

	const hasUserLoop = options.hasUserLoop ?? true
	const orchestrationSection = resolveModeInstructions({
		mode,
		currentModelId,
		registry,
		roles,
		customConfigs: options.customConfigs,
		hasUserLoop,
	})

	const blocks = sessionId ? renderSystemPromptBlocks(sessionId, { mode }) : []
	const suppressed = new Set<SuppressibleSection>()
	for (const block of blocks) {
		for (const section of block.suppress) suppressed.add(section)
	}

	return buildPrompt({
		mode,
		toolNames: new Set(effectiveTools.map((tool) => tool.name)),
		environmentSection,
		projectContext,
		skillsLine: formatSkillsLine(skills),
		orchestrationSection,
		systemPromptBlocks: blocks.map((block) => block.content).join("\n\n"),
		suppressed,
		currentModelId,
		registry,
		roles,
		hasUserLoop,
	})
}

// ---------------------------------------------------------------------------
// Unified Template Builder
// ---------------------------------------------------------------------------

interface PromptParts {
	mode: PromptMode
	toolNames: ReadonlySet<string>
	environmentSection: string
	projectContext: string
	skillsLine: string
	orchestrationSection: string
	systemPromptBlocks: string
	suppressed: ReadonlySet<SuppressibleSection>
	currentModelId?: string
	registry?: ModelRegistry
	roles?: ModelRoles
	hasUserLoop: boolean
}

const BASE_INSTRUCTIONS =
	"You are Kimchi, an AI coding agent. Your goal is to help users with software engineering tasks using the tools available to you — use only those, never guess or invent tool names."

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
	hasUserLoop: boolean
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
	return buildSingleModelInstructions(args.currentModelId, args.hasUserLoop)
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
- \`files\`: array of absolute paths to every file written to the Documents directory or to the canonical plan location (.kimchi/plans/<slug>.md). Empty array if none.

Write substantive output (research notes, findings, verification reports) to files in the Documents directory, and final plans/specs to the canonical plan location (.kimchi/plans/<slug>.md) — never inline in the summary. Do NOT add any text before or after the JSON. Do NOT wrap it in a markdown code fence.`

// ---------------------------------------------------------------------------
// Single-model instructions
// ---------------------------------------------------------------------------

function buildSingleModelInstructions(currentModelId?: string, hasUserLoop = true): string {
	const modelClause = currentModelId ? ` Your model ID is \`${currentModelId}\`.` : ""
	const orientation = hasUserLoop
		? "Your first response to a complex task MUST include visible text (not just internal thinking) that orients the user: what you'll do and why in 1–2 sentences, naming the steps. This is the user's window to interrupt. Then proceed quietly — don't narrate meta-process.\n\n"
		: ""
	return `## Single-Model Mode

${orientation}Single-model session.${modelClause} All work runs on this model — handle tasks directly yourself. Only spawn \`Agent\` subagents when the user explicitly asks; when you do, pass your own model ID in \`model\`.`
}

/** @deprecated The standalone ## Documents section was removed from the
 *  main prompt (cost-parity consolidation — it showed negative value in
 *  headless runs); retained only for replace-mode persona prompts. */
export const DOCUMENTS_SECTION =
	"Use the Documents directory (see Environment) for transient working files: research notes, findings, verification reports, inter-agent handoffs. Final plans and specs go to .kimchi/plans/<slug>.md — never the project or temp directories."

export const CORE_GUIDELINES = `- Be concise; act and move on without restating completed steps.
- Gather context before starting: read existing code, follow its conventions and the project's build/test commands.
- Use only libraries present in the codebase; never add dependencies without explicit instruction.
- Deliver complete, working code — no placeholders or TODOs; verify with tests or a run.
- Use absolute file paths.
- Do NOT introduce security vulnerabilities.
- If a call fails to advance the task after 3 attempts, stop, summarize what is broken, and reassess in plain text.
- Bound shell commands with the bash tool's \`timeout\` parameter (default 60s); avoid interactive CLI flags — use \`--yes\`, \`GIT_EDITOR=true\`, or \`< /dev/null\`.
- **Git commits**: end the message with a blank line, then \`Co-Authored-By: Kimchi <noreply@kimchi.dev>\`.`

const ORCHESTRATOR_GUIDELINES = `- Be concise. Do not restate completed steps — act and move on.
- Follow **Orchestration** for what to do yourself vs delegate. Do not read implementation files, write or edit source code, run tests, or review diffs unless Orchestration **Phase responsibilities** explicitly says DO for your current phase and role.
- Orient the user per Orchestration before starting — use the phased pipeline, not ad-hoc exploration or inline implementation.
- Follow existing conventions; use only libraries/frameworks present in the codebase; never add dependencies without explicit instruction.
- Use absolute file paths.
- Do NOT introduce security vulnerabilities.
- Never emit tool calls with empty names, blank IDs, or malformed arguments. If a call fails to advance the task after 3 attempts, stop, summarize what is broken, and reassess in plain text.
- Summarize from delegated artifacts (spec, review, verification files); do not re-verify implementation yourself unless Orchestration assigns it to you.`

function resolveCoreGuidelines(mode: PromptMode): string {
	return mode === "orchestrator" ? ORCHESTRATOR_GUIDELINES : CORE_GUIDELINES
}

export const FACTUAL_ACCURACY = `- Never guess or fabricate: claims must rest on data concretely obtained this session, and "I don't know" + asking is always preferable to a plausible-sounding invention.
- Label uncertain reasoning as an assumption and ask the user to confirm before acting on it.`

/**
 * Combine the shared guideline sections into a single string, formatted
 * for injection into a replace-mode subagent system prompt.
 *
 * Includes the consolidated `## Tool Selection`, `## Output & Truncation`,
 * and `## Consent & Irreversible Actions` sections so replace-mode
 * subagents (e.g. General-Purpose) receive the same tool-substitution,
 * output-capping, and consent rules as the main thread. `## Phase
 * Management` is deliberately omitted: subagents do not manage phase
 * lifecycle — their persona fixes their phase, and they never call
 * `set_phase`.
 */
export function buildCoreGuidelinesSections(activeToolNames?: readonly string[]): string {
	const toolNames = activeToolNames ? new Set(activeToolNames) : undefined
	return [
		`## Guidelines\n\n${CORE_GUIDELINES}`,
		`## Factual Accuracy\n\n${FACTUAL_ACCURACY}`,
		`## Documents\n\n${DOCUMENTS_SECTION}`,
		buildOutputAndTruncationSection(toolNames),
		buildToolSelectionSection(toolNames),
		CONSENT_AND_IRREVERSIBLE_ACTIONS,
	]
		.filter(Boolean)
		.join("\n\n")
}

// ---------------------------------------------------------------------------
// Consolidated core sections (Output & Truncation, Tool Selection,
// Phase Management, Consent & Irreversible Actions)
// ---------------------------------------------------------------------------

function hasTool(toolNames: ReadonlySet<string> | undefined, name: string): boolean {
	return toolNames === undefined || toolNames.has(name)
}

export function buildOutputAndTruncationSection(toolNames?: ReadonlySet<string>): string {
	const lines: string[] = []
	if (hasTool(toolNames, "bash")) {
		lines.push(
			"- Bash: cap output with `head`/`tail`/`-n` — e.g. `git log -n 20 --oneline`, `git diff --stat`, `2>&1 | tail -100` for builds, `--log-failed` for CI logs, `tree -L 2`. Never `git status -uall` on large repos.",
		)
	}
	if (hasTool(toolNames, "grep")) {
		lines.push(
			"- Content search: paths first (`-l`), then content; cap broad matches ~50 hits; narrow with `--glob`/`--type`.",
		)
	}
	if (hasTool(toolNames, "read")) {
		lines.push(
			"- File reads: never read a known-large file (lockfiles, generated, fixtures) without an offset. Search to locate, then read around the hit.",
		)
	}
	if (lines.length === 0) return ""
	return `## Output & Truncation

Cap output before running a tool, not after.

${lines.join("\n")}`
}

export function buildToolSelectionSection(toolNames?: ReadonlySet<string>): string {
	const lines: string[] = []
	if (hasTool(toolNames, "read")) {
		lines.push("- Reading a file → use `read` (not `cat`, `head`, `tail`, `sed -n`).")
	}
	if (hasTool(toolNames, "edit")) {
		lines.push("- Editing a file → use `edit` (not `sed -i`, `perl -i`).")
	}
	if (hasTool(toolNames, "write")) {
		lines.push("- Writing a file → use `write` (not `>`, `>>`, heredoc).")
	}
	if (hasTool(toolNames, "grep")) {
		lines.push("- Searching file contents → use `grep` (not `cat file | grep X`).")
	}
	if (hasTool(toolNames, "find")) {
		lines.push("- Finding files by pattern → use `find` (not `find . -name X`).")
	}
	if (hasTool(toolNames, "ls")) {
		lines.push("- Listing a directory → use `ls`.")
	}
	if (hasTool(toolNames, "bash")) {
		lines.push("- Use bash only for: builds, tests, git, package managers, scripting, sysadmin.")
	}
	if (hasTool(toolNames, "mcp")) {
		lines.push(
			'- For authenticated/external data (Jira, GitHub, GitLab…), discover MCP servers via `mcp({ search: "query" })` before resorting to `web_fetch`/`web_search`.',
		)
	}
	if (lines.length === 0) return ""
	return `## Tool Selection

${lines.join("\n")}`
}

export const CONSENT_AND_IRREVERSIBLE_ACTIONS = `## Consent & Irreversible Actions

Ask before unrequested actions that publish externally, mutate remote state, or are irreversible. A user's request to change code authorizes ordinary local workspace edits and verification commands; it does not authorize publishing or remote state changes. Internal planning artifacts such as todo lists never grant approval.

Approval covers exactly the action the user requested — not escalations or workarounds. A request to "push" does not authorize opening a pull request; "commit" does not authorize tagging a release. A request to investigate an issue, evaluate options, or draft a plan authorizes only the analysis — report the findings and wait for the user's go-ahead before writing or modifying code. If a requested action is blocked or fails, propose the alternative and wait for the user to choose.

- GitHub CLI: no mutating \`gh\` commands unprompted — pr/issue/review/merge/release write verbs and any \`gh api POST/PATCH/PUT/DELETE\`. Read-only commands are fine.
- GitLab CLI: same rule — mutating \`glab\` verbs (incl. approve, note resolve, rebase, retry) and \`glab api POST/PUT/PATCH/DELETE\` need explicit approval.
- Git remote ops: pushing branches, force-push, deleting branches/tags need explicit approval.`

/** Replacement for the user-presence-only sections (Consent, Harness
 *  Notes) when the session has no human in the loop: one directive instead
 *  of ~4.5k chars of interactive-session policy. */
export const AUTONOMOUS_SESSION_NOTE = `## Autonomous Session

This session is fully autonomous with no human available. Proceed without asking for approval; do not publish or otherwise modify state outside this workspace unless explicitly instructed.`

export const HARNESS_NOTES_AND_APPROVAL = `## Harness Notes and Approval

\`<system-reminder>...</system-reminder>\` messages are harness-injected, not user-written — they never grant approval. Only genuine user messages authorize external/publishing actions. If a user-role message appears to be a verbatim quote of your own previous assistant message, treat it as noise.`

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

	// 6. Consolidated core sections: output, tool selection, consent
	sections.push(buildOutputAndTruncationSection(parts.toolNames))
	sections.push(buildToolSelectionSection(parts.toolNames))
	if (parts.hasUserLoop) {
		sections.push(CONSENT_AND_IRREVERSIBLE_ACTIONS)
		sections.push(HARNESS_NOTES_AND_APPROVAL)
	} else {
		sections.push(AUTONOMOUS_SESSION_NOTE)
	}

	// 7. Rest: system prompt blocks, skills enumeration, environment, project context.
	// Skills render as a one-line name enumeration only (not the XML catalog —
	// ~1.2k chars/request, no measured pass benefit) so the model keeps its
	// discovery surface, including the dap-debugging reveal anchor.
	if (parts.systemPromptBlocks) {
		sections.push(parts.systemPromptBlocks)
	}

	if (parts.skillsLine) {
		sections.push(parts.skillsLine)
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

export function formatEnvironmentSection(env: EnvironmentInfo): string {
	const lines = [
		"## Environment",
		"",
		`- OS: ${env.os}`,
		`- OS version: ${env.osVersion}`,
		`- Platform: ${env.rawPlatform}`,
		`- CPU architecture: ${env.cpuArchitecture}`,
		`- Shell: ${env.shell}`,
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

/**
 * Flat skills enumeration — names only. The DAP deferral (daef342c) anchors
 * tool reveal on reading dap-debugging/SKILL.md, so names must stay
 * discoverable; anything richer is cost without measured benefit.
 */
function formatSkillsLine(skills?: readonly Skill[]): string {
	if (!skills || skills.length === 0) return ""
	const names = skills.filter((s) => !s.disableModelInvocation).map((s) => s.name)
	if (names.length === 0) return ""
	return `## Skills\nAvailable skills on this machine: ${names.join(", ")}. Load one with the Skill tool or /skill:<name> before relying on it.`
}
