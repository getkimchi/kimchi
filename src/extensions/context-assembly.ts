import { createHash } from "node:crypto"
import type { BeforeAgentStartEvent, BeforeProviderRequestEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Context-assembly accounting extension.
 *
 * Writes `context_assembly` entries into the session JSONL (via pi.appendEntry, same
 * mechanism as trace-id.ts) so benchmark parsers can attribute the token surface of a
 * session without any UI dependency. Instrumentation only — never mutates the event,
 * the system prompt, or the request payload.
 *
 * Entries are buffered when observed and flushed on the next clean assistant
 * `message_end`. Appending a custom entry between a user entry and its assistant
 * response (the before_provider_request junction) shifts upstream compaction's
 * cut-point arithmetic — during 400-overflow recovery that turns a clean turn
 * boundary into a mid-turn split, which issues an extra turn-prefix summarization
 * call. The message_end junction is where cache-summary also appends and where
 * upstream's backward scan never slides the cut onto a custom entry.
 *
 * Two entry shapes, one entry type:
 * - reason "composition": emitted on `before_agent_start` when the assembled system
 *   prompt composition changes. Attribution is component-category based
 *   (contextFile / skill / guideline / toolSnippet / appended / customPrompt /
 *   unattributed), rather than per-extension fold-chain deltas.
 * - reason "prefix-change": emitted on `before_provider_request` when the hash of the
 *   provider-facing prefix material (system prompt + tool definitions) changes. This is
 *   the cache-break signal; per-tool schema sizes ride along.
 *
 * Token counts are an estimator (chars/4) and are named `tokensEstimated` — never mix
 * units into a `tokens` field. Parsers must skip unknown types/schemaVersions.
 */

export const CONTEXT_ASSEMBLY_ENTRY_TYPE = "context_assembly"
export const CONTEXT_ASSEMBLY_SCHEMA_VERSION = 1

/** Estimated tokens per character; field names must say `tokensEstimated`. */
const CHARS_PER_TOKEN = 4

export interface ContextAssemblyComponent {
	kind: "contextFile" | "skill" | "guideline" | "toolSnippet" | "appendedSystemPrompt" | "customPrompt" | "unattributed"
	/** Context-file path, skill name, or tool name when applicable. */
	name?: string
	chars: number
	tokensEstimated: number
}

export interface ContextAssemblyToolSurface {
	name: string
	descriptionChars: number
	schemaChars: number
	tokensEstimated: number
}

export interface ContextAssemblyEntry {
	schemaVersion: number
	reason: "composition" | "prefix-change"
	/** SHA-1 of the system prompt text alone. */
	promptHash: string
	/** SHA-1 of [system prompt, serialized tool definitions]. Present on prefix-change entries. */
	prefixHash?: string
	systemPrompt: { chars: number; tokensEstimated: number }
	components?: ContextAssemblyComponent[]
	tools?: ContextAssemblyToolSurface[]
	toolSurface?: { chars: number; tokensEstimated: number }
}

type SystemPromptOptions = BeforeAgentStartEvent["systemPromptOptions"]

function tokensEstimated(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex")
}

function component(kind: ContextAssemblyComponent["kind"], chars: number, name?: string): ContextAssemblyComponent {
	return { kind, ...(name === undefined ? {} : { name }), chars, tokensEstimated: tokensEstimated(chars) }
}

/** Best-effort attribution of the assembled prompt into component categories. */
export function attributeComponents(systemPrompt: string, options: SystemPromptOptions): ContextAssemblyComponent[] {
	const components: ContextAssemblyComponent[] = []

	if (typeof options.customPrompt === "string" && options.customPrompt.length > 0) {
		components.push(component("customPrompt", options.customPrompt.length))
	}
	if (typeof options.appendSystemPrompt === "string" && options.appendSystemPrompt.length > 0) {
		components.push(component("appendedSystemPrompt", options.appendSystemPrompt.length))
	}
	for (const file of options.contextFiles ?? []) {
		components.push(component("contextFile", file.content.length, file.path))
	}
	for (const skill of options.skills ?? []) {
		// Progressive disclosure: the prompt shows name + description only.
		components.push(component("skill", skill.name.length + skill.description.length, skill.name))
	}
	for (const guideline of options.promptGuidelines ?? []) {
		components.push(component("guideline", guideline.length))
	}
	for (const [toolName, snippet] of Object.entries(options.toolSnippets ?? {})) {
		components.push(component("toolSnippet", snippet.length, toolName))
	}

	const attributed = components.reduce((sum, c) => sum + c.chars, 0)
	const unattributed = Math.max(0, systemPrompt.length - attributed)
	if (unattributed > 0) {
		components.push(component("unattributed", unattributed))
	}
	return components
}

interface ExtractedTool {
	name: string
	description: string
	schema: unknown
}

/**
 * Best-effort extraction of tool definitions and system prompt text from a provider
 * request payload. Handles Anthropic-style { system, tools } and OpenAI-style
 * { messages: [...], tools: [{ function: ... }] }; returns undefined when the shape
 * is unrecognized so callers simply skip that field.
 */
export function extractPayloadSurface(payload: unknown): { systemText: string; tools: ExtractedTool[] } {
	if (typeof payload !== "object" || payload === null) return { systemText: "", tools: [] }
	const record = payload as Record<string, unknown>

	let systemText = ""
	const system = record.system
	if (typeof system === "string") {
		systemText = system
	} else if (Array.isArray(system)) {
		systemText = system
			.map((block) => (block && typeof block === "object" ? String((block as { text?: unknown }).text ?? "") : ""))
			.join("\n")
	} else if (Array.isArray(record.messages)) {
		for (const message of record.messages as Array<Record<string, unknown>>) {
			if (message.role === "system" || message.role === "developer") {
				const content = message.content
				systemText += typeof content === "string" ? content : JSON.stringify(content)
			}
		}
	}

	const tools: ExtractedTool[] = []
	if (Array.isArray(record.tools)) {
		for (const raw of record.tools as Array<Record<string, unknown>>) {
			if (!raw || typeof raw !== "object") continue
			const fn = (raw.function ?? undefined) as Record<string, unknown> | undefined
			const name = String(raw.name ?? fn?.name ?? "")
			if (!name) continue
			const description = String(raw.description ?? fn?.description ?? "")
			const schema = raw.input_schema ?? raw.parameters ?? fn?.parameters
			tools.push({ name, description, schema })
		}
	}

	return { systemText, tools }
}

export default function contextAssemblyExtension(pi: ExtensionAPI): void {
	let lastCompositionHash: string | undefined
	let lastPrefixHash: string | undefined
	const pendingFlush: ContextAssemblyEntry[] = []

	pi.on("before_agent_start", (event) => {
		const promptHash = sha1(event.systemPrompt)
		const components = attributeComponents(event.systemPrompt, event.systemPromptOptions)
		// Dedup on prompt content AND components: same-length prompts with identical
		// attribution (e.g. unchanged component categories but edited prompt text) must
		// still emit, while identical re-assembly (e.g. tool-set rebuild returning to the
		// prior state) must not grow the journal.
		const compositionHash = sha1(JSON.stringify([promptHash, components]))
		if (compositionHash === lastCompositionHash) return
		lastCompositionHash = compositionHash

		const entry: ContextAssemblyEntry = {
			schemaVersion: CONTEXT_ASSEMBLY_SCHEMA_VERSION,
			reason: "composition",
			promptHash,
			systemPrompt: { chars: event.systemPrompt.length, tokensEstimated: tokensEstimated(event.systemPrompt.length) },
			components,
		}
		pendingFlush.push(entry)
		return undefined
	})

	pi.on("before_provider_request", (event: BeforeProviderRequestEvent) => {
		const { systemText, tools } = extractPayloadSurface(event.payload)
		// Toolless requests are non-agentic side-calls (compaction/branch summaries pass
		// no tool definitions). They are not the session's provider-facing prefix, and
		// recording them would append entries right at compaction boundaries — exactly
		// where upstream's recovery cut is most position-sensitive.
		if (tools.length === 0) return
		const toolsJson = JSON.stringify(tools.map((t) => [t.name, t.description, t.schema]))
		const prefixHash = sha1(JSON.stringify([systemText, toolsJson]))
		if (prefixHash === lastPrefixHash) return
		lastPrefixHash = prefixHash

		const toolSurfaces: ContextAssemblyToolSurface[] = tools.map((t) => {
			const descriptionChars = t.description.length
			const schemaChars = t.schema === undefined ? 0 : JSON.stringify(t.schema).length
			return {
				name: t.name,
				descriptionChars,
				schemaChars,
				tokensEstimated: tokensEstimated(descriptionChars + schemaChars),
			}
		})
		const toolSurfaceChars = toolSurfaces.reduce((sum, t) => sum + t.descriptionChars + t.schemaChars, 0)

		// The system text attached to the payload should match the assembled system
		// prompt; when the shapes don't line up (unknown provider format) systemText may
		// be empty — still record tools + hash so the change signal survives.
		const entry: ContextAssemblyEntry = {
			schemaVersion: CONTEXT_ASSEMBLY_SCHEMA_VERSION,
			reason: "prefix-change",
			promptHash: sha1(systemText),
			prefixHash,
			systemPrompt: { chars: systemText.length, tokensEstimated: tokensEstimated(systemText.length) },
			tools: toolSurfaces,
			toolSurface: { chars: toolSurfaceChars, tokensEstimated: tokensEstimated(toolSurfaceChars) },
		}
		pendingFlush.push(entry)
		return undefined
	})

	pi.on("message_end", (event) => {
		// Flush only after a cleanly completed assistant message. An errored assistant
		// message is where the 400-overflow recovery starts; appending there puts a
		// custom entry adjacent to the compaction boundary, which is the poisonous
		// position this buffering exists to avoid.
		if (event.message.role !== "assistant") return
		if (event.message.stopReason === "error") return
		if (pendingFlush.length === 0) return
		for (const entry of pendingFlush) {
			pi.appendEntry(CONTEXT_ASSEMBLY_ENTRY_TYPE, entry)
		}
		pendingFlush.length = 0
	})
}
