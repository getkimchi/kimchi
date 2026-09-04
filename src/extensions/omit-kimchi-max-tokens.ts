import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

type ModelRef = Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider">

function shouldOmitMaxTokens(model: ModelRef): boolean {
	return model.provider === "kimchi-dev" && model.id === "kimi-k3"
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function omitKimchiMaxTokensFromPayload(payload: unknown, model: ModelRef): unknown {
	if (!shouldOmitMaxTokens(model) || !isRecord(payload)) return payload
	if (!("max_completion_tokens" in payload) && !("max_tokens" in payload)) return payload

	const { max_completion_tokens: _maxCompletionTokens, max_tokens: _maxTokens, ...rest } = payload
	return rest
}

export function omitKimchiMaxTokens(event: BeforeProviderRequestEvent, ctx: { model?: ModelRef }): unknown {
	if (!ctx.model) return
	const payload = omitKimchiMaxTokensFromPayload(event.payload, ctx.model)
	return payload === event.payload ? undefined : payload
}

export default function omitKimchiMaxTokensExtension(pi: ExtensionAPI) {
	pi.on("before_provider_request", omitKimchiMaxTokens)
}
