import { buildPlannerSupplement } from "./planner-supplement.js"
import type { FermentRuntime } from "./runtime.js"
import { PLANNER_ONESHOT_ALLOWLIST } from "./tool-scope.js"

/**
 * Extract the `# Environment` block from the orchestrator base system prompt.
 *
 * The base prompt (`system-prompt.ts`) includes a `# Environment`
 * heading followed by an OS/cwd/git block. The block ends before the next
 * top-level `## ` section. Returns empty string when no block is found so
 * the planner still gets a usable (if env-less) prompt.
 */
export function extractEnvironmentBlock(systemPrompt: string): string {
	const match = systemPrompt.match(/(^|\n)# Environment\n[\s\S]*?(?=\n\n## |\n\n# |$)/)
	return match ? match[0].replace(/^\n/, "") : ""
}

/**
 * Build the system prompt for the planner process in `ferment-oneshot` mode.
 *
 * Replaces the full orchestrator base prompt (which mixes "do it yourself"
 * framing with "delegate when appropriate") with a strict planner-only frame.
 * Subagent workers still get the full orchestrator prompt because they run in
 * separate processes with `KIMCHI_SUBAGENT=1` and their own session_start.
 *
 * The tool list enumerates only the tools that are actually wired up for the
 * planner. We deliberately do NOT enumerate forbidden tools to avoid priming
 * the model to hallucinate them.
 */
export function buildOneshotPlannerSystemPrompt(baseSystemPrompt: string, runtime: FermentRuntime): string {
	const envBlock = extractEnvironmentBlock(baseSystemPrompt)
	const envSection = envBlock ? `${envBlock}\n\n` : ""
	const allowlist = [...PLANNER_ONESHOT_ALLOWLIST].sort()
	const allowlistList = allowlist.map((n) => `- \`${n}\``).join("\n")
	const supplement = buildPlannerSupplement(runtime).trimStart()

	return `You are the PLANNER for a ferment-oneshot task. You orchestrate; Agent workers execute. You do not implement anything yourself.

${envSection}## Available tools

These are the only tools available to you:

${allowlistList}

If you need bash, edit, write, grep, web_search, or any implementation tool, that means you need to launch an \`Agent\` worker — those tools exist only inside Agent subagents, never in the planner.

${supplement}`
}

type AnthropicTextBlock = { type: "text"; text: string; [k: string]: unknown }
type OpenAIMessage = { role?: unknown; content?: unknown; [k: string]: unknown }

// pi-ai's openai-completions provider emits the system prompt as `messages[0]`
// with role `"system"` for non-reasoning models, or `"developer"` when the
// model is reasoning and the provider supports the developer role (see
// `pi-ai/dist/providers/openai-completions.js`: `useDeveloperRole = model.reasoning
// && compat.supportsDeveloperRole`). kimchi-dev's gateway (`llm.kimchi.dev`)
// is treated as standard, so reasoning models like `kimi-k2.6` are emitted
// with `role: "developer"`. Match both.
const OPENAI_SYSTEM_ROLES = new Set(["system", "developer"])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function isAnthropicTextBlock(value: unknown): value is AnthropicTextBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string"
}

function isOpenAISystemMessage(value: unknown): value is OpenAIMessage & { role: string; content: string } {
	return (
		isRecord(value) &&
		typeof value.role === "string" &&
		OPENAI_SYSTEM_ROLES.has(value.role) &&
		typeof value.content === "string"
	)
}

/**
 * Inspect a provider request payload and return the base system prompt text.
 *
 * Recognized shapes:
 * - Anthropic/pi-ai: `payload.system` is a string OR an array of content
 *   blocks; we return the first text block's `text`.
 * - OpenAI-compatible: `payload.messages[0]` has `role: "system"` (or
 *   `"developer"` for reasoning models) with a string `content`.
 *
 * Returns `undefined` for any unrecognized shape so the caller can no-op.
 */
export function extractBaseSystemPromptFromPayload(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined

	const system = payload.system
	if (typeof system === "string") return system
	if (Array.isArray(system)) {
		const firstText = system.find(isAnthropicTextBlock)
		if (firstText) return firstText.text
	}

	const messages = payload.messages
	if (Array.isArray(messages) && messages.length > 0 && isOpenAISystemMessage(messages[0])) {
		return messages[0].content
	}

	return undefined
}

/**
 * Rewrite the system prompt inside a provider request payload in place.
 *
 * Mirrors the shapes handled by `extractBaseSystemPromptFromPayload`.
 * Mutates the payload to match the local `tags.ts` convention so we do not
 * drop fields injected by other `before_provider_request` hooks. Returns the
 * mutated payload on success, `undefined` if the shape was unrecognized.
 *
 * For Anthropic array-form `system`: replace the first text block with the
 * new prompt (preserving its non-text fields such as `cache_control`) and
 * drop all subsequent text blocks. Non-text blocks are kept as-is. This
 * prevents leftover text blocks from leaking the original orchestrator
 * prompt's "do it yourself" framing.
 */
export function rewriteSystemPromptInPayload(payload: unknown, newPrompt: string): unknown | undefined {
	if (!isRecord(payload)) return undefined

	const system = payload.system
	if (typeof system === "string") {
		payload.system = newPrompt
		return payload
	}
	if (Array.isArray(system)) {
		const firstIdx = system.findIndex(isAnthropicTextBlock)
		if (firstIdx >= 0) {
			const firstBlock = system[firstIdx] as AnthropicTextBlock
			const rewritten = system.filter((block, idx) => idx === firstIdx || !isAnthropicTextBlock(block))
			const replaceIdx = rewritten.indexOf(firstBlock)
			rewritten[replaceIdx] = { ...firstBlock, text: newPrompt }
			payload.system = rewritten
			return payload
		}
	}

	const messages = payload.messages
	if (Array.isArray(messages) && messages.length > 0 && isOpenAISystemMessage(messages[0])) {
		;(messages[0] as OpenAIMessage).content = newPrompt
		return payload
	}

	return undefined
}
