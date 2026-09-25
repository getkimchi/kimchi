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
import { resolvePhaseGuideline } from "../orchestration/model-registry/guidelines/guidelines-resolver.js"
import type { ModelRegistry } from "../orchestration/model-registry/index.js"
import type { Phase } from "../orchestration/model-registry/types.js"
import type { ModelRoles } from "../orchestration/model-roles.js"
import { resolveOrchestrationInstructions } from "../orchestration/orchestration-instructions.js"
import { orchestratorShouldReceivePhaseGuidelines } from "../orchestration/orchestrator-roles.js"
import type { ContextFile } from "./context-files.js"
import { ORCHESTRATOR_SUPPRESSED_SKILL_NAMES } from "./orchestrator-suppressed-skills.js"
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

export const SET_PHASE = "set_phase"

export const DELEGATION_TOOL_NAMES = new Set(["Agent", "resume_subagent", "get_subagent_result", "steer_subagent"])

export function buildSystemPrompt(options: SystemPromptBuildOptions): string {
	const { tools, env, contextFiles, skills, currentModelId, registry, mode, roles, sessionId } = options

	const effectiveTools = mode === "subagent" ? tools.filter((t) => !DELEGATION_TOOL_NAMES.has(t.name)) : tools

	const toolsSection = formatToolsSection(effectiveTools)
	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)
	const filteredSkills = filterSkillsForMode(skills, mode)

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
		toolsSection,
		environmentSection,
		projectContext,
		skillsSection: formatSkills(filteredSkills),
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
	toolsSection: string
	environmentSection: string
	projectContext: string
	skillsSection: string
	orchestrationSection: string
	systemPromptBlocks: string
	suppressed: ReadonlySet<SuppressibleSection>
	currentModelId?: string
	registry?: ModelRegistry
	roles?: ModelRoles
	hasUserLoop: boolean
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

${orientation}You are running in single-model mode.${modelClause} All work in this session runs on the currently selected model. Handle tasks directly yourself.

Do not spawn subagents with the \`Agent\` tool by default — only do so when the user explicitly asks for delegation. When you do spawn a subagent, pass your own model ID in the \`model\` parameter by default; only use a different model if the user explicitly instructs it.`
}

export const DOCUMENTS_SECTION =
	"Use the Documents directory (see Environment) for transient working files: research notes, findings, verification reports, inter-agent handoffs. Final plans and specs go to .kimchi/plans/<slug>.md. Never write working documents to the project root or temp directories."

export const CORE_GUIDELINES = `- Be concise in your responses. Do not restate completed steps — act and move on.
- Gather context before starting: requirements, naming conventions, frameworks and libraries in use, how to run and test. Read existing code rather than assuming.
- Follow existing conventions; use only libraries/frameworks present in the codebase; never add dependencies without explicit instruction.
- Deliver complete, working code — no placeholders, omissions, or TODOs.
- Verify your work: edited files complete and correct, tests or the code run if possible.
- Use absolute file paths.
- Do NOT introduce security vulnerabilities.
- After every tool result, ALWAYS produce text — the next tool call with explicit reasoning, or a final summary. Never re-issue the same call after a successful result.
- Never emit tool calls with empty names, blank IDs, or malformed arguments. If a call fails to advance the task after 3 attempts, stop, summarize what is broken, and reassess in plain text.
- Bound shell commands with the bash tool's \`timeout\` parameter (default 60s) — never the GNU \`timeout\` binary (missing on macOS and Windows).
- Never run interactive commands (e.g. \`git rebase\`, \`npm init\`): use non-interactive flags (\`--yes\`, \`GIT_EDITOR=true\`) or redirect stdin from \`/dev/null\`.
- **Git commits**: end the message with a blank line, then \`Co-Authored-By: Kimchi <noreply@kimchi.dev>\`.`

/** The orient-the-user bullet, swapped for a proceed-autonomously variant in
 *  userless orchestrator sessions so it never contradicts
 *  AUTONOMOUS_SESSION_NOTE ("no human available"). */
const ORCHESTRATOR_ORIENTATION_BULLETS = {
	userLoop:
		"- Orient the user per Orchestration before starting — use the phased pipeline, not ad-hoc exploration or inline implementation.",
	autonomous:
		"- Proceed autonomously per Orchestration — use the phased pipeline, not ad-hoc exploration or inline implementation. No human is available to orient; do not pause for confirmation.",
} as const

