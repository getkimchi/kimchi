import { randomUUID } from "node:crypto"
import type { Api, AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai"
import type { ChangeSet } from "../../agent-patch/index.js"
import { type CouncilCacheKey, hashCouncilCacheValue } from "./cache.js"
import { type CompiledCouncilContext, councilConstraints } from "./context-compiler.js"
import { ZERO_USAGE } from "./telemetry.js"
import type { CouncilStage } from "./types.js"

const STRUCTURED_STAGE_MAX_TOKENS: Record<Exclude<CouncilStage, "lead">, number> = {
	solver: 6_000,
	analyst: 8_000,
	synthesis: 8_000,
	combined: 12_000,
	repair: 8_000,
}

export function structuredStageMaxTokens(stage: Exclude<CouncilStage, "lead">, configuredMaximum: number): number {
	return Math.min(configuredMaximum, STRUCTURED_STAGE_MAX_TOKENS[stage])
}

export function textFromAssistant(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("")
}

function withoutEphemeralRunId(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutEphemeralRunId)
	if (!value || typeof value !== "object") return value
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "run_id")
			.map(([key, item]) => [key, withoutEphemeralRunId(item)]),
	)
}

export function councilCacheKey({
	context,
	candidate,
	draft,
	packet,
	role,
	modelId,
	prompt,
	schema,
}: {
	context: CompiledCouncilContext
	candidate?: ChangeSet
	draft: string
	packet: unknown
	role: string
	modelId: string
	prompt: string
	schema: string
}): CouncilCacheKey {
	const baseIdentity = candidate
		? [...candidate.base]
				.sort((left, right) => left.path.localeCompare(right.path))
				.map(({ path, exists, sha256, mode }) => ({ path, exists, sha256, mode }))
		: context.artifacts.filter(({ kind }) => kind !== "assistant_text" && kind !== "candidate_patch")
	return {
		patchHash: candidate?.patchSha256 ?? hashCouncilCacheValue(draft),
		baseSnapshotHash: hashCouncilCacheValue(baseIdentity),
		objectiveHash: hashCouncilCacheValue(context.objective.text),
		constraintsHash: hashCouncilCacheValue(councilConstraints(context)),
		evidenceHash: hashCouncilCacheValue(withoutEphemeralRunId(packet)),
		role,
		modelId,
		promptVersion: hashCouncilCacheValue(prompt),
		schemaVersion: hashCouncilCacheValue(schema),
	}
}

/** Binds a run's context/candidate/draft once, returning a factory for per-stage cache-key builders. */
export function cacheKeyForContext(
	context: CompiledCouncilContext,
	candidate: ChangeSet | undefined,
	draft: string,
): (role: string, packet: unknown, prompt: string, schema: string) => (modelId: string) => CouncilCacheKey {
	return (role, packet, prompt, schema) => (modelId) =>
		councilCacheKey({ context, candidate, draft, packet, role, modelId, prompt, schema })
}

export function internalToolUse(
	virtualModel: Model<Api>,
	usage: AssistantMessage["usage"],
	name: string,
	arguments_: Record<string, unknown>,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `council_tool_${randomUUID()}`, name, arguments: arguments_ }],
		api: virtualModel.api,
		provider: virtualModel.provider,
		model: virtualModel.id,
		usage: structuredClone(usage),
		stopReason: "toolUse",
		timestamp: Date.now(),
	}
}

export function assistantTextMessage(virtualModel: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: virtualModel.api,
		provider: virtualModel.provider,
		model: virtualModel.id,
		usage: structuredClone(ZERO_USAGE),
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

export function boundedStructuredText(message: AssistantMessage, maxBytes: number): string {
	if (message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) {
		throw new Error("Council stage returned non-final structured output")
	}
	const text = textFromAssistant(message)
	if (!text.trim()) throw new Error("Council stage returned no structured output")
	if (Buffer.byteLength(text) > maxBytes) throw new Error("Council structured output exceeds its byte limit")
	return text
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error(`${label} aborted`))
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error(`${label} aborted`))
		signal.addEventListener("abort", onAbort, { once: true })
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
	})
}

export function councilPreset(modelId: string): "fast" | "normal" | "deep" {
	if (modelId === "council-fast") return "fast"
	if (modelId === "council-deep") return "deep"
	return "normal"
}
