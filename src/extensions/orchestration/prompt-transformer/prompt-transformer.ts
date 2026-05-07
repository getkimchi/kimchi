import { type Skill, formatSkillsForPrompt } from "@mariozechner/pi-coding-agent"
import { DEFAULT_ORCHESTRATION_GUIDELINES } from "../model-registry/guidelines/default-orchestration-guidelines.js"
import { DEFAULT_PHASE_GUIDELINES } from "../model-registry/guidelines/default-phase-guidelines.js"
import type { ModelRegistry } from "../model-registry/index.js"
import type { OrchestrationModelDescriptor, Phase } from "../model-registry/types.js"
import type { ContextFile } from "./context-files.js"
import systemPromptTemplate from "./prompts/orchestrator-system-prompt.js"
import singleModelSystemPromptTemplate from "./prompts/single-model-system-prompt.js"
import subagentSystemPromptTemplate from "./prompts/subagent-system-prompt.js"
import { userPromptHeader, userPromptTaskSection } from "./prompts/transformed-user-prompt.js"

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

const SUBAGENT_TOOL_NAME = "subagent"

function formatModel(model: OrchestrationModelDescriptor): string {
	const strengths = model.capabilities.strengths.join(", ")
	const vision = model.capabilities.vision ? "yes" : "no"
	return [
		`- **${model.name}** (id: \`${model.id}\`, provider: \`${model.provider}\`)`,
		`  Tier: ${model.capabilities.tier} | Strengths: ${strengths} | Vision: ${vision}`,
		`  ${model.capabilities.description}`,
	].join("\n")
}

function formatCurrentModelCapabilities(model: OrchestrationModelDescriptor): string {
	const strengths = model.capabilities.strengths.join(", ")
	const vision = model.capabilities.vision ? "yes" : "no"
	return [
		`Tier: ${model.capabilities.tier} | Strengths: ${strengths} | Vision: ${vision}`,
		model.capabilities.description,
	].join("\n")
}

function formatModelsSection(models: readonly OrchestrationModelDescriptor[]): string {
	if (models.length === 0) {
		return "(No models available)"
	}
	return models.map(formatModel).join("\n\n")
}

export interface PromptContext {
	currentModelId?: string
	currentPhase?: Phase
	registry?: ModelRegistry
}

export interface ToolInfo {
	name: string
	description: string
}

export interface CurrentModelInfo {
	id: string
	name: string
}

export function transformPrompt(
	userPrompt: string,
	registry: ModelRegistry,
	currentModel?: CurrentModelInfo,
	includeTask = true,
): string {
	const subagentModels = registry.getModelsWithCapabilities().filter((m) => m.id !== currentModel?.id)
	const modelsSection = formatModelsSection(subagentModels)

	const currentModelName = currentModel?.name ?? "unknown"

	// Only show capabilities when the current model has a real capability entry.
	// Unknown models get only the fallback text because generic defaults would be misleading.
	const currentDescriptor = currentModel
		? registry.getModelsWithCapabilities().find((m) => m.id === currentModel.id)
		: undefined
	const currentModelCapabilities = currentDescriptor
		? formatCurrentModelCapabilities(currentDescriptor)
		: "No capability information available for this model."

	const template = includeTask ? userPromptHeader + userPromptTaskSection : userPromptHeader

	return template
		.replace("{{CURRENT_MODEL_NAME}}", () => currentModelName)
		.replace("{{CURRENT_MODEL_CAPABILITIES}}", () => currentModelCapabilities)
		.replace("{{MODELS}}", () => modelsSection)
		.replace("{{USER_PROMPT}}", () => userPrompt)
}

export function buildOrchestratorSystemPrompt(
	tools: readonly ToolInfo[],
	env: EnvironmentInfo,
	contextFiles?: readonly ContextFile[],
	skills?: readonly Skill[],
	promptCtx?: PromptContext,
): string {
	const toolsSection = formatToolsSection(tools)
	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)
	const skillsSection = formatSkills(skills)
	const base = systemPromptTemplate
		.replace("{{TOOLS}}", () => toolsSection)
		.replace("{{ENVIRONMENT}}", () => environmentSection)
		.replace("{{PROJECT_CONTEXT}}", () => projectContext)
		.replace("{{SKILLS}}", () => skillsSection)
	const orchestrationSection = buildOrchestrationGuidelinesSection(promptCtx?.currentModelId, promptCtx?.registry)
	const phaseSection = buildPhaseGuidelinesSection(
		promptCtx?.currentModelId,
		promptCtx?.currentPhase,
		promptCtx?.registry,
	)
	return base + orchestrationSection + phaseSection
}