function buildOrchestratorGuidelines(hasUserLoop: boolean): string {
	return `- Be concise. Do not restate completed steps — act and move on.
- Follow **Orchestration** for what to do yourself vs delegate. Do not read implementation files, write or edit source code, run tests, or review diffs unless Orchestration **Phase responsibilities** explicitly says DO for your current phase and role.
${hasUserLoop ? ORCHESTRATOR_ORIENTATION_BULLETS.userLoop : ORCHESTRATOR_ORIENTATION_BULLETS.autonomous}
- Follow existing conventions; use only libraries/frameworks present in the codebase; never add dependencies without explicit instruction.
- Use absolute file paths.
- Do NOT introduce security vulnerabilities.
- After every tool result, ALWAYS produce text — the next tool call with explicit reasoning, or a final summary. Never re-issue the same call after a successful result.
- Never emit tool calls with empty names, blank IDs, or malformed arguments. If a call fails to advance the task after 3 attempts, stop, summarize what is broken, and reassess in plain text.
- Summarize from delegated artifacts (spec, review, verification files); do not re-verify implementation yourself unless Orchestration assigns it to you.`
}

function filterSkillsForMode(skills: readonly Skill[] | undefined, mode: PromptMode): readonly Skill[] | undefined {
	if (!skills || mode !== "orchestrator") return skills
	return skills.filter((skill) => !ORCHESTRATOR_SUPPRESSED_SKILL_NAMES.has(skill.name))
}

function resolveCoreGuidelines(mode: PromptMode, hasUserLoop: boolean): string {
	if (mode !== "orchestrator") return CORE_GUIDELINES
	return buildOrchestratorGuidelines(hasUserLoop)
}

export const FACTUAL_ACCURACY = `- Never guess, assume, or fabricate. Claims must rest on data concretely obtained this session. Do not over-escalate minor issues or blame the user for request phrasing.
- Never invent people's names, roles, or contact details — ask the user if human input is needed.
- "I don't know" is valid. When requirements or facts are unavailable through tools or user messages, say so and ask — do not fill gaps with plausible-sounding content.
- Label uncertain reasoning as an assumption and ask for confirmation before acting on it.`

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
			"- GitHub/GitLab CLI: `--log-failed`, `--jq`, `| tail -N` — `gh run view --log` and `--paginate` calls are huge. `glab ci view` is a TUI — use `glab ci trace` headless. Big PR/MR diffs: list changed paths first, then targeted reads.",
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

export const PHASE_MANAGEMENT_INTRO = `## Phase Management

The session starts in \`explore\` phase by default. Call \`set_phase\` when the work type changes — pick one of \`explore\`, \`research\`, \`plan\`, \`build\`, or \`review\`. Only one phase is active at a time; the most recent call wins. Subagents set their phase automatically from their persona, so this tool is for tagging the main thread's work.

When the orchestrator decides to perform a phase itself (not delegate), include the matching \`thinking\` parameter from the Orchestration **Thinking levels** table. Leave \`thinking\` unset when only tagging coordination work or when delegating the phase to an Agent.`

const PHASE_ORDER: readonly Phase[] = ["explore", "research", "plan", "build", "review"]

/**
 * Build the consolidated ## Phase Management section, resolving each phase's
 * guideline through the model registry so family-specific overrides (e.g.
 * MiniMax M2's "STAY IN SCOPE" / "do NOT hallucinate APIs") reach the prompt.
 *
 * Applicable phases are embedded (not just the active one) to keep the prompt
 * static across phase transitions. Single-model and subagent prompts receive
 * all phases; orchestrators receive only phases allowed by their stable role
 * assignments. Swapping content on `set_phase` would invalidate the provider's
 * KV cache, while role and model resolution remain cache-stable for the session.
 */
export function buildPhaseManagementSection(
	modelId?: string,
	registry?: ModelRegistry,
	phaseToolReachable = true,
	mode: PromptMode = "single",
	roles?: ModelRoles,
): string {
	// Single-mode agents that cannot call set_phase never tag phases, so the
	// phase-tagging guidance is inert. When set_phase is unreachable (e.g. plain
	// --print sessions, where the print-mode gate suppresses it), drop the
	// payload to save ~2,100 est. Tool-independent safety rules that used to ride
	// this payload (commit trailer, shell timeouts, non-interactive-command
	// flags) now live in CORE_GUIDELINES, which is always emitted — so --print
	// still gets them. Interactive single-model sessions keep set_phase and
	// therefore the full payload. Orchestrator/subagent modes are unaffected
	// (persona/role phase behaviour applies regardless of the tool).
	if (mode === "single" && !phaseToolReachable) return ""
	const applicablePhases =
		mode === "orchestrator"
			? PHASE_ORDER.filter((phase) => orchestratorShouldReceivePhaseGuidelines(phase, modelId, roles))
			: PHASE_ORDER
	const guidelines = applicablePhases.map((phase) => resolvePhaseGuideline(phase, modelId, registry)).join("\n\n")
	const intro = phaseToolReachable ? PHASE_MANAGEMENT_INTRO : "## Phase Management"
	if (!guidelines) return phaseToolReachable ? intro : ""
	return `${intro}\n\n### Phase-specific behaviour\n\n${guidelines}`
}

