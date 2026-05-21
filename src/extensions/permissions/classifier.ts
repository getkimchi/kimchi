import { complete } from "@earendil-works/pi-ai"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import classifierSystemPrompt from "./prompts/classifier-system-prompt.js"
import type { ClassifierResult, ClassifierVerdict } from "./types.js"

/** Tag added to every classifier LLM request for cost tracking. */
export const CLASSIFIER_REQUEST_TAG = "source:classifier"

export interface ClassifyInput {
	toolName: string
	input: Record<string, unknown>
	cwd: string
}

export interface ClassifierOptions {
	timeoutMs: number
}

export async function classifyToolCall(
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	call: ClassifyInput,
	options: ClassifierOptions,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model)
	if (!auth.ok || !auth.apiKey) return unavailable("no API key for classifier")

	if (signal?.aborted) return unavailable("classifier aborted")

	const controller = new AbortController()
	const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs)
	const onOuterAbort = () => controller.abort()
	signal?.addEventListener("abort", onOuterAbort)

	try {
		const response = await complete(
			model,
			{
				systemPrompt: classifierSystemPrompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildUserPrompt(call) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: controller.signal,
				onPayload: (payload: unknown) => {
					if (payload && typeof payload === "object") {
						const p = payload as Record<string, unknown>
						const existing = Array.isArray(p.tags) ? (p.tags as string[]) : []
						p.tags = [CLASSIFIER_REQUEST_TAG, ...existing]
					}
					return payload
				},
			},
		)

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")

		const result = parseClassifierOutput(text)

		if (!result.ok) {
			const diag = [
				`model=${model.id}`,
				`stopReason=${response.stopReason}`,
				`text=${truncate(text, 200) || "(empty)"}`,
			].join(" ")
			return unavailable(`${result.reason} (${diag})`)
		}

		return result
	} catch (err) {
		const aborted = (err as Error)?.name === "AbortError" || controller.signal.aborted
		const reason = aborted ? "classifier timeout" : `classifier error: ${(err as Error).message}`
		return unavailable(`${reason} (model=${model.id} tool=${call.toolName})`)
	} finally {
		clearTimeout(timeoutHandle)
		signal?.removeEventListener("abort", onOuterAbort)
	}
}

function buildUserPrompt(call: ClassifyInput): string {
	const inputStr = truncate(safeStringify(call.input), 2048)
	return [`Tool: ${call.toolName}`, `Working directory: ${call.cwd}`, "Arguments:", inputStr].join("\n")
}

export function parseClassifierOutput(raw: string): ClassifierResult {
	const json = extractJsonObject(raw)
	if (!json) return unavailable("classifier returned unparseable output")

	const verdict = normalizeVerdict(json.verdict)
	if (!verdict) return unavailable("classifier returned unknown verdict")

	const reason = typeof json.reason === "string" && json.reason.trim() ? json.reason.trim() : "no reason provided"
	return { verdict, reason, ok: true }
}

function unavailable(reason: string): ClassifierResult {
	return { verdict: "requires-confirmation", reason, ok: false }
}

function normalizeVerdict(v: unknown): ClassifierVerdict | undefined {
	if (v === "safe" || v === "requires-confirmation" || v === "blocked") return v
	return undefined
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
	const trimmed = raw.trim()
	const start = trimmed.indexOf("{")
	const end = trimmed.lastIndexOf("}")
	if (start < 0 || end <= start) return null
	try {
		const parsed = JSON.parse(trimmed.slice(start, end + 1))
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
	} catch {
		return null
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max - 1)}…`
}