export function buildSingleModelSystemPrompt(
	tools: readonly ToolInfo[],
	env: EnvironmentInfo,
	contextFiles?: readonly ContextFile[],
	skills?: readonly Skill[],
	promptCtx?: PromptContext,
): string {
	const toolsSection = formatToolsSection(tools)
	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)
	const skillsSection = formatSkills(skills)
	const base = singleModelSystemPromptTemplate
		.replace("{{TOOLS}}", () => toolsSection)
		.replace("{{ENVIRONMENT}}", () => environmentSection)
		.replace("{{PROJECT_CONTEXT}}", () => projectContext)
		.replace("{{SKILLS}}", () => skillsSection)
	const phaseSection = buildPhaseGuidelinesSection(
		promptCtx?.currentModelId,
		promptCtx?.currentPhase,
		promptCtx?.registry,
	)
	return base + phaseSection
}

export function buildSubagentSystemPrompt(
	tools: readonly ToolInfo[],
	env: EnvironmentInfo,
	contextFiles?: readonly ContextFile[],
	skills?: readonly Skill[],
	promptCtx?: PromptContext,
): string {
	const filtered = tools.filter((t) => t.name !== SUBAGENT_TOOL_NAME)
	const toolsSection = formatToolsSection(filtered)
	const environmentSection = formatEnvironmentSection(env)
	const projectContext = formatProjectContext(contextFiles)
	const skillsSection = formatSkills(skills)
	const base = subagentSystemPromptTemplate
		.replace("{{TOOLS}}", () => toolsSection)
		.replace("{{ENVIRONMENT}}", () => environmentSection)
		.replace("{{PROJECT_CONTEXT}}", () => projectContext)
		.replace("{{SKILLS}}", () => skillsSection)
	const phaseSection = buildPhaseGuidelinesSection(
		promptCtx?.currentModelId,
		promptCtx?.currentPhase,
		promptCtx?.registry,
	)
	return base + phaseSection
}

function formatToolsSection(tools: readonly ToolInfo[]): string {
	if (tools.length === 0) return "(No tools available)"
	return tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")
}

function formatEnvironmentSection(env: EnvironmentInfo): string {
	const lines = [
		"# Environment",
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

function formatProjectContext(contextFiles?: readonly ContextFile[]): string {
	if (!contextFiles || contextFiles.length === 0) return ""
	const combined = contextFiles.map((f) => f.content).join("\n\n")
	return `# Project Guidelines\n\n${combined}`
}

function formatSkills(skills?: readonly Skill[]): string {
	if (!skills || skills.length === 0) return ""
	// Cast required until upstream accepts readonly Skill[]
	return formatSkillsForPrompt(skills as Skill[])
}

/** Resolve the effective orchestration guideline for a model.
 *  Model override takes precedence; falls back to default. */
export function resolveOrchestrationGuideline(
	modelId: string | undefined,
	registry: ModelRegistry | undefined,
): string {
	const descriptor = modelId ? registry?.getModelById(modelId) : undefined
	return descriptor?.capabilities.orchestrationGuidelines ?? DEFAULT_ORCHESTRATION_GUIDELINES
}

/** Build the orchestration-guidelines annex for appending to an orchestrator
 *  system prompt. Returns empty string if no guidelines resolve. */
export function buildOrchestrationGuidelinesSection(modelId: string | undefined, registry?: ModelRegistry): string {
	const guideline = resolveOrchestrationGuideline(modelId, registry)
	if (!guideline) return ""
	return `\n\n## Orchestration Guidelines\n\n${guideline}`
}

/** Resolve the effective guideline for a model+phase combo.
 *  Model override takes precedence; falls back to default. */
export function resolvePhaseGuideline(
	phase: Phase,
	modelId: string | undefined,
	registry: ModelRegistry | undefined,
): string {
	const descriptor = modelId ? registry?.getModelById(modelId) : undefined
	return descriptor?.capabilities.guidelines?.[phase] ?? DEFAULT_PHASE_GUIDELINES[phase]
}

/** Build the phase-guidelines annex string for appending to a system prompt.
 *  Returns empty string if no phase is active. */
export function buildPhaseGuidelinesSection(
	modelId: string | undefined,
	phase: Phase | undefined,
	registry?: ModelRegistry,
): string {
	if (!phase) return ""
	const guideline = resolvePhaseGuideline(phase, modelId, registry)
	if (!guideline) return ""
	return `\n\n## Phase Guidelines (${phase})\n\n${guideline}`
}

export function isSubagent(): boolean {
	return process.env.KIMCHI_SUBAGENT === "1"
}