export const CONSENT_AND_IRREVERSIBLE_ACTIONS = `## Consent & Irreversible Actions

Ask before unrequested actions that publish externally, mutate remote state, or are irreversible. A user's request to change code authorizes ordinary local workspace edits and verification commands; it does not authorize publishing or remote state changes. Internal planning artifacts such as todo lists never grant approval.

Approval covers exactly the action the user requested — not escalations or workarounds. A request to "push" does not authorize opening a pull request; "commit" does not authorize tagging a release. A request to investigate an issue, evaluate options, or draft a plan authorizes only the analysis — report the findings and wait for the user's go-ahead before writing or modifying code. If a requested action is blocked or fails, propose the alternative and wait for the user to choose.

- GitHub CLI: no mutating \`gh\` commands unprompted — pr/issue/review/merge/release write verbs and any \`gh api POST/PATCH/PUT/DELETE\`. Read-only commands are fine.
- GitLab CLI: same rule — mutating \`glab\` verbs (incl. approve, note resolve, rebase, retry) and \`glab api POST/PUT/PATCH/DELETE\` need explicit approval.
- Git remote ops: pushing branches, force-push, deleting branches/tags need explicit approval.`

/** Replacement for the user-presence-only sections (Consent, Harness Notes,
 *  Documents) when the session has no human in the loop: one directive instead
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
	sections.push(`## Guidelines\n\n${resolveCoreGuidelines(parts.mode, parts.hasUserLoop)}`)
	sections.push(`## Factual Accuracy\n\n${FACTUAL_ACCURACY}`)

	// 5. Documents (a human reads artifacts in interactive sessions; multi-agent
	//    flows write handoffs there even without a user loop — keep the section
	//    for orchestrator/subagent so subagent result contracts stay grounded)
	if (parts.hasUserLoop || parts.mode === "orchestrator" || parts.mode === "subagent") {
		sections.push(`## Documents\n\n${DOCUMENTS_SECTION}`)
	}

	// 6. Consolidated core sections: output, tool selection, phase, consent
	sections.push(buildOutputAndTruncationSection(parts.toolNames))
	sections.push(buildToolSelectionSection(parts.toolNames))
	sections.push(
		buildPhaseManagementSection(
			parts.currentModelId,
			parts.registry,
			parts.toolNames.has(SET_PHASE),
			parts.mode,
			parts.roles,
		),
	)
	if (parts.hasUserLoop) {
		sections.push(CONSENT_AND_IRREVERSIBLE_ACTIONS)
		sections.push(HARNESS_NOTES_AND_APPROVAL)
	} else {
		sections.push(AUTONOMOUS_SESSION_NOTE)
	}

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
	// The API request already carries each
	// tool's description in the function-calling payload, so embedding a second
	// copy here pays ~3,000 est per call for duplicated text. Keep the prompt
	// section to the discovery surface (names) — the model learns what each
	// tool does from the API-side description.
	const names = tools.map((t) => t.name).join(", ")
	return `## Available Tools\n\n${names}`
}

export function formatEnvironmentSection(env: EnvironmentInfo): string {
	const shellFamily = inferShellFamily(env)
	const lines = [
		"## Environment",
		"",
		`- OS: ${env.os}`,
		`- OS version: ${env.osVersion}`,
		`- Raw platform: ${env.rawPlatform}`,
		`- CPU architecture: ${env.cpuArchitecture}`,
		`- Shell: ${env.shell}`,
		`- Shell family: ${shellFamily}`,
		"- Command guidance: use commands compatible with the shell family (POSIX vs PowerShell/cmd syntax); if shell/platform conflict or are unclear, check with a read-only command before write/destructive ones.",
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

/** Render-time description budget per skill (Codex-style metadata budget:
 *  name + a bounded description always ride in the prompt, the body loads on
 *  demand). Long authored descriptions are truncated at a word boundary. */
const SKILL_DESCRIPTION_MAX_CHARS = 200

function truncateDescription(description: string): string {
	const trimmed = description.trim()
	if (trimmed.length <= SKILL_DESCRIPTION_MAX_CHARS) return trimmed
	const cut = trimmed.slice(0, SKILL_DESCRIPTION_MAX_CHARS)
	const lastSpace = cut.lastIndexOf(" ")
	return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`
}

/** Markdown skills catalog — same formatting language as the rest of the
 *  prompt (no XML). Name + description are always in context; the SKILL.md
 *  body enters only when the agent reads the file. Mirrors the Codex
 *  three-level loading model (metadata → body → scripts). */
function formatSkills(skills?: readonly Skill[]): string {
	const visible = (skills ?? []).filter((skill) => !skill.disableModelInvocation)
	if (visible.length === 0) return ""
	const lines = [
		"## Skills",
		"",
		"The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, read its SKILL.md with the read tool and follow it. Resolve paths referenced inside a skill file against that file's directory.",
		"",
	]
	for (const skill of visible) {
		lines.push(`- **${skill.name}** — ${truncateDescription(skill.description)} (\`${skill.filePath}\`)`)
	}
	return lines.join("\n")
}
